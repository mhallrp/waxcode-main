import { cachingDisabled } from './cache-mode.js';
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';

const STORE_PATH = '.waxcode/analysis/waveforms.bin';
const MAGIC = 'WXWF';
const SUPPORTED_CONTAINER_VERSION = 1;

/** Reads a packed waveform file, if a stick carries one. */
export function openStickWaveforms(rootDir, { formatVersion }) {
  if (cachingDisabled()) return null;
  const path = join(rootDir, STORE_PATH);
  if (!existsSync(path)) return null;

  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }

  try {
    const header = Buffer.alloc(10);
    if (readSync(fd, header, 0, 10, 0) !== 10) return null;
    if (header.subarray(0, 4).toString('utf8') !== MAGIC) return null;
    if (header.readUInt8(4) !== SUPPORTED_CONTAINER_VERSION) return null;

    const storedFormat = header.readUInt8(5);
    if (storedFormat !== formatVersion) {
      console.log(`[stick-waveforms] ${STORE_PATH} was written for waveform format v${storedFormat}, this box is on v${formatVersion} - ignoring it`);
      return null;
    }

    const entryCount = header.readUInt32LE(6);
    const fileSize = statSync(path).size;
    const index = new Map();

    // Walk the entry headers only, seeking past each payload - the point of indexing rather than reading the whole file.
    let offset = 10;
    const scratch = Buffer.alloc(4);
    for (let i = 0; i < entryCount; i++) {
      if (readSync(fd, scratch, 0, 2, offset) !== 2) break;
      const pathLength = scratch.readUInt16LE(0);
      offset += 2;

      const pathBuf = Buffer.alloc(pathLength);
      if (readSync(fd, pathBuf, 0, pathLength, offset) !== pathLength) break;
      const relativePath = pathBuf.toString('utf8');
      offset += pathLength;

      if (readSync(fd, scratch, 0, 4, offset) !== 4) break;
      const blobLength = scratch.readUInt32LE(0);
      offset += 4;

      if (offset + blobLength > fileSize) break;
      index.set(relativePath, { offset, length: blobLength });
      offset += blobLength;
    }

    console.log(`[stick-waveforms] ${index.size} precomputed waveforms available from ${STORE_PATH}`);

    return {
      size: index.size,

      /** The complete cache-file bytes for one track, or null if this stick doesn't have it. */
      read(relativePath) {
        const entry = index.get(relativePath);
        if (!entry) return null;
        try {
          const handle = openSync(path, 'r');
          try {
            const blob = Buffer.alloc(entry.length);
            return readSync(handle, blob, 0, entry.length, entry.offset) === entry.length ? blob : null;
          } finally {
            closeSync(handle);
          }
        } catch {
          return null;
        }
      },
    };
  } catch (err) {
    console.log(`[stick-waveforms] couldn't index ${STORE_PATH}, ignoring it: ${err.message}`);
    return null;
  } finally {
    closeSync(fd);
  }
}
