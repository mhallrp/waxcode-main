import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiagnostics, redact } from '../src/diagnostics.js';

/*
 * The redaction is the part that matters most. A diagnostics bundle leaves the box and lands
 * somewhere the owner reads it - so anything secret that reaches it has escaped, permanently, and
 * there is no taking it back. Nothing logs a password today (the WiFi handler names the SSID only,
 * and a real box's journal was checked before this shipped); this guards the line somebody adds in
 * six months without thinking about where logs go.
 */
test('redaction removes secrets in the shapes logs actually produce', () => {
  assert.match(redact('password: hunter2'), /password: \[redacted\]/);
  assert.match(redact('psk="13DavidsonPlace!"'), /psk="\[redacted\]/);
  assert.match(redact("adminPassword: 'hunter2-not-the-real-one'"), /\[redacted\]/);
  assert.match(redact('Authorization: Bearer abc123xyz'), /\[redacted\]/);
  assert.doesNotMatch(redact('password: hunter2'), /hunter2/);

  /* The real leak, in the shape it actually appeared: sudo logs the whole command line, so a PSK
   * passed as an argument is published verbatim. The argument has moved to stdin, but any box
   * already carries journal entries from before that. */
  const sudoLine = "sudo[123058]: waxcode : COMMAND=/usr/local/bin/pidvs-network join 'Home Wi-Fi' 13DavidsonPlace!";
  assert.doesNotMatch(redact(sudoLine), /13DavidsonPlace/);
  assert.match(redact(sudoLine), /join 'Home Wi-Fi' \[redacted\]/, 'the SSID stays - it is diagnostic, not secret');
  assert.doesNotMatch(redact('nmcli device wifi connect "Home" s3cret'), /s3cret/);
});

test('redaction leaves the things that make a report useful', () => {
  // These MENTION a secret without containing one, and are exactly what tells you what went wrong.
  assert.equal(redact('WIFI join failed: wrong-wifi-password'), 'WIFI join failed: wrong-wifi-password');
  assert.equal(redact('ssid="Home Wi-Fi"'), 'ssid="Home Wi-Fi"');
});

test('a reference is short, readable aloud, and stable for one report', () => {
  const { reference } = createDiagnostics({ boxIdentity: null });
  const ref = reference('0000beef0000beef', 1790000000000);
  assert.match(ref, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/, 'no 0/1/I/O - they are misread aloud');
  assert.equal(ref, reference('0000beef0000beef', 1790000000000), 'the same report must keep its code');
  assert.notEqual(ref, reference('0000beef0000beef', 1790000000001), 'a different report gets a different one');
});

test('a bundle carries state and log, and counts the library rather than listing it', async () => {
  const diagnostics = createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'abc123', name: "Dave's box" }) },
    wifiProvisioning: { status: async () => ({ connection: 'Home', ip: '192.168.1.5/24' }) },
    getDevices: () => [{ id: 'port-1', name: 'USB', scanning: false, tracks: [{}, {}, {}] }],
    deckCount: 1,
    statusPollerFor: () => ({ lastStatus: { state: 'PLAYING', path: '/media/x.mp3' } }),
    serverVersion: '0.7.7',
    execFileFn: async () => ({ stdout: 'log line with password: secret\n' }),
  });

  const bundle = await diagnostics.collect();
  assert.equal(bundle.box.name, "Dave's box");
  assert.equal(bundle.box.serverVersion, '0.7.7');
  assert.equal(bundle.network.connection, 'Home');
  assert.equal(bundle.decks[0].state, 'PLAYING');
  assert.equal(bundle.library[0].tracks, 3, 'a count, not the tracks themselves');
  assert.ok(!JSON.stringify(bundle).includes('secret'), 'nothing secret may survive into the bundle');
  assert.match(bundle.reference, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
});

test('one failing command does not lose the rest of the report', async () => {
  const diagnostics = createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'abc123' }) },
    deckCount: 1,
    execFileFn: async () => { throw new Error('journalctl: no such unit'); },
  });
  const bundle = await diagnostics.collect();
  assert.match(bundle.journal, /failed/, 'the failure is reported rather than swallowed');
  assert.ok(bundle.box.serial, 'and everything else still arrives');
});

