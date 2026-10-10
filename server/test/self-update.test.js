import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateSafety, createSelfUpdate } from '../src/self-update.js';
import { compareVersions, parts } from '../src/version-compare.js';

const IDENTITY = { id: 'k7q2zp', token: 'box-token', name: 'k7q2zp.box.waxcode.co' };

/* The REAL shape, from tools/package-release.js: `releases` is an object keyed by version and
 * `latest` carries no leading v. An array fixture agreed with my wrong assumption and the live feed
 * did not. */
function manifest(latest, releases) {
  const bare = String(latest).replace(/^v/, '');
  return {
    latest: bare,
    releases: releases ?? {
      [bare]: { file: `pidvs-server-v${bare}.tar.gz`, checksum: 'a'.repeat(64), createdAt: '2026-10-05T00:00:00.000Z' },
    },
  };
}

function harness({ res, running = 'v0.10.5', identity = IDENTITY } = {}) {
  const calls = [];
  return createSelfUpdate({
    updateServer: 'https://www.example.invalid',
    readIdentity: () => identity,
    currentVersion: () => running,
    log: () => {},
    fetchFn: async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {}, redirect: init?.redirect });
      return res;
    },
    execFileFn: async (file, args) => { calls.push({ exec: file, args }); return { stdout: '{"activated":"0.10.6"}' }; },
  });
}

const okManifest = (body) => ({ ok: true, status: 200, json: async () => body });

/* ---------------------------------------------------------------- safety --- */

test('an idle box with nothing loaded is safe to update', () => {
  const { safe, reasons } = updateSafety([
    { deck: 1, status: { state: 'EMPTY', path: null, timecodeValid: false } },
    { deck: 2, status: { state: 'EMPTY', path: null, timecodeValid: false } },
  ]);
  assert.equal(safe, true);
  assert.deepEqual(reasons, []);
});

test('a loaded track blocks it, even stopped', () => {
  const { safe, reasons } = updateSafety([
    { deck: 1, status: { state: 'STOPPED', path: '/media/x/track.mp3', timecodeValid: false } },
  ]);
  assert.equal(safe, false);
  assert.match(reasons.join(' '), /track loaded/);
});

test('a needle on timecode blocks it even with both decks EMPTY', () => {
  /* The gate that matters most and is easiest to forget. Somebody cueing up has nothing loaded yet,
   * and an update would stop the decks and recompile xwax underneath them. */
  const { safe, reasons } = updateSafety([
    { deck: 1, status: { state: 'EMPTY', path: null, timecodeValid: true } },
    { deck: 2, status: { state: 'EMPTY', path: null, timecodeValid: false } },
  ]);
  assert.equal(safe, false);
  assert.match(reasons.join(' '), /needle on timecode/);
});

test('recording blocks it, and so does anybody being connected', () => {
  const idle = [{ deck: 1, status: { state: 'EMPTY', path: null, timecodeValid: false } }];
  assert.equal(updateSafety(idle, { recording: true }).safe, false);
  assert.equal(updateSafety(idle, { recording: false }).safe, true);
});

test('a deck that has not answered at all does not count as a reason to refuse', () => {
  // A deck with no status is a deck that is not running - not evidence that somebody is mixing.
  assert.equal(updateSafety([{ deck: 1, status: null }, { deck: 2 }]).safe, true);
  assert.equal(updateSafety([]).safe, true);
  assert.equal(updateSafety(undefined).safe, true);
});

test('every reason is reported, not just the first', () => {
  const { reasons } = updateSafety(
    [{ deck: 1, status: { state: 'PLAYING', path: '/x.mp3', timecodeValid: true } }],
    { recording: true },
  );
  // Someone reading this wants the whole picture, not to fix one thing and be refused again.
  assert.ok(reasons.length >= 4, `expected several reasons, got ${reasons.length}`);
});

/* ------------------------------------------------------- version compare --- */

test('versions compare numerically, not as strings', () => {
  // The bug this exists to prevent: a string compare puts v0.10.6 BELOW v0.9.0.
  assert.ok(compareVersions('v0.10.6', 'v0.9.0') > 0);
  assert.ok(compareVersions('v0.9.0', 'v0.10.6') < 0);
  assert.equal(compareVersions('v0.10.6', '0.10.6'), 0, 'the leading v is not significant');
  assert.equal(compareVersions('0.10.6', '0.10.6'), 0);
  assert.ok(compareVersions('v1.0.0', 'v0.99.99') > 0);
});

