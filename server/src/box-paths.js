import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where this box keeps its own files. */
export const BOX_HOME = process.env.PIDVS_HOME || homedir();

/** Shared state that survives updates - release-manager.js symlinks this into every release. */
export const DATA_DIR = join(BOX_HOME, 'data');

/** Staged releases, and the `current` symlink the service's WorkingDirectory follows. */
export const RELEASES_DIR = join(BOX_HOME, 'releases');

/** Ships separately from the release tarball, so it lives outside the releases tree. */
export const UPDATER_CLI = join(BOX_HOME, 'updater', 'cli.js');