/*
 * The 2026-09-27 additions. Their whole purpose is to answer two questions that were previously
 * impossible to answer without SSH, on boxes nobody can reach:
 *
 *   1. Which `pi/`-installed fixes does this box actually have? A release tarball never carries `pi/`,
 *      so provisioning DATE decides that, not software version - a box can run the newest server code
 *      and still be missing a fix from August.
 *   2. Is the shared ALSA layer owned by a process that no longer exists? That is the only thing that
 *      couples the two decks, so it is the only place a "one deck affected the other" fault can live.
 */

/** A box that answers every probe, with the two interesting readings injectable. */
function probeBox({ keeper = 'active', ownerPid = '1234', ownerAlive = true, throttled = 'throttled=0x0' } = {}) {
  const seen = [];
  return {
    seen,
    execFileFn: async (cmd, args) => {
      seen.push([cmd, ...args].join(' '));
      const line = args.join(' ');
      if (cmd === 'systemctl' && args[0] === 'show') {
        return {
          stdout: keeper === 'absent'
            ? 'LoadState=not-found\nActiveState=inactive\nNRestarts=0'
            : `LoadState=loaded\nActiveState=${keeper}\nNRestarts=0`,
        };
      }
      if (cmd === 'cat' && line.includes('pcm0')) {
        return { stdout: `state: RUNNING\nowner_pid   : ${ownerPid}\nhw_ptr     : 48000` };
      }
      if (cmd === 'ps' && args.includes('-p')) {
        if (!ownerAlive) throw new Error('no such process');
        return { stdout: 'aplay' };
      }
      if (line.includes('get_throttled')) return { stdout: throttled };
      return { stdout: 'ok' };
    },
  };
}

const collectFrom = (opts) => createDiagnostics({
  boxIdentity: { describe: () => ({ serial: 'deadbeef', name: 'test' }) },
  deckCount: 2,
  execFileFn: probeBox(opts).execFileFn,
}).collect();

test('a bundle says whether the dmix keepers are actually running on this box', async () => {
  const bundle = await collectFrom({ keeper: 'active' });
  assert.equal(bundle.fixes.dmixKeeperPlayback, 'active');
  assert.equal(bundle.fixes.dmixKeeperCapture, 'active');
});

/* "absent" is the answer that matters and the one a plain is-active cannot give: it means a
 * hand-install or a reflash, because no app update can ever deliver a pi/ unit. */
test('a box that never had the keepers reports them as absent, not merely inactive', async () => {
  const bundle = await collectFrom({ keeper: 'absent' });
  assert.equal(bundle.fixes.dmixKeeperPlayback, 'absent');
});

test('a healthy shared layer reports its owner as alive', async () => {
  const bundle = await collectFrom({ ownerPid: '1234', ownerAlive: true });
  assert.equal(bundle.audio.sharedPlayback.ownerPid, '1234');
  assert.equal(bundle.audio.sharedPlayback.ownerAlive, 'aplay');
  assert.equal(bundle.audio.sharedPlayback.warning, undefined);
});

/* The smoking gun. A shared layer whose owner_pid points at a dead process is the documented cause of
 * both decks misbehaving at once, and it is invisible in every other reading. */
test('a shared layer owned by a dead process is called out explicitly', async () => {
  const bundle = await collectFrom({ ownerPid: '9999', ownerAlive: false });
  assert.equal(bundle.audio.sharedPlayback.ownerAlive, false);
  assert.match(bundle.audio.sharedPlayback.warning, /no longer exists/);
});

/* Sticky since boot, so it still answers for a brownout hours ago - on a box that looks fine by the
 * time anyone presses the button, which is every box someone reports a fault on. */
test('throttling history is decoded, not left as a hex mask nobody can read', async () => {
  const bundle = await collectFrom({ throttled: 'throttled=0x50000' });
  assert.equal(bundle.health.throttled.clean, false);
  assert.ok(bundle.health.throttled.flags.some((f) => /under-voltage has occurred/.test(f)));
});

