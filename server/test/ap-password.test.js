import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApPassword } from '../src/ap-password.js';

const fresh = () => createApPassword({ dataDir: mkdtempSync(join(tmpdir(), 'pidvs-ap-')) });

/*
 * The whole reason this module exists. `nmcli device wifi hotspot` invents a random WPA2 password when
 * it is not given one, and the first ap-up on real hardware did exactly that: a network appeared that
 * nobody could join, because the only copy of the password was inside a profile on a box that had just
 * left the network you would read it over.
 *
 * null means OPEN, which is how a fresh box is reachable by someone holding nothing. The portal is
 * what makes that temporary - it will not let anyone past until a password is set.
 */
test('a fresh box has no password, so its setup network is open', () => {
  const ap = fresh();
  assert.equal(ap.get(), null);
  assert.equal(ap.isOpen(), true);
});

test('a stored password is used, and the network is no longer open', () => {
  const ap = fresh();
  assert.deepEqual(ap.set('mybooth2026'), { ok: true });
  assert.equal(ap.get(), 'mybooth2026');
  assert.equal(ap.isOpen(), false);
});

test('too short is refused with a named reason, before it ever reaches the radio', () => {
  assert.deepEqual(fresh().set('short'), { ok: false, reason: 'too-short', field: 'apPassword' });
});

test('over WPA2\'s 63-character ceiling is refused', () => {
  assert.equal(fresh().set('x'.repeat(64)).reason, 'too-long');
});

test('empty is refused rather than silently making an open network', () => {
  assert.equal(fresh().set('').reason, 'no-password');
  assert.equal(fresh().set(null).reason, 'no-password');
});

/* A passphrase nobody can retype on a phone keyboard is the generated-password problem again. */
test('characters that cannot be typed back in are refused', () => {
  assert.equal(fresh().set('café booth—one').reason, 'unsupported-characters');
});

test('surrounding whitespace is trimmed rather than stored', () => {
  const ap = fresh();
  ap.set('  mybooth2026  ');
  assert.equal(ap.get(), 'mybooth2026');
});

/*
 * The property that matters most: get() must NEVER hand back something WPA2 would reject. A box whose
 * AP will not come up is a box nobody can reach - far worse than one that is briefly too welcoming -
 * so a corrupt or hand-edited file reads as open rather than being passed on to the radio.
 */
test('a file edited by hand into something unusable reads as open, not as a broken password', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-ap-'));
  const ap = createApPassword({ dataDir: dir });
  for (const junk of ['', '   ', 'tiny', '\n\n']) {
    writeFileSync(join(dir, 'ap-password'), junk);
    assert.equal(ap.get(), null, `"${junk}" should read as open`);
    assert.equal(ap.isOpen(), true);
  }
});

/* Not much of a secret, but not world-readable either. */
test('the stored file is not readable by everyone on the box', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-ap-'));
  createApPassword({ dataDir: dir }).set('mybooth2026');
  assert.equal(statSync(join(dir, 'ap-password')).mode & 0o077, 0);
});

/*
 * The script has to agree with this module on what "no password" means, and it cannot be re-installed
 * once a box has bootstrapped - so this pins the two halves together.
 *
 * `nmcli device wifi hotspot` CANNOT make an open network: given no password it invents one. So ap-up
 * has to build the profile explicitly, and if it ever goes back to `hotspot` a fresh box silently
 * becomes unjoinable again - which is the exact bug that produced this whole module.
 */
test('the helper builds the AP profile explicitly, because `hotspot` cannot make an open one', () => {
  const script = readFileSync(new URL('../provisioning/pidvs-network.sh', import.meta.url), 'utf8');
  /* Comments stripped first: the block deliberately EXPLAINS why it does not use `hotspot`, and
   * matching prose instead of code is how this assertion first failed against correct code. */
  const apUp = script
    .slice(script.indexOf('\nap-up)'), script.indexOf('\nap-down)'))
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.ok(!/nmcli device wifi hotspot/.test(apUp),
    'ap-up uses `nmcli device wifi hotspot`, which invents a random password when given none');
  assert.ok(/802-11-wireless\.mode ap/.test(apUp), 'ap-up no longer builds an AP-mode profile');
  assert.ok(/ipv4\.method shared/.test(apUp), 'without ipv4.method shared, clients get no DHCP or DNS');
  assert.ok(/wifi-sec\.key-mgmt wpa-psk/.test(apUp), 'ap-up can no longer make a PROTECTED network');
  // The short-password guard, without which a bad edit means no AP at all rather than an open one.
  assert.ok(/-lt 8/.test(apUp), 'ap-up no longer guards against a password WPA2 would reject');
});
