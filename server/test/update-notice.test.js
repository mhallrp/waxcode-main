import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createUpdateNotice, SNOOZE_MS } from '../src/update-notice.js';

const HOUR = 60 * 60 * 1000;

function harness({ offered = { ok: true, newer: true, latest: 'v0.10.11', running: 'v0.10.10' } } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'notice-'));
  let clock = 1_700_000_000_000;
  let current = offered;

  const notice = createUpdateNotice({
    dataDir,
    now: () => clock,
    log: () => {},
    selfUpdate: { check: async () => current },
  });

  return {
    notice,
    dataDir,
    tick: (ms) => { clock += ms; },
    offer: (next) => { current = next; },
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('nothing is claimed before the first check has happened', () => {
  const h = harness();
  try {
    /* A banner that appears on a guess is worse than one that appears a second late - `checked` lets
     * the UI stay silent rather than assert something it does not know. */
    const n = h.notice.notice();
    assert.equal(n.waiting, false);
    assert.equal(n.checked, false);
  } finally { h.cleanup(); }
});

test('a newer version is reported as waiting', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    const n = h.notice.notice();
    assert.equal(n.waiting, true);
    assert.equal(n.version, 'v0.10.11');
    assert.equal(n.running, 'v0.10.10');
  } finally { h.cleanup(); }
});

test('an up-to-date box is not nagged', async () => {
  const h = harness({ offered: { ok: true, newer: false, running: 'v0.10.11' } });
  try {
    await h.notice.refresh();
    assert.equal(h.notice.notice().waiting, false);
  } finally { h.cleanup(); }
});

test('dismissing hides it, and it comes back after the snooze', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    const result = h.notice.dismiss('v0.10.11');
    assert.equal(result.ok, true);

    assert.equal(h.notice.notice().waiting, false, 'hidden straight away');
    assert.equal(h.notice.notice().dismissed, true);

    h.tick(47 * HOUR);
    assert.equal(h.notice.notice().waiting, false, 'still quiet an hour before the snooze is up');

    h.tick(2 * HOUR);
    assert.equal(h.notice.notice().waiting, true, 'and speaks up again afterwards');
  } finally { h.cleanup(); }
});

test('dismissing one version does NOT hide a newer one', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    h.notice.dismiss('v0.10.11');
    assert.equal(h.notice.notice().waiting, false);

    /* The failure this prevents: waving away one release and then not being told about the next for
     * two days. The whole job of this thing is carrying news. */
    h.tick(1 * HOUR);
    h.offer({ ok: true, newer: true, latest: 'v0.11.0', running: 'v0.10.10' });
    await h.notice.refresh();

    const n = h.notice.notice();
    assert.equal(n.waiting, true, 'a newer release speaks up immediately');
    assert.equal(n.version, 'v0.11.0');
  } finally { h.cleanup(); }
});

test('dismissing a newer version also covers an older one still being offered', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    // Somebody dismissed v0.11.0 earlier; a feed briefly offering v0.10.11 should stay quiet.
    h.notice.dismiss('v0.11.0');
    h.offer({ ok: true, newer: true, latest: 'v0.10.11', running: 'v0.10.10' });
    await h.notice.refresh();
    assert.equal(h.notice.notice().waiting, false);
  } finally { h.cleanup(); }
});

test('the dismissal survives a restart, because it is on the box not in a browser', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    h.notice.dismiss('v0.10.11');

    /* Stored on the box deliberately: one owner, two devices. Dismissing on a phone must not leave
     * the laptop still nagging. */
    const stored = JSON.parse(readFileSync(join(h.dataDir, 'update-dismissed.json'), 'utf8'));
    assert.equal(stored.version, 'v0.10.11');
    assert.equal(typeof stored.at, 'number');

    const second = createUpdateNotice({
      dataDir: h.dataDir,
      now: () => 1_700_000_000_000 + HOUR,
      log: () => {},
      selfUpdate: { check: async () => ({ ok: true, newer: true, latest: 'v0.10.11', running: 'v0.10.10' }) },
    });
    await second.refresh();
    assert.equal(second.notice().waiting, false, 'a fresh server still honours it');
  } finally { h.cleanup(); }
});

test('a corrupt dismissal file shows the banner rather than hiding an update', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    writeFileSync(join(h.dataDir, 'update-dismissed.json'), 'not json at all');
    // Erring toward one extra banner, never toward silently withholding an update.
    assert.equal(h.notice.notice().waiting, true);
  } finally { h.cleanup(); }
});

test('a failed check leaves a correct banner alone rather than making it vanish', async () => {
  const h = harness();
  try {
    await h.notice.refresh();
    assert.equal(h.notice.notice().waiting, true);

    h.offer(null);
    const broken = createUpdateNotice({
      dataDir: h.dataDir,
      log: () => {},
      selfUpdate: { check: async () => { throw new Error('ENOTFOUND'); } },
    });
    await broken.refresh();
    // Nothing was ever known here, so nothing is claimed - and it does not throw.
    assert.equal(broken.notice().checked, false);
  } finally { h.cleanup(); }
});

test('dismissing without a version is refused rather than written', () => {
  const h = harness();
  try {
    assert.equal(h.notice.dismiss(undefined).ok, false);
    assert.equal(h.notice.dismiss('').ok, false);
    assert.equal(SNOOZE_MS, 48 * HOUR, 'the snooze is the 48 hours asked for');
  } finally { h.cleanup(); }
});

/*
 * A release published after the last background check went unseen for most of a day: the owner opened
 * the app repeatedly ten minutes after v0.10.16 shipped and got nothing, because his box had last
 * looked at 02:14 and the interval was six hours.
 *
 * Opening the app is the signal that a person is there, so asking is now itself a reason to look.
 */

test('asking with a stale answer kicks off a fresh check', async () => {
  const h = harness({ offered: { ok: true, newer: false, running: 'v0.10.15' } });
  try {
    await h.notice.refresh();
    assert.equal(h.notice.notice().waiting, false);

    /* A release lands, and the background timer is hours away. */
    h.offer({ ok: true, newer: true, latest: 'v0.10.16', running: 'v0.10.15' });
    h.tick(11 * 60 * 1000);

    /* Asking returns the CACHED answer immediately - a page load must not wait on the network - but
     * triggers the refresh behind it. */
    h.notice.notice();
    await new Promise((resolve) => setImmediate(resolve));

    const after = h.notice.notice();
    assert.equal(after.waiting, true, 'the next poll sees it, about a minute later');
    assert.equal(after.version, 'v0.10.16');
  } finally { h.cleanup(); }
});

test('a fresh answer is not re-checked on every single request', async () => {
  const h = harness();
  try {
    let checks = 0;
    const counting = createUpdateNotice({
      dataDir: h.dataDir,
      log: () => {},
      selfUpdate: { check: async () => { checks += 1; return { ok: true, newer: false, running: 'v1' }; } },
    });
    await counting.refresh();
    const after = checks;

    /* The banner polls every 60s and two devices may be open. Re-checking the feed on each of those
     * would be rude to waxcode.co and pointless. */
    for (let i = 0; i < 10; i += 1) counting.notice();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(checks, after, 'nothing re-checked while the answer is fresh');
  } finally { h.cleanup(); }
});
