import { readFileSync, readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { RELEASES_DIR } from './box-paths.js';

/** What this box is running, in one place. */

/** The staged release the service is actually running, from the symlink its WorkingDirectory follows. */
export function serverVersion({ releasesDir = RELEASES_DIR } = {}) {
  try {
    return basename(readlinkSync(join(releasesDir, 'current')));
  } catch {
    /** No `current` means the box is running from somewhere else entirely - a hand-started server, a part-finished install. */
    return null;
  }
}

/** Which xwax commit the release carries. */
export function xwaxRevision({ releasesDir = RELEASES_DIR } = {}) {
  try {
    const text = readFileSync(join(releasesDir, 'current', 'xwax-src', 'REVISION'), 'utf8').trim();
    return text === '' ? null : text;
  } catch {
    return null;
  }
}

/** Both, for a caller that reports them together. */
export function boxVersion(options = {}) {
  return { serverVersion: serverVersion(options), xwaxRevision: xwaxRevision(options) };
}
