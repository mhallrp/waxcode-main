import { createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { prioritizedSpawn } from './process-priority.js';
import { DATA_DIR } from './box-paths.js';

/** A support session: an outbound tunnel to this box's own sshd, which the OWNER OF THE BOX opens. */

const BINARY_URL =
  'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64';

/** DATA_DIR survives updates - release-manager symlinks it into every release */
const BINARY_PATH = join(DATA_DIR, 'cloudflared');

/** Long enough to run the bootstrap by hand, short enough that forgetting to stop it is harmless. */
export const SESSION_MINUTES = 30;

/** cloudflared announces the hostname on stderr, inside a box drawn in plus signs. */
const HOSTNAME_PATTERN = /https:\/\/([a-z0-9][a-z0-9-]*\.trycloudflare\.com)/;

/** Covers fetching the binary over a slow connection as well as the tunnel registering. */
const START_TIMEOUT_MS = 180_000;

export function createSupportTunnel({
  binaryPath = BINARY_PATH,
  binaryUrl = BINARY_URL,
  fetchFn = fetch,
  spawnFn = spawn,
  existsFn = existsSync,
  sessionMinutes = SESSION_MINUTES,
  startTimeoutMs = START_TIMEOUT_MS,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  log = console.log,
} = {}) {
  let child = null;
  let hostname = null;
  let expiresAt = null;
  let expiryTimer = null;

  /** Downloaded to a temp name and renamed, so an interrupted fetch cannot leave a part-file sitting there looking like a working binary. */
  async function ensureBinary() {
    if (existsFn(binaryPath)) return;

    await mkdir(dirname(binaryPath), { recursive: true });
    const partPath = `${binaryPath}.part`;
    const res = await fetchFn(binaryUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching cloudflared`);

    await pipeline(Readable.fromWeb(res.body), createWriteStream(partPath));
    await chmod(partPath, 0o755);
    await rename(partPath, binaryPath);
    log('[support] fetched cloudflared');
  }

  function clearSession() {
    if (expiryTimer !== null) clearTimeoutFn(expiryTimer);
    expiryTimer = null;
    child = null;
    hostname = null;
    expiresAt = null;
  }

  function status() {
    if (child === null || hostname === null) {
      return { active: false, hostname: null, secondsRemaining: 0 };
    }
    return {
      active: true,
      hostname,
      secondsRemaining: Math.max(0, Math.round((expiresAt - now()) / 1000)),
    };
  }

  function stop(reason = 'stopped') {
    if (child === null) return { ok: true, stopped: false, ...status() };
    log(`[support] session ${reason}`);
    const dying = child;
    clearSession();
    try {
      dying.kill('SIGTERM');
    } catch { /* already gone - the session is cleared either way */ }
    return { ok: true, stopped: true, active: false, hostname: null, secondsRemaining: 0 };
  }

  async function start() {
    // Idempotent: a second tap re-reports the live session rather than opening a competing one.
    if (child !== null && hostname !== null) return { ok: true, ...status() };

    try {
      await ensureBinary();
    } catch (err) {
      /** Nearly always no internet - which is also a likely reason for wanting support in the first place */
      log(`[support] could not fetch cloudflared: ${err.message}`);
      return { ok: false, reason: 'no-binary', detail: err.message };
    }

    /** Backgrounded for the reason every spawn here is: a deck may well be playing, and nothing about a support session is worth a dropout. */
    const proc = prioritizedSpawn(
      spawnFn,
      binaryPath,
      ['tunnel', '--no-autoupdate', '--url', 'ssh://localhost:22'],
      'background',
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child = proc;

    return await new Promise((resolve) => {
      let settled = false;
      let timer = null;

      function settle(answer) {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeoutFn(timer);
        resolve(answer);
      }

      function read(chunk) {
        if (hostname !== null) return;
        const found = HOSTNAME_PATTERN.exec(String(chunk));
        if (found === null) return;

        hostname = found[1];
        expiresAt = now() + sessionMinutes * 60_000;
        /** The box ends the session itself. */
        expiryTimer = setTimeoutFn(() => stop('expired'), sessionMinutes * 60_000);
        log(`[support] session open at ${hostname} for ${sessionMinutes} minutes`);
        settle({ ok: true, ...status() });
      }

      proc.stdout?.on('data', read);
      proc.stderr?.on('data', read);

      proc.on('error', (err) => {
        clearSession();
        settle({ ok: false, reason: 'spawn-failed', detail: err.message });
      });

      proc.on('exit', (code) => {
        const wasOpen = hostname !== null;
        clearSession();
        if (wasOpen) log(`[support] tunnel closed (code ${code})`);
        settle({ ok: false, reason: 'tunnel-exited', detail: `cloudflared exited with code ${code}` });
      });

      timer = setTimeoutFn(() => {
        stop('timed out');
        settle({ ok: false, reason: 'timeout' });
      }, startTimeoutMs);
    });
  }

  return { start, stop, status };
}
