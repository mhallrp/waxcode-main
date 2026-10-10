import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BOX_HOME } from './box-paths.js';

/** What the xwax on THIS box can actually be told to do. */
const CANDIDATES = [join(BOX_HOME, 'bin', 'xwax'), '/usr/local/bin/xwax'];

/** The FIRST binary that exists decides. ~/bin/xwax is the updater's, and it wins where both exist. */
function runningBinary() {
  for (const path of CANDIDATES) {
    try {
      return readFileSync(path);
    } catch {
      /* Not this one. */
    }
  }
  return null;
}

/** Cached: the binary cannot change under a running server without the service being restarted, which is how every xwax update lands anyway. */
let cache = null;

export function xwaxUnderstands(command, { read = runningBinary } = {}) {
  if (cache === null) cache = read();
  /** Unreadable means unknown, and unknown must mean NO: assuming a capability that is not there is what makes a setting fail silently */
  if (!cache) return false;
  return cache.includes(`${command} `);
}

/** Only for tests - a real box never changes its binary without restarting the service. */
export function forgetXwaxCapabilities() {
  cache = null;
}
