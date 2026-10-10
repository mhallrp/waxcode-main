import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'box-name.txt');

/** Which box this is - for the person supporting it, not for the person using it. */
export function createBoxIdentity({ storagePath = DEFAULT_PATH, cpuinfoPath = '/proc/cpuinfo' } = {}) {
  function serial() {
    try {
      const line = readFileSync(cpuinfoPath, 'utf8').split('\n').find((l) => l.startsWith('Serial'));
      return line?.split(':')[1]?.trim() || null;
    } catch {
      return null;
    }
  }

  function name() {
    try {
      return readFileSync(storagePath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  return {
    serial,
    name,

    setName(value) {
      const trimmed = String(value ?? '').trim().slice(0, 64);
      if (!trimmed) return null;
      mkdirSync(dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, `${trimmed}\n`);
      return trimmed;
    },

    /** Merged into whatever is being reported, so a box always says which one it is. */
    describe() {
      return { serial: serial(), name: name() };
    },
  };
}