test('an unreadable running version is treated as older, so the box is still offered the update', () => {
  /* The opposite default would leave a box that cannot read its own `current` symlink stuck forever,
   * which is the worse failure of the two. */
  assert.ok(compareVersions('v0.10.6', null) > 0);
  assert.ok(compareVersions('v0.10.6', 'nonsense') > 0);
  assert.equal(parts('nonsense'), null);
  assert.equal(compareVersions(null, null), 0);
});

/* ---------------------------------------------------------------- check --- */

test('check reports what is offered and whether it is newer', async () => {
  const updater = harness({ res: okManifest(manifest('v0.10.6')), running: 'v0.10.5' });
  const result = await updater.check();
  assert.equal(result.ok, true);
  assert.equal(result.latest, 'v0.10.6');
  assert.equal(result.running, 'v0.10.5');
  assert.equal(result.newer, true);
  assert.equal(result.file, 'pidvs-server-v0.10.6.tar.gz');
});

test('an up-to-date box is told so rather than offered its own version', async () => {
  const updater = harness({ res: okManifest(manifest('v0.10.6')), running: 'v0.10.6' });
  const result = await updater.check();
  assert.equal(result.ok, true);
  assert.equal(result.newer, false);
});

test('the box authenticates as itself, and never follows a redirect', async () => {
  const calls = [];
  const updater = createSelfUpdate({
    updateServer: 'https://www.example.invalid',
    readIdentity: () => IDENTITY,
    currentVersion: () => 'v0.10.5',
    log: () => {},
    fetchFn: async (url, init) => { calls.push(init); return okManifest(manifest('v0.10.6')); },
  });
  await updater.check();

  assert.equal(calls[0].headers.Authorization, 'Bearer box-token');
  assert.equal(calls[0].headers['x-waxcode-box'], 'k7q2zp');
  /* A 308 STRIPS the Authorization header, so a followed redirect arrives unauthenticated and 401s.
   * waxcode.co redirects to www, which is why this must fail loudly instead. */
  assert.equal(calls[0].redirect, 'error');
});

test('a box with no identity yet says so instead of trying', async () => {
  const updater = harness({ res: okManifest(manifest('v0.10.6')), identity: null });
  assert.deepEqual(await updater.check(), { ok: false, reason: 'no-identity' });
});

test('each failure is named, so the UI can say something true', async () => {
  const unauthorized = harness({ res: { ok: false, status: 401 } });
  assert.equal((await unauthorized.check()).reason, 'unauthorized');

  const broken = harness({ res: { ok: false, status: 500 } });
  assert.equal((await broken.check()).reason, 'feed-error');

  const empty = harness({ res: okManifest({ releases: {} }) });
  assert.equal((await empty.check()).reason, 'no-releases');

  const offline = createSelfUpdate({
    readIdentity: () => IDENTITY,
    log: () => {},
    fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND'); },
  });
  const result = await offline.check();
  assert.equal(result.reason, 'unreachable');
  assert.match(result.detail, /ENOTFOUND/);
});

test('safety() reads the box afresh each time it is asked', () => {
  /* Not captured at construction: the whole point is that somebody can drop a needle between reading
   * the screen and tapping the button, and the POST handler re-checks for exactly that reason. */
  let recording = false;
  const updater = createSelfUpdate({
    readIdentity: () => IDENTITY,
    log: () => {},
    readDecks: () => [{ deck: 1, status: { state: 'EMPTY', path: null, timecodeValid: false } }],
    isRecording: () => recording,
  });

  assert.equal(updater.safety().safe, true);
  recording = true;
  assert.equal(updater.safety().safe, false, 'it noticed without being rebuilt');
});

/*
 * check() feeding apply() directly, which is the seam that broke on the real box: apply destructured
 * `version` while check returns `latest`, so a successful download activated `undefined`. Both
 * functions had tests; nothing exercised the handoff between them.
 */
test('apply takes what check returns, field for field', async () => {
  const calls = [];
  /* A REAL hash of the bytes served, so the download's own checksum check is exercised rather than
   * sidestepped - it caught this fixture when the hash was fake, which is the behaviour wanted. */
  const body = Buffer.from('a pretend tarball');
  const checksum = createHash('sha256').update(body).digest('hex');

  const updater = createSelfUpdate({
    updateServer: 'https://www.example.invalid',
    readIdentity: () => IDENTITY,
    currentVersion: () => 'v0.10.6',
    log: () => {},
    downloadDir: mkdtempSync(join(tmpdir(), 'update-')),
    fetchFn: async (url) => (String(url).endsWith('/manifest')
      ? okManifest({ latest: '0.10.7', releases: { '0.10.7': { file: 'pidvs-server-v0.10.7.tar.gz', checksum } } })
      : { ok: true, status: 200, body: Readable.toWeb(Readable.from([body])) }),
    execFileFn: async (file, args) => { calls.push(args); return { stdout: 'ok' }; },
  });

  const offered = await updater.check();
  assert.equal(offered.newer, true);

  // Handed straight across, exactly as http-api.js does it.
  await updater.apply(offered);

  const [, command, version, path] = calls[0];
  assert.equal(command, 'activate-file');
  assert.equal(version, '0.10.7', 'the version reaches the updater, without a leading v');
  assert.match(path, /pidvs-server-v0\.10\.7\.tar\.gz$/);
});