test('a clean box says so rather than reporting nothing', async () => {
  const bundle = await collectFrom({ throttled: 'throttled=0x0' });
  assert.equal(bundle.health.throttled.clean, true);
  assert.deepEqual(bundle.health.throttled.flags, []);
});

/*
 * The fault being chased appeared HOURS in, and a 300-line tail cannot reach that far on a box that
 * ran all evening. These two look across the whole boot instead.
 */
test('the bundle carries filtered whole-boot logs, not only a recent tail', async () => {
  const bundle = await collectFrom({});
  assert.equal(typeof bundle.serverEvents, 'string');
  assert.equal(typeof bundle.kernel, 'string');
  assert.ok(bundle.decks.every((d) => d.xruns !== undefined), 'each deck should report its xrun count');
});

/*
 * One reading failing must cost its own section, never the bundle. The audience is boxes nobody can
 * reach: a bundle missing its ALSA readings is still worth having, and one that never arrives leaves
 * somebody describing a fault down the phone.
 */
test('a probe that throws costs its own section, not the whole report', async () => {
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 2,
    execFileFn: async () => { throw Object.assign(new Error('boom'), { code: 'EACCES' }); },
  }).collect();

  // Still a valid report by waxcode-web's own rules: reference, timestamp, serial, decks, journal.
  assert.match(bundle.reference, /^[2-9A-HJ-NP-Z]{3}-[2-9A-HJ-NP-Z]{3}$/);
  assert.ok(Date.parse(bundle.at));
  assert.equal(bundle.box.serial, 'deadbeef');
  assert.ok(Array.isArray(bundle.decks));
  assert.equal(typeof bundle.journal, 'string');
});

/*
 * The 2026-09-27 per-deck additions, prompted by a report of a deck "acting as though position lock was
 * off" six hours into a session. The bundle at the time kept three of the thirteen fields xwax reports,
 * and the two it dropped were the two that would have answered it.
 */

import { settingMismatches } from '../src/diagnostics.js';

test('settingMismatches names a setting the box is reporting but xwax is not honouring', () => {
  const out = settingMismatches({ relative: true, keyLock: false }, { relative: false, keyLock: false });
  assert.equal(out.length, 1);
  assert.match(out[0], /relative mode/);
  assert.match(out[0], /position lock is OFF/);
  assert.match(out[0], /box has it ON, xwax reports OFF/);
});

test('settingMismatches catches key lock too - the one this already happened to', () => {
  const out = settingMismatches({ relative: false, keyLock: true }, { relative: false, keyLock: false });
  assert.deepEqual(out.map((m) => m.split(':')[0]), ['key lock']);
});

test('agreement produces nothing, so a clean box stays quiet', () => {
  assert.deepEqual(settingMismatches({ relative: true, keyLock: true }, { relative: true, keyLock: true }), []);
});

/* null is "this xwax does not report it", never a disagreement. Inventing one out of a missing field
 * would send somebody chasing a bug that is not there - and older xwaxes are normal now. */
test('an unknown field is never reported as a mismatch', () => {
  assert.deepEqual(settingMismatches({ relative: true, keyLock: true }, { relative: null, keyLock: null }), []);
  assert.deepEqual(settingMismatches(null, { relative: false }), []);
  assert.deepEqual(settingMismatches({ relative: false }, null), []);
});

test('a bundle carries every STATUS field, the intent, and the comparison', async () => {
  const status = {
    state: 'PLAYING', remain: 120, pitch: 1.0, relative: false, cuePoint: 0,
    loopActive: false, loopStart: 0, loopEnd: 0, elapsed: 60,
    timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/media/x.mp3',
  };
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 1,
    deckState: () => ({ relative: true, keyLock: false, sensitivity: 0, timecodeSide: 'serato_2a' }),
    statusPollerFor: () => ({
      lastStatus: status,
      requestSignal: async () => ({ primaryLevel: 0.42, threshold: 0.08 }),
    }),
    execFileFn: async () => ({ stdout: 'ok' }),
  }).collect();

  const deck = bundle.decks[0];
  // The two fields whose absence made the original report impossible to act on.
  assert.equal(deck.status.relative, false);
  assert.equal(deck.status.unreadableSeconds, 0);
  // And the rest, so the next unfamiliar fault is not another round of "we did not keep that".
  for (const field of Object.keys(status)) {
    assert.ok(field in deck.status, `${field} is missing from the bundle`);
  }
  // The box says position lock on (relative true); xwax says relative false. That is the bug class.
  assert.equal(deck.mismatches.length, 1);
  assert.match(deck.mismatches[0], /relative mode/);
  // A live signal reading, which answers "was the timecode actually readable".
  assert.deepEqual(deck.signal, { primaryLevel: 0.42, threshold: 0.08 });
});

