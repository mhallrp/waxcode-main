import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isDeckRunning, isDeckServing } from './xwax-status.js';

const execFileAsync = promisify(execFile);

// Absolute path, not bare "systemctl" - must match the sudoers rule exactly (pi/pidvs-sudoers-xwax-lifecycle), which matches on literal path.
const SYSTEMCTL_PATH = '/usr/bin/systemctl';

// How long to wait for xwax's control socket to accept connections after `systemctl start`
const START_TIMEOUT_MS = 3000;
const START_POLL_INTERVAL_MS = 100;

/** Starts deck N's xwax@N.service on demand if not already running, and waits for its control socket to accept connections before resolving. */
export async function ensureDeckRunning(deckNumber, {
  execFileFn = execFileAsync,
  // Defaults to the permissive check.
  isReady = isDeckRunning,
  timeoutMs = START_TIMEOUT_MS,
  pollIntervalMs = START_POLL_INTERVAL_MS,
  // Called only when this actually STARTED the deck, so per-deck settings xwax does not persist itself can be reapplied
  onStarted,
} = {}) {
  if (await isReady(deckNumber)) return;

  await execFileFn(SYSTEMCTL_PATH, ['start', `xwax@${deckNumber}.service`]);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReady(deckNumber)) {
      await onStarted?.(deckNumber);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`deck ${deckNumber}'s xwax service did not become ready within ${timeoutMs}ms`);
}

/** Stops deck N's xwax@N.service - used when passthrough turns on. Stays stopped until the next LOAD calls ensureDeckRunning again. */
export async function stopDeckService(deckNumber, { execFileFn = execFileAsync } = {}) {
  await execFileFn(SYSTEMCTL_PATH, ['stop', `xwax@${deckNumber}.service`]);
}

/** Stops and restarts deck N's xwax, waiting for it to be ready again. */
export async function restartDeckService(deckNumber, deps = {}) {
  await stopDeckService(deckNumber, deps);
  /** isDeckServing, not isDeckRunning - this is the case ensureDeckRunning's own note warns about. */
  await ensureDeckRunning(deckNumber, { ...deps, isReady: deps.isReady ?? isDeckServing });
}
