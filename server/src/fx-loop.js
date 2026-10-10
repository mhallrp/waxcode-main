import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINE } from './deck-input-mode.js';

const DEFAULT_DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');

/**
 * The mixer's FX send and return, with the box as the effect.
 *
 * A rotary mixer's send/return is the right control surface for this and the app is the wrong one:
 * a filter swept through a browser over wifi feels like neither. So the app only ever holds the
 * SETTINGS, and the send knobs on the mixer do the playing.
 *
 * Wet only, always. A send/return is additive - the mixer still has the dry signal on its own
 * channels - so returning the dry a second time, 43ms late, would comb-filter rather than add
 * anything. That also rules out filters and isolators by topology, which is why the first effect
 * here is a reverb: subtractive effects cannot work down this path at all.
 *
 * LINE MODE ONLY, and that is not a preference. The return shares deck 1's phono jack, which in
 * Phono mode carries a real record at cartridge level. The two can never run at once.
 */

/** Set by the mixer's FX SEND; the one input jack with no deck behind it. */
export const FX_CAPTURE = 'dvs_fx_capture';
/** Shares deck 1's phono pair - silent in Line mode. See pi/asound.conf. */
export const FX_RETURN = 'dvs_fx_return';

/** The same figure passthrough.js uses: the same dmix layer, so the same buffer. */
const SOX_BUFFER_BYTES = 2048 * 2 * 4;

const UNEXPECTED_EXIT_RESTART_DELAY_MS = 1500;
const MAX_CONSECUTIVE_RESTARTS = 3;
const STABLE_RUN_MS = 5000;

/**
 * What the box can be.
 *
 * `-w` is sox's wet-only flag, and is not optional here for the reason in the header. The rest is
 * reverberance, HF damping, room scale, stereo depth, pre-delay, wet gain - sox's own order.
 * Pre-delay stays at zero because the loop already carries ~43ms of its own.
 */
export const EFFECTS = {
  reverb: {
    label: 'Reverb',
    args: ['reverb', '-w', '60', '50', '100', '100', '0', '0'],
  },
};

export const DEFAULT_EFFECT = 'reverb';

export function fxCommand(effect) {
  const chosen = EFFECTS[effect] ?? EFFECTS[DEFAULT_EFFECT];
  return ['sox', [
    '-q', '--buffer', String(SOX_BUFFER_BYTES),
    '-t', 'alsa', FX_CAPTURE,
    '-t', 'alsa', FX_RETURN,
    ...chosen.args,
  ]];
}

/** Logs the child's output line by line, the way passthrough does - an unread pipe hides every real failure. */
function logOutput(streamName, stream) {
  let buffer = '';
  stream?.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) console.log(`[fx] sox (${streamName}): ${line}`);
    }
  });
}

export function createFxLoop({
  dataDir = DEFAULT_DATA_DIR,
  spawnFn = spawn,
  /** Reads the box-wide Phono/Line setting. */
  inputMode = () => LINE,
  log = console.log,
  restartDelayMs = UNEXPECTED_EXIT_RESTART_DELAY_MS,
  maxConsecutiveRestarts = MAX_CONSECUTIVE_RESTARTS,
  stableRunMs = STABLE_RUN_MS,
} = {}) {
  const path = join(dataDir, 'fx.json');

  function readStored() {
    if (!existsSync(path)) return { enabled: false, effect: DEFAULT_EFFECT };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      return {
        enabled: parsed.enabled === true,
        effect: EFFECTS[parsed.effect] ? parsed.effect : DEFAULT_EFFECT,
      };
    } catch (err) {
      log(`[fx] unreadable ${path}, starting off: ${err.message}`);
      return { enabled: false, effect: DEFAULT_EFFECT };
    }
  }

  let { enabled, effect } = readStored();
  let child = null;
  let startedAt = 0;
  let consecutiveRestarts = 0;
  let restartTimer = null;

  function store() {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmpPath = `${path}.tmp`;
      writeFileSync(tmpPath, JSON.stringify({ enabled, effect }));
      renameSync(tmpPath, path);
    } catch (err) {
      // Not worth failing a working FX loop over - it just will not survive a reboot.
      log(`[fx] could not store the setting: ${err.message}`);
    }
  }

  /** The rule the shared output jack depends on. */
  function allowed() {
    return inputMode() === LINE;
  }

  function spawnSox() {
    const [command, args] = fxCommand(effect);
    const proc = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    startedAt = Date.now();
    logOutput('stdout', proc.stdout);
    logOutput('stderr', proc.stderr);

    proc.on('exit', (code, signal) => {
      if (child !== proc) return; // already replaced or deliberately stopped
      child = null;
      log(`[fx] sox exited (code=${code}, signal=${signal})`);
      if (!enabled || !allowed()) return;

      if (Date.now() - startedAt >= stableRunMs) consecutiveRestarts = 0;
      consecutiveRestarts += 1;
      if (consecutiveRestarts > maxConsecutiveRestarts) {
        log(`[fx] giving up after ${maxConsecutiveRestarts} restarts without a stable run`);
        enabled = false;
        store();
        return;
      }
      restartTimer = setTimeout(() => { if (enabled && allowed()) spawnSox(); }, restartDelayMs);
      restartTimer?.unref?.();
    });

    proc.on('error', (err) => log(`[fx] sox could not start: ${err.message}`));
    log(`[fx] started: ${effect}, ${FX_CAPTURE} -> ${FX_RETURN}`);
  }

  function stopSox() {
    clearTimeout(restartTimer);
    restartTimer = null;
    const proc = child;
    child = null;
    if (!proc) return;
    proc.kill('SIGTERM');
    log('[fx] stopped');
  }

  /** Brings the child into line with what is wanted AND what is allowed. */
  function reconcile() {
    if (enabled && allowed()) {
      if (!child) { consecutiveRestarts = 0; spawnSox(); }
      return;
    }
    stopSox();
  }

  return {
    /** Whether the loop is on offer at all - the app hides it entirely in Phono mode. */
    available: allowed,
    isEnabled: () => enabled,
    isRunning: () => child !== null,
    effect: () => effect,

    setEnabled(next) {
      const wanted = next === true;
      if (wanted && !allowed()) {
        log('[fx] refused: the return shares deck 1\'s phono output, which Phono mode is using');
        return false;
      }
      enabled = wanted;
      store();
      reconcile();
      return enabled;
    },

    setEffect(name) {
      if (!EFFECTS[name]) return effect;
      effect = name;
      store();
      // A different effect is a different sox chain, so the child is replaced rather than told.
      if (child) { stopSox(); reconcile(); }
      return effect;
    },

    /** Called when the box-wide Phono/Line setting changes - Phono takes the output jack back. */
    inputModeChanged() {
      reconcile();
    },

    status() {
      return {
        available: allowed(),
        enabled,
        running: child !== null,
        effect,
        effects: Object.entries(EFFECTS).map(([id, { label }]) => ({ id, label })),
      };
    },

    /** Starts whatever was stored, at boot. */
    restore() {
      reconcile();
    },

    stop: stopSox,
  };
}
