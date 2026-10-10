import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  COOKIE, DEFAULT_PIN, MAX_ATTEMPTS, cookieHeader, cookieToken, createConnectionPin,
} from '../src/connection-pin.js';

/*
 * An optional gate for the case where the LAN is not somewhere you trust. The things worth guarding
 * are that it is OFF until asked for, that it cannot be brute-forced through four digits, and that
 * turning it on does not lock out the person turning it on.
 */

function harness() {
  const dataDir = mkdtempSync(join(tmpdir(), 'pin-'));
  let clock = 1_700_000_000_000;
  const pin = createConnectionPin({ dataDir, now: () => clock, log: () => {} });
  return {
    pin,
    dataDir,
    tick: (ms) => { clock += ms; },
    /** A request from one address, optionally carrying a session token. */
    req: (token, address = '192.168.1.50') => ({
      method: 'GET',
      socket: { remoteAddress: address },
      headers: token ? { cookie: `${COOKIE}=${token}` } : {},
    }),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test('it is off by default, so an existing box is unaffected', () => {
  const h = harness();
  try {
    assert.equal(h.pin.enabled(), false);
    assert.equal(h.pin.status(h.req()).required, false);
    /* The important one: nothing is blocked until somebody asks for it. An update that silently
     * started demanding a PIN would lock two unreachable boxes out of their own decks. */
    assert.equal(h.pin.blocked(h.req(), '/library'), false);
    assert.equal(h.pin.blocked(h.req(), '/decks/1/play'), false);
  } finally { h.cleanup(); }
});

test('the default PIN is 0000 and it works once enabled', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true });
    assert.equal(h.pin.enabled(), true);

    const result = h.pin.unlock(h.req(), DEFAULT_PIN);
    assert.equal(result.ok, true);
    assert.ok(result.token);
  } finally { h.cleanup(); }
});

test('enabling it hands back a session, so you do not lock yourself out', () => {
  const h = harness();
  try {
    /* Discovering a new feature by immediately losing access to your own decks would be a poor
     * introduction to it. */
    const result = h.pin.configure({ enabled: true });
    assert.equal(result.ok, true);
    assert.ok(result.token, 'a token comes back with the switch-on');
    assert.equal(h.pin.unlocked(h.req(result.token)), true);
  } finally { h.cleanup(); }
});

test('once enabled, actions are blocked without a session', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true });
    assert.equal(h.pin.blocked(h.req(), '/library'), true);
    assert.equal(h.pin.blocked({ ...h.req(), method: 'POST' }, '/decks/1/play'), true);
  } finally { h.cleanup(); }
});

test('but the app shell is never blocked, or the PIN could not be typed', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true });
    /* The lock screen IS the app bundle. Gating it would serve a blank page with nowhere to enter a
     * PIN - locked out by the very thing meant to let you in. */
    assert.equal(h.pin.blocked(h.req(), '/'), false);
    assert.equal(h.pin.blocked(h.req(), '/index.html'), false);
    assert.equal(h.pin.blocked(h.req(), '/assets/index.js'), false);
    assert.equal(h.pin.blocked(h.req(), '/assets/index.css'), false);
    assert.equal(h.pin.blocked(h.req(), '/pin'), false, 'and the status it asks for');
    assert.equal(h.pin.blocked(h.req(), '/pin/unlock'), false, 'and the way in');
  } finally { h.cleanup(); }
});

test('a wrong PIN is refused and throttled before 10,000 guesses are possible', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true, pin: '1234' });

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      assert.equal(h.pin.unlock(h.req(), '9999').reason, 'wrong-pin', `attempt ${i + 1}`);
    }

    /* Four digits is ten thousand combinations - seconds of scripting on a LAN. Without this the PIN
     * is decoration rather than a gate. */
    const throttled = h.pin.unlock(h.req(), '9999');
    assert.equal(throttled.ok, false);
    assert.equal(throttled.reason, 'too-many-attempts');
    assert.ok(throttled.retryInMs > 0);

    // Even the RIGHT pin waits, or the lockout could be probed around.
    assert.equal(h.pin.unlock(h.req(), '1234').reason, 'too-many-attempts');

    h.tick(60_000);
    assert.equal(h.pin.unlock(h.req(), '1234').ok, true, 'and it clears after the wait');
  } finally { h.cleanup(); }
});

