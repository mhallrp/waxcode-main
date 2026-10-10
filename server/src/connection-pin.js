import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { DATA_DIR } from './box-paths.js';

/** An optional PIN, for the case where the LAN is not somewhere you trust. */

const STORE = 'connection-pin.json';
const SESSIONS = 'connection-pin-sessions.json';

/** What a box has until somebody chooses otherwise. Four digits, because it is typed on a phone. */
export const DEFAULT_PIN = '0000';

/** Sessions outlive a restart but not a month, so a borrowed phone does not keep access forever. */
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/** Four digits is 10,000 guesses - seconds of scripting. Without a throttle the PIN is decoration. */
export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 30_000;

/** Paths that must answer even while locked, or the gate could never be opened. */
const ALWAYS_OPEN = new Set(['/pin', '/pin/unlock', '/health', '/version']);

const isFourDigits = (value) => typeof value === 'string' && /^\d{4}$/.test(value);

function hash(pin, salt) {
  return scryptSync(pin, salt, 32).toString('hex');
}

export function createConnectionPin({
  dataDir = DATA_DIR,
  now = () => Date.now(),
  log = console.log,
} = {}) {
  /** Issued sessions, keyed by a HASH of the token, and surviving a restart. */
  const sessions = new Map();

  /** Failed attempts stay in memory: a restart clearing a lockout is not worth a disk write. */
  const attempts = new Map();

  function path() {
    return join(dataDir, STORE);
  }

  /** A stored session is the hash of its token, never the token. */
  const fingerprint = (token) => createHash('sha256').update(token).digest('hex');

  function loadSessions() {
    try {
      const raw = JSON.parse(readFileSync(join(dataDir, SESSIONS), 'utf8'));
      if (!Array.isArray(raw)) return;
      const at = now();
      for (const entry of raw) {
        /** Expired ones are simply not loaded, which is also how the file gets tidied: the next write contains only what is still valid. */
        if (typeof entry?.hash === 'string' && typeof entry?.expires === 'number' && entry.expires > at) {
          sessions.set(entry.hash, entry.expires);
        }
      }
    } catch {
      /** No file, or an unreadable one, means no remembered devices - everyone is asked once more. */
    }
  }

  function saveSessions() {
    const at = now();
    const live = [...sessions].filter(([, expires]) => expires > at).map(([hash, expires]) => ({ hash, expires }));
    try {
      writeFileSync(join(dataDir, SESSIONS), `${JSON.stringify(live)}\n`, { mode: 0o600 });
    } catch (err) {
      /** A device that cannot be remembered still gets in now; it is asked again after a restart. */
      log(`[pin] could not remember this device: ${err.message}`);
    }
  }

  /** Issues a session and remembers it, returning what the browser should hold. */
  function issue() {
    const token = randomBytes(32).toString('hex');
    sessions.set(fingerprint(token), now() + SESSION_MS);
    saveSessions();
    return { token, maxAgeMs: SESSION_MS };
  }

  function forgetAll() {
    sessions.clear();
    saveSessions();
  }

  function read() {
    try {
      const raw = JSON.parse(readFileSync(path(), 'utf8'));
      if (typeof raw?.salt !== 'string' || typeof raw?.hash !== 'string') return null;
      return { enabled: raw.enabled === true, salt: raw.salt, hash: raw.hash };
    } catch {
      return null;
    }
  }

  function write(state) {
    writeFileSync(path(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }

  /** The stored state, created disabled with the default PIN the first time it is needed. */
  function state() {
    const existing = read();
    if (existing) return existing;

    const salt = randomBytes(16).toString('hex');
    const fresh = { enabled: false, salt, hash: hash(DEFAULT_PIN, salt) };
    /** Written rather than only returned, so the salt is stable: regenerating it per call would make every previously-set PIN unverifiable. */
    try {
      write(fresh);
    } catch (err) {
      log(`[pin] could not write the initial state: ${err.message}`);
    }
    return fresh;
  }

  /** Whether the gate is on at all. */
  const enabled = () => state().enabled === true;

  function sweep() {
    const at = now();
    let dropped = false;
    for (const [hash, expires] of sessions) if (expires <= at) { sessions.delete(hash); dropped = true; }
    if (dropped) saveSessions();
  }

  /** Whether this request carries a session the box issued and has not expired. */
  function unlocked(req) {
    if (!enabled()) return true;
    sweep();
    const token = cookieToken(req);
    if (token === null) return false;
    const expires = sessions.get(fingerprint(token));
    return expires !== undefined && expires > now();
  }

  /** Whether this request must be refused. */
  function blocked(req, pathname) {
    if (!enabled()) return false;
    if (ALWAYS_OPEN.has(pathname)) return false;
    if (req.method === 'GET' && !pathname.startsWith('/api/') && isAppShell(pathname)) return false;
    return !unlocked(req);
  }

  function clientKey(req) {
    return req.socket?.remoteAddress ?? 'unknown';
  }

  /** How long this client must wait, in ms. Zero when it may try now. */
  function cooldown(req) {
    const record = attempts.get(clientKey(req));
    if (!record || record.failures < MAX_ATTEMPTS) return 0;
    const until = record.at + LOCKOUT_MS * Math.min(8, record.failures - MAX_ATTEMPTS + 1);
    return Math.max(0, until - now());
  }

  /** Checks a PIN and, if it is right, issues a session. */
  function unlock(req, pin) {
    const wait = cooldown(req);
    if (wait > 0) return { ok: false, reason: 'too-many-attempts', retryInMs: wait };

    const current = state();
    const offered = Buffer.from(hash(typeof pin === 'string' ? pin : '', current.salt), 'hex');
    const expected = Buffer.from(current.hash, 'hex');
    /** Length-equal by construction, and compared without an early exit so a wrong PIN takes the same time as a right one. */
    const correct = offered.length === expected.length && timingSafeEqual(offered, expected);

    if (!correct) {
      const key = clientKey(req);
      const record = attempts.get(key) ?? { failures: 0, at: now() };
      attempts.set(key, { failures: record.failures + 1, at: now() });
      log(`[pin] wrong PIN from ${key}`);
      return { ok: false, reason: 'wrong-pin' };
    }

    attempts.delete(clientKey(req));
    return { ok: true, ...issue() };
  }

  /** Turns the gate on or off, and optionally sets the PIN. */
  function configure({ enabled: wanted, pin }) {
    const current = state();

    if (pin !== undefined && !isFourDigits(pin)) {
      return { ok: false, reason: 'pin-must-be-four-digits' };
    }

    const salt = pin === undefined ? current.salt : randomBytes(16).toString('hex');
    const next = {
      enabled: wanted === undefined ? current.enabled : wanted === true,
      salt,
      hash: pin === undefined ? current.hash : hash(pin, salt),
    };

    try {
      write(next);
    } catch (err) {
      return { ok: false, reason: 'not-saved', detail: err.message };
    }

    /** A new PIN invalidates every session: whoever had the old one should lose access. */
    if (pin !== undefined) forgetAll();

    const result = { ok: true, enabled: next.enabled };
    if (next.enabled) {
      Object.assign(result, issue());
    } else {
      forgetAll();
    }
    log(`[pin] ${next.enabled ? 'enabled' : 'disabled'}${pin === undefined ? '' : ', PIN changed'}`);
    return result;
  }

  /** What the UI needs: whether to show the setting as on, and whether to ask right now. */
  function status(req) {
    return {
      enabled: enabled(),
      required: enabled() && !unlocked(req),
      lockedOutForMs: cooldown(req),
    };
  }

  loadSessions();

  return { status, unlock, configure, blocked, unlocked, enabled, forgetAll };
}

/** The session cookie, which is what media requests can carry and a header cannot. */
export const COOKIE = 'waxcode_pin';

export function cookieToken(req) {
  const header = req.headers?.cookie;
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=') || null;
  }
  return null;
}

/** Secure only over https, or a box still on plain http could never hold a session. */
export function cookieHeader(token, maxAgeMs, secure) {
  const bits = [`${COOKIE}=${token}`, 'Path=/', `Max-Age=${Math.floor(maxAgeMs / 1000)}`, 'SameSite=Lax', 'HttpOnly'];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** True for the app's own pages, which must load so the PIN can be typed into them. */
function isAppShell(pathname) {
  if (pathname === '/' || pathname === '/index.html') return true;
  return /\.(js|css|map|png|svg|ico|woff2?|webmanifest)$/.test(pathname);
}