/* A deck that will not answer SIGNAL must not cost the bundle - that is the state a wedged deck is in,
 * which is exactly when the report is wanted. */
test('a deck that cannot answer SIGNAL still produces a bundle', async () => {
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 1,
    statusPollerFor: () => ({ lastStatus: null, requestSignal: async () => { throw new Error('no socket'); } }),
    execFileFn: async () => ({ stdout: 'ok' }),
  }).collect();
  assert.match(bundle.decks[0].signal, /did not answer SIGNAL/);
  assert.equal(bundle.decks[0].state, 'unknown');
});

test('the bundle reports the xwax revision and the box uptime in seconds', async () => {
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 1,
    statusPollerFor: () => null,
    execFileFn: async (cmd, args) => {
      if (args.join(' ').includes('REVISION')) return { stdout: 'c16972d\n' };
      if (args.join(' ').includes('/proc/uptime')) return { stdout: '21600\n' };
      return { stdout: 'ok' };
    },
  }).collect();
  assert.equal(bundle.box.xwaxRevision, 'c16972d');
  assert.equal(bundle.box.uptimeSeconds, '21600');
});

/* The watchdog captures evidence BEFORE it restarts a deck, precisely so a restart cannot hide the
 * fault - and this bundle used to ignore every one of them. */
test('the bundle carries what the deck watchdog captured', async () => {
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 1,
    statusPollerFor: () => null,
    execFileFn: async (cmd, args) => {
      const line = args.join(' ');
      // The `cat` branch first: BOTH commands contain `ls -1t ... diagnostics`, so matching on that
      // alone answered the wrong one - which is how this test first failed against correct code.
      if (line.includes('cat "$f"')) return { stdout: '=== capture ===\ndeck 1 wedged\n' };
      if (line.includes('ls -1t') && line.includes('diagnostics')) return { stdout: 'deck1-2026-09-26.txt\n' };
      return { stdout: 'ok' };
    },
  }).collect();
  assert.match(bundle.watchdog.captures, /deck1-2026-09-26/);
  assert.match(bundle.watchdog.latest, /wedged/);
});

/*
 * `systemctl is-active` exits NON-ZERO for a unit that is merely inactive, so reading state that way
 * reported an idle deck as "(systemctl failed: ...)". It looked correct only because every unit being
 * checked at the time happened to be running. Caught on hardware, 2026-09-27.
 */
test('an inactive unit reads as inactive, not as a command failure', async () => {
  const bundle = await collectFrom({ keeper: 'inactive' });
  assert.equal(bundle.fixes.dmixKeeperPlayback, 'inactive');
});

/* A unit that has restarted itself is the first thing to look for after "it was fine for hours". */
test('a unit that has restarted says how many times', async () => {
  const bundle = await createDiagnostics({
    boxIdentity: { describe: () => ({ serial: 'deadbeef' }) },
    deckCount: 1,
    statusPollerFor: () => null,
    execFileFn: async (cmd, args) => (cmd === 'systemctl' && args[0] === 'show'
      ? { stdout: 'LoadState=loaded\nActiveState=active\nNRestarts=4' }
      : { stdout: 'ok' }),
  }).collect();
  assert.equal(bundle.decks[0].service, 'active restarts=4');
});

/* Zero restarts must NOT be printed: "restarts=0" on every unit is noise that hides the one line
 * that matters. */
test('a unit that has never restarted does not say so', async () => {
  const bundle = await collectFrom({ keeper: 'active' });
  assert.equal(bundle.fixes.dmixKeeperPlayback, 'active');
});