test('the throttle is per client, so one guesser cannot lock out the owner', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true, pin: '1234' });
    for (let i = 0; i < MAX_ATTEMPTS + 1; i += 1) h.pin.unlock(h.req(null, '192.168.1.99'), '0000');

    assert.ok(h.pin.unlock(h.req(null, '192.168.1.99'), '1234').reason === 'too-many-attempts');
    assert.equal(h.pin.unlock(h.req(null, '192.168.1.50'), '1234').ok, true, 'the owner still gets in');
  } finally { h.cleanup(); }
});

test('changing the PIN invalidates existing sessions', () => {
  const h = harness();
  try {
    const { token } = h.pin.configure({ enabled: true });
    assert.equal(h.pin.unlocked(h.req(token)), true);

    /* Usually the reason for changing it is that whoever had the old one should no longer be in. */
    h.pin.configure({ pin: '4321' });
    assert.equal(h.pin.unlocked(h.req(token)), false);
  } finally { h.cleanup(); }
});

test('disabling it lets everyone back in and drops the sessions', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true });
    h.pin.configure({ enabled: false });
    assert.equal(h.pin.enabled(), false);
    assert.equal(h.pin.blocked(h.req(), '/library'), false);
  } finally { h.cleanup(); }
});

test('a PIN must be four digits', () => {
  const h = harness();
  try {
    for (const bad of ['123', '12345', 'abcd', '', '12 4', '12.4']) {
      assert.equal(h.pin.configure({ pin: bad }).ok, false, `${JSON.stringify(bad)} is refused`);
    }
    assert.equal(h.pin.configure({ pin: '0000' }).ok, true);
  } finally { h.cleanup(); }
});

test('the PIN is never stored in plaintext, because bundles leave the box', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true, pin: '8271' });
    const raw = readFileSync(join(h.dataDir, 'connection-pin.json'), 'utf8');

    /* Diagnostics get sent off the box to be read. A plaintext PIN in data/ would eventually travel
     * with one. */
    assert.ok(!raw.includes('8271'), 'the PIN itself must not appear');
    assert.ok(raw.includes('hash') && raw.includes('salt'));
  } finally { h.cleanup(); }
});

test('a session expires rather than lasting forever', () => {
  const h = harness();
  try {
    const { token } = h.pin.configure({ enabled: true });
    h.tick(29 * 24 * 60 * 60 * 1000);
    assert.equal(h.pin.unlocked(h.req(token)), true);
    h.tick(2 * 24 * 60 * 60 * 1000);
    assert.equal(h.pin.unlocked(h.req(token)), false, 'a borrowed phone does not keep access forever');
  } finally { h.cleanup(); }
});

test('an unknown or absent token is not a session', () => {
  const h = harness();
  try {
    h.pin.configure({ enabled: true });
    assert.equal(h.pin.unlocked(h.req('not-a-real-token')), false);
    assert.equal(h.pin.unlocked(h.req()), false);
  } finally { h.cleanup(); }
});

test('the cookie is what media requests can carry', () => {
  /* An <audio> or <img> tag cannot attach an Authorization header, and the box serves audio and
   * waveforms to both. A bearer token would have left exactly those requests ungated. */
  const header = cookieHeader('abc123', 60_000, true);
  assert.ok(header.includes(`${COOKIE}=abc123`));
  assert.ok(header.includes('HttpOnly'));
  assert.ok(header.includes('SameSite=Lax'));
  assert.ok(header.includes('Secure'), 'over https');
  assert.ok(header.includes('Max-Age=60'));

  // Not Secure on plain http, or a box that has no certificate yet could never hold a session.
  assert.ok(!cookieHeader('abc123', 60_000, false).includes('Secure'));
});

