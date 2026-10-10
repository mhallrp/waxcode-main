import { readFileSync } from 'node:fs';

/** MemAvailable from /proc/meminfo, in MB - the kernel's own best estimate of how much could be allocated right now without swapping */
export function getAvailableMemoryMB(readFileFn = readFileSync) {
  try {
    const meminfo = readFileFn('/proc/meminfo', 'utf8');
    const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
    if (!match) return null;
    return Number(match[1]) / 1024;
  } catch {
    return null;
  }
}
