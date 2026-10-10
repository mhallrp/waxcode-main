import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

/** The password for the box's own setup network - absent until somebody sets one, and the setup network is OPEN until they do. */

/** WPA2-PSK's own floor. Below this nmcli refuses the profile and no AP comes up at all. */
export const MIN_AP_PASSWORD_LENGTH = 8;
const MAX_AP_PASSWORD_LENGTH = 63; // WPA2-PSK passphrase ceiling

export function createApPassword({ dataDir = DATA_DIR } = {}) {
  const path = join(dataDir, 'ap-password');

  /** The stored password, or null meaning "the setup network is open". */
  function get() {
    try {
      if (!existsSync(path)) return null;
      const stored = readFileSync(path, 'utf8').trim();
      return isUsable(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  return {
    get,

    /** True while the setup network is still open, which is what the portal gates on. */
    isOpen() {
      return get() === null;
    },

    /** Stores one. */
    set(value) {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return { ok: false, reason: 'no-password', field: 'apPassword' };
      if (trimmed.length < MIN_AP_PASSWORD_LENGTH) {
        return { ok: false, reason: 'too-short', field: 'apPassword' };
      }
      if (trimmed.length > MAX_AP_PASSWORD_LENGTH) {
        return { ok: false, reason: 'too-long', field: 'apPassword' };
      }
      // Anything outside printable ASCII cannot be reliably typed back in on a phone keyboard
      if (!/^[\x20-\x7e]+$/.test(trimmed)) {
        return { ok: false, reason: 'unsupported-characters', field: 'apPassword' };
      }
      mkdirSync(dataDir, { recursive: true });
      // 0600: not much of a secret, but not world-readable either.
      writeFileSync(path, `${trimmed}\n`, { mode: 0o600 });
      return { ok: true };
    },
  };
}

function isUsable(value) {
  return typeof value === 'string'
    && value.length >= MIN_AP_PASSWORD_LENGTH
    && value.length <= MAX_AP_PASSWORD_LENGTH;
}