test('apply refuses a malformed argument rather than activating undefined', async () => {
  const updater = harness({ res: okManifest(manifest('v0.10.7')) });
  await assert.rejects(() => updater.apply({}), /needs the result of check/);
  await assert.rejects(() => updater.apply(undefined), /needs the result of check/);
  // The old shape, which is what the route was passing by name.
  await assert.rejects(() => updater.apply({ version: 'v0.10.7' }), /needs the result of check/);
});

/*
 * activate-file restarts pidvs-server, which kills this process mid-call - so a rejection from the
 * child is what SUCCESS looks like. The first real run logged "[self-update] failed" on a box that
 * had just correctly moved to v0.10.8. Left alone it would make automatic updates retry forever.
 */
test('the server being restarted by the activation is not a failure', async () => {
  const body = Buffer.from('tarball');
  const checksum = createHash('sha256').update(body).digest('hex');
  const logged = [];

  const terminated = Object.assign(new Error('Command failed: node .../cli.js activate-file'), {
    killed: true, signal: 'SIGTERM',
  });

  const updater = createSelfUpdate({
    readIdentity: () => IDENTITY,
    currentVersion: () => 'v0.10.6',
    downloadDir: mkdtempSync(join(tmpdir(), 'update-')),
    log: (line) => logged.push(line),
    fetchFn: async (url) => (String(url).endsWith('/manifest')
      ? okManifest({ latest: '0.10.8', releases: { '0.10.8': { file: 'r.tar.gz', checksum } } })
      : { ok: true, status: 200, body: Readable.toWeb(Readable.from([body])) }),
    execFileFn: async () => { throw terminated; },
  });

  const result = await updater.apply(await updater.check());
  assert.equal(result.ok, true, 'a restart is success, not a failure');
  assert.equal(result.restarted, true);
  assert.ok(!logged.join(' ').includes('failed'), 'and it does not say failed');
});

test('a genuine non-zero exit from the updater is still a failure', async () => {
  const body = Buffer.from('tarball');
  const checksum = createHash('sha256').update(body).digest('hex');
  const broken = Object.assign(new Error('Command failed'), { code: 1 });

  const updater = createSelfUpdate({
    readIdentity: () => IDENTITY,
    currentVersion: () => 'v0.10.6',
    downloadDir: mkdtempSync(join(tmpdir(), 'update-')),
    log: () => {},
    fetchFn: async (url) => (String(url).endsWith('/manifest')
      ? okManifest({ latest: '0.10.8', releases: { '0.10.8': { file: 'r.tar.gz', checksum } } })
      : { ok: true, status: 200, body: Readable.toWeb(Readable.from([body])) }),
    execFileFn: async () => { throw broken; },
  });

  // A tarball the updater genuinely rejected must not be reported as installed.
  const offered = await updater.check();
  await assert.rejects(() => updater.apply(offered), /Command failed/);
});

test('a failed activation reports the updater own words, not just "Command failed"', async () => {
  const body = Buffer.from('tarball');
  const checksum = createHash('sha256').update(body).digest('hex');
  const logged = [];

  /* What execFile actually throws: a generic message, with the reason on stderr. Logging only the
   * message is what left a real failure on the box undiagnosable. */
  const failed = Object.assign(new Error('Command failed: node .../cli.js activate-file'), {
    code: 1,
    stderr: 'Error: an update or rollback is already in progress',
    stdout: '',
  });

  const updater = createSelfUpdate({
    readIdentity: () => IDENTITY,
    currentVersion: () => 'v0.10.6',
    downloadDir: mkdtempSync(join(tmpdir(), 'update-')),
    log: (line) => logged.push(line),
    fetchFn: async (url) => (String(url).endsWith('/manifest')
      ? okManifest({ latest: '0.10.9', releases: { '0.10.9': { file: 'r.tar.gz', checksum } } })
      : { ok: true, status: 200, body: Readable.toWeb(Readable.from([body])) }),
    execFileFn: async () => { throw failed; },
  });

  const offered = await updater.check();
  await assert.rejects(() => updater.apply(offered), /already in progress/);
  assert.match(logged.join('\n'), /already in progress/, 'the reason is logged, not swallowed');
});
