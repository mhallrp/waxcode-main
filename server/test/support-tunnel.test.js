import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSupportTunnel } from '../src/support-tunnel.js';

/** A stand-in for cloudflared: emits on stderr like the real one, and exits when killed. */
function fakeCloudflared() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; return true; };
  return proc;
}

/* The real banner, which is what the pattern has to survive - the hostname arrives inside a box
 * drawn in plus signs, on a line of its own, among a great deal of other output. */
const BANNER = `
2026-10-02T17:16:15Z INF +--------------------------------------------------------+
2026-10-02T17:16:15Z INF |  Your quick Tunnel has been created! Visit it at:       |
2026-10-02T17:16:15Z INF |    https://tidy-otter-brave-kite.trycloudflare.com      |
2026-10-02T17:16:15Z INF +--------------------------------------------------------+
`;

const HOST = 'tidy-otter-brave-kite.trycloudflare.com';

/* start() awaits the binary check before it attaches its output listeners, so a test that emits
 * immediately would be talking to nobody. Every test hands control back once first. */
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

function harness({ exists = true, fetchFn, sessionMinutes = 30 } = {}) {
  const proc = fakeCloudflared();
  const timers = [];
  let clock = 0;
  const spawned = [];

  const tunnel = createSupportTunnel({
    binaryPath: '/tmp/cloudflared-test',
    existsFn: () => exists,
    fetchFn,
    sessionMinutes,
    spawnFn: (command, args, options) => { spawned.push({ command, args, options }); return proc; },
    now: () => clock,
    setTimeoutFn: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeoutFn: (t) => { const i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); },
    log: () => {},
  });

  return {
    tunnel,
    proc,
    spawned,
    /** Start, let the listeners attach, then report the hostname as cloudflared would. */
    async open() {
      const starting = tunnel.start();
      await flush();
      proc.stderr.emit('data', BANNER);
      return await starting;
    },
    /** Run the timer scheduled for this many ms, as the real clock reaching it would. */
    fire: (ms) => { clock += ms; timers.filter((t) => t.ms === ms).forEach((t) => t.fn()); },
    pending: () => timers.map((t) => t.ms),
    flush,
  };
}

test('a session reports the hostname cloudflared printed', async () => {
  const h = harness();
  const answer = await h.open();

  assert.equal(answer.ok, true);
  assert.equal(answer.hostname, HOST);
  assert.equal(answer.active, true);
  assert.equal(h.tunnel.status().active, true);
});

test('it proxies to the local sshd, and never autoupdates itself', async () => {
  const h = harness();
  await h.open();

  /* Backgrounded, so it cannot compete with a playing deck - prioritizedSpawn wraps the binary in
   * nice/ionice/taskset, so the command IS nice and cloudflared is among the arguments. */
  const { command, args } = h.spawned[0];
  assert.equal(command, 'nice');
  assert.ok(args.includes('/tmp/cloudflared-test'), 'spawns the cached binary');
  assert.ok(args.includes('ssh://localhost:22'), 'points at the local sshd');
  assert.ok(args.includes('--no-autoupdate'), 'a support binary must not rewrite itself');
});

test('the box closes the session itself when it expires', async () => {
  const h = harness({ sessionMinutes: 30 });
  await h.open();

  /* The whole feature's safety story: nobody has to remember to turn it off, so a phone put down
   * mid-session cannot leave a way in. */
  h.fire(30 * 60_000);
  assert.equal(h.proc.killed, true, 'cloudflared was killed');
  assert.equal(h.tunnel.status().active, false);
  assert.equal(h.tunnel.status().hostname, null);
});

test('a second tap re-reports the open session instead of opening another', async () => {
  const h = harness();
  await h.open();

  const again = await h.tunnel.start();
  assert.equal(again.ok, true);
  assert.equal(again.hostname, HOST);
  assert.equal(h.spawned.length, 1, 'did not spawn a competing tunnel');
});

test('stopping leaves no session and no timer behind', async () => {
  const h = harness();
  await h.open();

  const stopped = h.tunnel.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(h.proc.killed, true);
  assert.equal(h.tunnel.status().active, false);
  // A live expiry timer would fire against a cleared session later.
  assert.deepEqual(h.pending(), [], 'the expiry timer was cleared');
});

test('stopping when nothing is open is not an error', () => {
  const h = harness();
  const answer = h.tunnel.stop();
  assert.equal(answer.ok, true);
  assert.equal(answer.stopped, false);
});

test('the countdown falls as the session runs', async () => {
  const h = harness({ sessionMinutes: 30 });
  await h.open();

  assert.equal(h.tunnel.status().secondsRemaining, 1800);
  h.fire(10 * 60_000);
  assert.equal(h.tunnel.status().secondsRemaining, 1200);
});

test('no internet to fetch the binary says so, rather than just failing', async () => {
  const h = harness({
    exists: false,
    fetchFn: async () => { throw new Error('fetch failed'); },
  });

  const answer = await h.tunnel.start();
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'no-binary');
  assert.match(answer.detail, /fetch failed/);
  assert.equal(h.spawned.length, 0, 'nothing was spawned without a binary');
});

test('cloudflared dying before it reports a hostname is reported, not awaited forever', async () => {
  const h = harness();
  const starting = h.tunnel.start();
  await h.flush();
  h.proc.emit('exit', 1);

  const answer = await starting;
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'tunnel-exited');
  assert.equal(h.tunnel.status().active, false);
});

test('a tunnel that never registers times out instead of hanging the request', async () => {
  const h = harness();
  const starting = h.tunnel.start();
  await h.flush();
  h.fire(180_000);

  const answer = await starting;
  assert.equal(answer.ok, false);
  assert.equal(answer.reason, 'timeout');
  assert.equal(h.proc.killed, true, 'the stuck process was not left running');
});

test('the session ending on its own clears the status', async () => {
  const h = harness();
  await h.open();

  // cloudflared losing its connection and giving up, which the UI has to stop claiming is open.
  h.proc.emit('exit', 0);
  assert.equal(h.tunnel.status().active, false);
  assert.equal(h.tunnel.status().hostname, null);
});