test('the token is read back out of a cookie header among others', () => {
  assert.equal(cookieToken({ headers: { cookie: `a=1; ${COOKIE}=tok; b=2` } }), 'tok');
  assert.equal(cookieToken({ headers: { cookie: 'a=1' } }), null);
  assert.equal(cookieToken({ headers: {} }), null);
  assert.equal(cookieToken({}), null);
});

/*
 * Remembering a device that has already been let in.
 *
 * A MAC address would be the intuitive key and cannot be one: a browser request does not carry it, iOS
 * and Android randomise it per network so it is not even stable, and DHCP moves the IP. What the box can
 * rely on is something the browser itself keeps.
 */

test('a device stays remembered across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const clock = 1_700_000_000_000;
    const first = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const { token } = first.configure({ enabled: true });

    /* The server restarts on every update, and updates are now something the owner does from a banner
     * whenever one appears. Asking every device again each time would feel broken, not secure. */
    const second = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const req = { method: 'GET', socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: `${COOKIE}=${token}` } };
    assert.equal(second.unlocked(req), true, 'a new process honours the session');
    assert.equal(second.blocked(req, '/library'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a device that was never let in is still asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const pin = createConnectionPin({ dataDir: dir, log: () => {} });
    pin.configure({ enabled: true });

    const stranger = { method: 'GET', socket: { remoteAddress: '192.168.1.77' }, headers: {} };
    assert.equal(pin.unlocked(stranger), false);
    assert.equal(pin.status(stranger).required, true, 'which is what puts the PIN screen up');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('changing the PIN forgets every device, even across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const clock = 1_700_000_000_000;
    const first = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const { token } = first.configure({ enabled: true });

    first.configure({ pin: '4321' });

    /* The reason for changing a PIN is usually that somebody who knew the old one should be out. A
     * remembered device surviving that would defeat the point - including after a reboot. */
    const second = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const req = { method: 'GET', socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: `${COOKIE}=${token}` } };
    assert.equal(second.unlocked(req), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the remembered sessions file holds no usable token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const pin = createConnectionPin({ dataDir: dir, log: () => {} });
    const { token } = pin.configure({ enabled: true });

    /* Same reasoning as the PIN: anything in data/ can end up in a diagnostics bundle, and this file is
     * a list of credentials. Stored hashed, so what is written cannot be replayed. */
    const raw = readFileSync(join(dir, 'connection-pin-sessions.json'), 'utf8');
    assert.ok(!raw.includes(token), 'the token itself must not be on disk');
    assert.ok(raw.includes('hash') && raw.includes('expires'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an expired session is not loaded back in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    let clock = 1_700_000_000_000;
    const first = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const { token } = first.configure({ enabled: true });

    clock += 31 * 24 * 60 * 60 * 1000;
    const second = createConnectionPin({ dataDir: dir, now: () => clock, log: () => {} });
    const req = { method: 'GET', socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: `${COOKIE}=${token}` } };
    assert.equal(second.unlocked(req), false, 'a month-old session is gone, not merely unchecked');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt sessions file asks everyone once more rather than letting anyone in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pin-'));
  try {
    const first = createConnectionPin({ dataDir: dir, log: () => {} });
    first.configure({ enabled: true });
    writeFileSync(join(dir, 'connection-pin-sessions.json'), 'not json');

    const second = createConnectionPin({ dataDir: dir, log: () => {} });
    const req = { method: 'GET', socket: { remoteAddress: '192.168.1.50' }, headers: { cookie: `${COOKIE}=anything` } };
    // Failing towards asking is the right direction.
    assert.equal(second.unlocked(req), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
