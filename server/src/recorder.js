import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, statfsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './box-paths.js';

const FFMPEG_PATH = '/usr/bin/ffmpeg';

/** Physical port 1 on the new enclosure - see pi/asound.conf, which explains why that is channels 0-1. */
export const RECORD_DEVICE = 'dvs_record_capture';

/** Its own fixed-size volume, not a directory on root - see pi/recordings-volume.sh. */
const RECORDINGS_DIR = join(DATA_DIR, 'recordings');

/** MP3 rather than the lossless FLAC this originally recorded. */
const BITRATE = '320k';

/** 320kbps is 40KB/s. Used to turn free space into an honest "hours left" rather than a byte count. */
const BYTES_PER_SECOND = 40 * 1000;

/** Headroom for filesystem overhead, so the limit is reached as a clean stop rather than ENOSPC. */
const RESERVE_BYTES = 32 * 1024 * 1024;

/** Refuse to start below this - a recording that dies seconds in is worse than one that never began. */
const MIN_FREE_BYTES = 64 * 1024 * 1024;

const EXTENSION = '.mp3';

export function createRecorder({
  spawnFn = spawn,
  recordingsDir = RECORDINGS_DIR,
  device = RECORD_DEVICE,
  /** Called whenever recording ends without being asked to - hitting the size limit, or ffmpeg dying. */
  onEndedByItself = () => {},
} = {}) {
  let current = null;   // { name, path, startedAt, process, limitBytes }
  /** A copy in flight: { copied, total }. Reported in status, so the existing poll drives a bar. */
  let exporting = null;

  function freeBytes() {
    try {
      const stat = statfsSync(recordingsDir);
      return stat.bavail * stat.bsize;
    } catch {
      return 0;
    }
  }

  function totalBytes() {
    try {
      const stat = statfsSync(recordingsDir);
      return stat.blocks * stat.bsize;
    } catch {
      return 0;
    }
  }

  /** The one recording on the volume, or null. */
  function existing() {
    try {
      const files = readdirSync(recordingsDir).filter((f) => f.endsWith(EXTENSION)).sort();
      if (files.length === 0) return null;
      const name = files[files.length - 1];
      const path = join(recordingsDir, name);
      const stat = statSync(path);
      return { name, path, bytes: stat.size, recordedAt: stat.mtimeMs };
    } catch {
      return null;
    }
  }

  function status() {
    const free = freeBytes();
    const file = existing();
    return {
      recording: current !== null,
      name: current?.name ?? file?.name ?? null,
      // Derived from the clock rather than tracked, so it stays right at any moment without a timer.
      elapsedSeconds: current ? Math.floor((Date.now() - current.startedAt) / 1000) : 0,
      bytes: file?.bytes ?? 0,
      freeBytes: free,
      totalBytes: totalBytes(),
      /** What the remaining space is actually worth to someone about to record a set. */
      remainingSeconds: Math.max(0, Math.floor((free - RESERVE_BYTES) / BYTES_PER_SECOND)),
      hasRecording: file !== null,
      /** Non-null only while a copy is running. */
      exporting: exporting ? { ...exporting } : null,
    };
  }

  /** Starts recording, replacing whatever was there. */
  function start(name = defaultName()) {
    if (current) throw new Error('Already recording.');

    mkdirSync(recordingsDir, { recursive: true });
    const free = freeBytes();
    if (free < MIN_FREE_BYTES) {
      throw new Error('Not enough space on the recording volume.');
    }

    const previous = existing();
    if (previous) {
      rmSync(previous.path, { force: true });
      console.log(`[recorder] replaced ${previous.name}`);
    }

    const fileName = `${name}${EXTENSION}`;
    const path = join(recordingsDir, fileName);
    // Recomputed after the delete above, so the space the old recording held is counted.
    const limitBytes = Math.max(0, freeBytes() - RESERVE_BYTES);

    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'alsa', '-ac', '2', '-ar', '48000', '-i', device,
      '-c:a', 'libmp3lame', '-b:a', BITRATE,
      // Enforced by ffmpeg rather than by us watching the file: a poll can overshoot between ticks
      '-fs', String(limitBytes),
      path,
    ];

    const proc = spawnFn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.once('error', (err) => {
      console.log(`[recorder] failed to start: ${err.message}`);
      current = null;
    });

    proc.once('close', (code) => {
      const wasRecording = current !== null;
      current = null;
      if (!wasRecording) return;   // a deliberate stop already cleared it

      onEndedByItself();

      // Hitting -fs is a normal, expected end, not a failure - say which happened.
      const file = existing();
      if (file && file.bytes >= limitBytes - BYTES_PER_SECOND) {
        console.log(`[recorder] stopped: reached the ${Math.round(limitBytes / 1024 / 1024)}MB limit`);
      } else if (code !== 0) {
        console.log(`[recorder] ffmpeg exited ${code}: ${stderr.trim()}`);
      }
    });

    current = { name: fileName, path, startedAt: Date.now(), process: proc, limitBytes };
    console.log(`[recorder] recording to ${path} (limit ${Math.round(limitBytes / 1024 / 1024)}MB)`);
    return fileName;
  }

  /** SIGINT rather than SIGKILL, so ffmpeg finalises the file instead of leaving it truncated. */
  function stop() {
    if (!current) return null;
    const finished = current.name;
    const proc = current.process;
    current = null;
    proc.kill('SIGINT');
    console.log(`[recorder] stopped ${finished}`);
    return finished;
  }

  /** Deletes the recording. Refuses while it is being written - stop first. */
  function remove() {
    if (current) throw new Error('Stop the recording before deleting it.');
    const file = existing();
    if (!file) return false;
    rmSync(file.path, { force: true });
    console.log(`[recorder] deleted ${file.name}`);
    return true;
  }

  /** Copies the recording onto a mounted USB stick. */
  async function exportTo({ mountPath, stickStorage, freeBytesOnStick }) {
    if (current) throw new Error('Stop the recording before copying it.');

    const file = existing();
    if (!file) throw new Error('There is no recording to copy.');
    if (file.bytes === 0) throw new Error('That recording has no audio in it.');
    if (freeBytesOnStick < file.bytes) {
      throw new Error('Not enough room on the USB key for this recording.');
    }

    return stickStorage.withWritableStick(mountPath, async () => {
      const destination = join(mountPath, 'Recordings');
      mkdirSync(destination, { recursive: true });

      exporting = { copied: 0, total: file.bytes };
      const startedAt = Date.now();
      try {
        await copyWithProgress(file.path, join(destination, file.name), (copied) => {
          exporting.copied = copied;
        });
        /** Logged because a transfer that takes HOURS has been reported from a box nobody can reach, and "hours" is not a number anybody can act on. */
        const seconds = (Date.now() - startedAt) / 1000;
        const rate = seconds > 0 ? (file.bytes / 1e6 / seconds) : 0;
        console.log(`[recorder] copied ${Math.round(file.bytes / 1e6)}MB in ${seconds.toFixed(1)}s `
          + `(${rate.toFixed(1)} MB/s) to ${destination}`);
      } finally {
        exporting = null;
      }
      return { name: file.name, bytes: file.bytes, path: join('Recordings', file.name) };
    });
  }

  return { start, stop, status, existing, remove, exportTo, freeBytes };
}

