import { mkdirSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { DATA_DIR } from './box-paths.js';
import { SUPPORTED_EXTENSIONS } from './library-scan.js';
import { forgetCachedAnalysis } from './waveform-cache.js';

/** Tracks sent straight from a laptop, staged just long enough to be played. */
export const UPLOADS_DIR = join(DATA_DIR, 'uploads');

/** How much staged audio is allowed at once - about 15 tracks, far more than a staging area needs. */
const BUDGET_BYTES = 1024 * 1024 * 1024;

/** Never spent, whatever the budget allows. A full rootfs is a box somebody has to physically fetch. */
const RESERVE_BYTES = 512 * 1024 * 1024;

/** One track's ceiling. A 20-minute flac is about 200MB; this is loose enough not to be the thing that bites. */
const MAX_FILE_BYTES = 500 * 1024 * 1024;

/** Flushed this often while receiving - see copyWithProgress, same reason on a 1GB box. */
const FLUSH_EVERY_BYTES = 8 * 1024 * 1024;

/** Keeps a filename that is safe to write and still recognisable. */
export function safeName(raw) {
  const base = String(raw ?? '').split(/[/\\]/).pop() ?? '';
  const extension = extname(base).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) return null;

  const stem = base.slice(0, base.length - extension.length)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/^[-.\s]+/, '')
    .trim()
    .slice(0, 120);

  return stem ? `${stem}${extension}` : null;
}

export function createUploads({
  dir = UPLOADS_DIR,
  budgetBytes = BUDGET_BYTES,
  reserveBytes = RESERVE_BYTES,
  maxFileBytes = MAX_FILE_BYTES,
  /** Injected so a test can assert the cache is cleared without owning a real cache directory. */
  forgetAnalysis = (path) => forgetCachedAnalysis('', path),
} = {}) {
  mkdirSync(dir, { recursive: true });

  /** Newest last, which is the order eviction wants. Mtime, not name - names are the person's. */
  function entries() {
    try {
      return readdirSync(dir)
        .filter((name) => SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase()))
        .map((name) => {
          const stat = statSync(join(dir, name));
          return { name, path: join(dir, name), bytes: stat.size, at: stat.mtimeMs };
        })
        .sort((a, b) => a.at - b.at);
    } catch {
      return [];
    }
  }

  const usedBytes = () => entries().reduce((total, entry) => total + entry.bytes, 0);

  function freeBytes() {
    try {
      const stat = statfsSync(dir);
      return stat.bavail * stat.bsize;
    } catch {
      /* Unknown free space is treated as none. Guessing generously here is how a card fills up. */
      return 0;
    }
  }

  /** Spendable now: whichever of the budget and the card's real free space is tighter. */
  function availableBytes() {
    return Math.max(0, Math.min(budgetBytes - usedBytes(), freeBytes() - reserveBytes));
  }

  /** Drops oldest-first until `wanted` would fit inside the budget. Never touches the reserve. */
  function evictFor(wanted) {
    const existing = entries();
    let used = existing.reduce((total, entry) => total + entry.bytes, 0);
    const evicted = [];
    for (const entry of existing) {
      if (used + wanted <= budgetBytes) break;
      rmSync(entry.path, { force: true });
      used -= entry.bytes;
      evicted.push(entry.name);
    }
    if (evicted.length > 0) console.log(`[uploads] evicted ${evicted.join(', ')} to make room`);
    return evicted;
  }

  /** Streams one track in, reporting what has reached the card. */
  async function receive(readable, rawName, { declaredBytes = null, onProgress = () => {} } = {}) {
    const name = safeName(rawName);
    if (!name) throw Object.assign(new Error('That is not a file this box can play.'), { status: 415 });
    if (declaredBytes !== null && declaredBytes > maxFileBytes) {
      throw Object.assign(new Error('That file is too large to send.'), { status: 413 });
    }

    if (declaredBytes !== null) evictFor(declaredBytes);
    if (declaredBytes !== null && declaredBytes > availableBytes()) {
      throw Object.assign(new Error('There is not enough room on the box for that file.'), { status: 507 });
    }

    /** Written under a temporary name and renamed once whole. */
    const path = join(dir, name);
    const partial = `${path}.part`;
    const handle = await open(partial, 'w');
    let written = 0;
    let flushed = 0;

    try {
      for await (const chunk of readable) {
        written += chunk.length;
        if (written > maxFileBytes) {
          throw Object.assign(new Error('That file is too large to send.'), { status: 413 });
        }
        await handle.write(chunk);
        if (written - flushed >= FLUSH_EVERY_BYTES) {
          await handle.datasync();
          flushed = written;
          onProgress(flushed);
        }
      }
      await handle.datasync();
      await handle.close();
      rmSync(path, { force: true });
      renameSync(partial, path);
      onProgress(written);
      console.log(`[uploads] received ${name} (${Math.round(written / 1e6)}MB)`);
      return { name, path, bytes: written };
    } catch (err) {
      await handle.close().catch(() => {});
      rmSync(partial, { force: true });
      throw err;
    }
  }

  /** Deletes a staged file AND the analysis computed from it. */
  function drop(path) {
    // recursive, because clearAll sweeps whatever is in the directory, not only files it wrote.
    rmSync(path, { force: true, recursive: true });
    forgetAnalysis(path);
  }

  function remove(rawName) {
    const name = safeName(rawName);
    if (!name) return false;
    const path = join(dir, name);
    if (!entries().some((entry) => entry.name === name)) return false;
    drop(path);
    console.log(`[uploads] deleted ${name}`);
    return true;
  }

  /** Empties the staging area, and is called on every start. */
  function clearAll() {
    let removed = 0;
    try {
      for (const name of readdirSync(dir)) {
        drop(join(dir, name));
        removed += 1;
      }
    } catch { /* nothing staged, or nowhere to stage - either way there is nothing to clear */ }
    heldBy.clear();
    if (removed > 0) console.log(`[uploads] cleared ${removed} staged file(s) from the last session`);
    return removed;
  }

  /** Which deck is holding which staged file, so one can be dropped the moment nothing needs it. */
  const heldBy = new Map();

  /** Records that a deck now holds `path`, and deletes whatever it held before. */
  function claim(deckNumber, path) {
    const previous = heldBy.get(deckNumber) ?? null;
    const now = path && path.startsWith(`${dir}/`) ? path : null;
    if (now) heldBy.set(deckNumber, now); else heldBy.delete(deckNumber);
    if (!previous || previous === now) return false;

    // Both decks can be playing the same sent file; the last one to let go is the one that deletes it.
    const stillWanted = [...heldBy.values()].includes(previous);
    if (stillWanted) return false;
    drop(previous);
    console.log(`[uploads] dropped ${basename(previous)} - no deck is holding it`);
    return true;
  }

  return {
    dir,
    claim,
    entries,
    usedBytes,
    availableBytes,
    budgetBytes,
    maxFileBytes,
    receive,
    remove,
    clearAll,
    isEmpty: () => entries().length === 0,
  };
}
