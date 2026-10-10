import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

/** Testing switch: with this on, no ANALYSIS is read from or written to a cache */
export const DISABLE_CACHE_FLAG = 'disable-cache';

export function cachingDisabled() {
  return process.env.PIDVS_DISABLE_CACHE === '1' || existsSync(join(DATA_DIR, DISABLE_CACHE_FLAG));
}
