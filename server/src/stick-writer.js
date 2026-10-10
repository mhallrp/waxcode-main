import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';
import { SUPPORTED_EXTENSIONS } from './library-scan.js';

/** Adds folders and tracks to a USB stick, from the browser. */

/** Never fill a stick completely - a FAT with no room to grow is how one gets corrupted. */
const RESERVE_BYTES = 32 * 1024 * 1024;

/** Flushed this often while receiving, so progress means bytes on the stick rather than in a cache. */
const FLUSH_EVERY_BYTES = 8 * 1024 * 1024;

/** Resolves `segments` under `mountPath`, or null if that escapes it. */
export function safeUnder(mountPath, ...segments) {
  const base = resolve(mountPath);
  const target = resolve(base, ...segments.filter((s) => typeof s === 'string' && s.length > 0));
  const within = relative(base, target);
  if (within.startsWith('..') || resolve(base, within) !== target) return null;
  return target;
}

/** Keeps what somebody called a folder, minus what a filesystem will not take. */
export function safeFolderName(raw) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/\\<>:"|?*]/g, '-')
    .replace(/^[.\s]+/, '')
    .trim()
    .slice(0, 100);
  return name || null;
}

export function createStickWriter({ stickStorage } = {}) {
  function freeBytes(mountPath) {
    try {
      const stat = statfsSync(mountPath);
      return stat.bavail * stat.bsize;
    } catch {
      /* Unknown free space is treated as none: guessing generously is how a stick fills up. */
      return 0;
    }
  }

  /** Creates one folder inside `parent`, which is itself relative to the stick's root. */
  async function makeFolder(mountPath, parentSegments, rawName) {
    const name = safeFolderName(rawName);
    if (!name) throw Object.assign(new Error('that is not a usable folder name'), { status: 400 });

    const target = safeUnder(mountPath, ...parentSegments, name);
    if (!target) throw Object.assign(new Error('that folder is not on this stick'), { status: 400 });

    const made = await stickStorage.withWritableStick(mountPath, async () => {
      mkdirSync(target, { recursive: true });
      return true;
    }).catch(() => false);

    if (!made) throw Object.assign(new Error('that stick would not take a new folder'), { status: 507 });
    return { name };
  }

  /** Streams one track onto the stick. */
  async function addTrack(mountPath, parentSegments, rawName, readable, { declaredBytes = null } = {}) {
    const name = safeFolderName(rawName);
    if (!name || !SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase())) {
      throw Object.assign(new Error('that is not a file this box can play'), { status: 415 });
    }

    const target = safeUnder(mountPath, ...parentSegments, name);
    if (!target) throw Object.assign(new Error('that folder is not on this stick'), { status: 400 });

    const room = freeBytes(mountPath) - RESERVE_BYTES;
    if (declaredBytes !== null && declaredBytes > room) {
      throw Object.assign(new Error('there is not enough room on that stick'), { status: 507 });
    }

    return stickStorage.withWritableStick(mountPath, async () => {
      mkdirSync(join(target, '..'), { recursive: true });
      const partial = `${target}.waxcode-part`;
      const handle = await open(partial, 'w');
      let written = 0;
      let flushed = 0;

      try {
        for await (const chunk of readable) {
          written += chunk.length;
          if (written > room) {
            throw Object.assign(new Error('there is not enough room on that stick'), { status: 507 });
          }
          await handle.write(chunk);
          if (written - flushed >= FLUSH_EVERY_BYTES) {
            await handle.datasync();
            flushed = written;
          }
        }
        await handle.datasync();
        await handle.close();
        renameSync(partial, target);
        console.log(`[stick] wrote ${name} (${Math.round(written / 1e6)}MB)`);
        return { name, bytes: written, path: target };
      } catch (err) {
        await handle.close().catch(() => {});
        /** The partial goes while the stick is still writable */
        rmSync(partial, { force: true });
        throw err;
      }
    });
  }

  /** Removes one track from the stick. */
  async function removeTrack(mountPath, relativePath) {
    const segments = String(relativePath ?? '').split('/').filter(Boolean);
    const target = segments.length ? safeUnder(mountPath, ...segments) : null;
    if (!target) throw Object.assign(new Error('that file is not on this stick'), { status: 400 });
    if (!SUPPORTED_EXTENSIONS.has(extname(target).toLowerCase())) {
      throw Object.assign(new Error('that is not a track'), { status: 400 });
    }

    const gone = await stickStorage.withWritableStick(mountPath, async () => {
      if (!existsSync(target)) throw Object.assign(new Error('there is no such track'), { status: 404 });
      rmSync(target, { force: true });
      console.log(`[stick] deleted ${segments.join('/')}`);
      return true;
    });
    return { removed: gone };
  }

  /** Removes an EMPTY folder, and only an empty one. */
  async function removeFolder(mountPath, relativePath) {
    const segments = String(relativePath ?? '').split('/').filter(Boolean);
    const target = segments.length ? safeUnder(mountPath, ...segments) : null;
    if (!target) throw Object.assign(new Error('that folder is not on this stick'), { status: 400 });

    return stickStorage.withWritableStick(mountPath, async () => {
      const left = readdirSync(target).filter((name) => !name.startsWith('.'));
      if (left.length > 0) {
        throw Object.assign(
          new Error('that folder still has things in it - empty it first'),
          { status: 409 },
        );
      }
      rmSync(target, { recursive: true, force: true });
      console.log(`[stick] deleted folder ${segments.join('/')}`);
      return { removed: true };
    });
  }

  return { makeFolder, addTrack, removeTrack, removeFolder };
}


