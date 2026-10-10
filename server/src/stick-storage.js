import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MOUNT_PATH = '/bin/mount';

/** Everything this system writes to someone else's stick lives under here, and nothing outside it. */
export const STICK_DIR = '.waxcode';

/** Reads and writes small JSON files in `.waxcode/` on a mounted USB stick. */
export function createStickStorage({ execFileFn = execFileAsync } = {}) {

  function pathFor(mountPath, name) {
    return join(mountPath, STICK_DIR, name);
  }

  /** Parsed contents, or null for absent/unreadable/corrupt - all of which mean the same thing to callers. */
  function read(mountPath, name) {
    try {
      const file = pathFor(mountPath, name);
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }

  async function remount(mountPath, mode) {
    await execFileFn('sudo', ['-n', MOUNT_PATH, '-o', `remount,${mode}`, mountPath]);
  }

  /** Returns true if the data actually landed. */
  async function write(mountPath, name, data) {
    let remounted = false;
    try {
      await remount(mountPath, 'rw');
      remounted = true;

      const directory = join(mountPath, STICK_DIR);
      mkdirSync(directory, { recursive: true });
      const destination = pathFor(mountPath, name);
      const temporary = `${destination}.tmp`;
      writeFileSync(temporary, JSON.stringify(data, null, 2));
      renameSync(temporary, destination);
      return true;
    } catch {
      return false;
    } finally {
      // Back to read-only whatever happened - including when the write itself failed.
      if (remounted) {
        try { await remount(mountPath, 'ro'); } catch { /* nothing further to try */ }
      }
    }
  }

  /** Runs `body` with the stick temporarily read-write, and puts it back afterwards whatever happens */
  async function withWritableStick(mountPath, body) {
    await remount(mountPath, 'rw');
    try {
      return await body();
    } finally {
      try { await remount(mountPath, 'ro'); } catch { /* nothing further to try */ }
    }
  }

  return { read, write, pathFor, withWritableStick };
}
