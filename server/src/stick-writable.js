import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Absolute path, matching the sudoers rule (pi/pidvs-sudoers-stick-remount) exactly
const MOUNT_PATH = '/usr/bin/mount';
const remountArgs = (mode, mountPoint) => ['-n', MOUNT_PATH, '-o', `remount,${mode}`, mountPoint];

/** Runs `write` with the stick temporarily writable, then puts it back. */
export async function withWritableStick(mountPoint, write, { execFileFn = execFileAsync } = {}) {
  if (!mountPoint?.startsWith('/media/pidvs/')) return false;

  try {
    await execFileFn('sudo', remountArgs('rw', mountPoint));
  } catch (err) {
    console.log(`[stick-writable] ${mountPoint} could not be made writable (${err.message.trim()}) - not saving`);
    return false;
  }

  try {
    return await write();
  } finally {
    // Always, even if the write threw - leaving a stick writable is exactly the state this exists to avoid.
    try {
      await execFileFn('sudo', remountArgs('ro', mountPoint));
    } catch (err) {
      console.log(`[stick-writable] WARNING: ${mountPoint} could not be returned to read-only: ${err.message.trim()}`);
    }
  }
}