/** Read and written a megabyte at a time - small enough not to matter on a 1GB box. */
const COPY_CHUNK_BYTES = 1024 * 1024;

/** Flushed to the device this often, which is the whole point of not using copyFileSync. */
const FLUSH_EVERY_BYTES = 8 * 1024 * 1024;

/** Copies a file, reporting progress that reflects what has actually reached the device. */
export async function copyWithProgress(from, to, onProgress, {
  chunkBytes = COPY_CHUNK_BYTES,
  flushEveryBytes = FLUSH_EVERY_BYTES,
} = {}) {
  const source = await open(from, 'r');
  let target;
  try {
    target = await open(to, 'w');
    const buffer = Buffer.allocUnsafe(chunkBytes);
    /** Two counters, and only the second is reported: `written` is what the kernel has accepted, `flushed` is what has reached the device. */
    let written = 0;
    let flushed = 0;

    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, chunkBytes, null);
      if (bytesRead === 0) break;
      await target.write(buffer, 0, bytesRead, null);
      written += bytesRead;

      if (written - flushed >= flushEveryBytes) {
        await target.datasync();
        flushed = written;
        onProgress(flushed);
      }
    }

    await target.datasync();
    flushed = written;
    onProgress(flushed);
  } finally {
    await source.close().catch(() => {});
    await target?.close().catch(() => {});
  }
}

/** Sortable and human-readable: "2026-08-24 09-15". Colons are illegal on the exFAT stick it may be copied to. */
export function defaultName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} `
    + `${pad(now.getHours())}-${pad(now.getMinutes())}`;
}
