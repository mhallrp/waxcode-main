import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAvailableMemoryMB } from '../src/system-memory.js';

const REAL_MEMINFO_SAMPLE = `MemTotal:        1014592 kB
MemFree:          134112 kB
MemAvailable:     388928 kB
Buffers:           15024 kB
Cached:           339168 kB
`;

test('getAvailableMemoryMB parses MemAvailable and converts kB to MB', () => {
  const result = getAvailableMemoryMB(() => REAL_MEMINFO_SAMPLE);
  assert.equal(result, 388928 / 1024);
});

test('getAvailableMemoryMB returns null if MemAvailable is missing from the file', () => {
  const result = getAvailableMemoryMB(() => 'MemTotal:        1014592 kB\nMemFree:          134112 kB\n');
  assert.equal(result, null);
});

test('getAvailableMemoryMB returns null (not throw) if the file can\'t be read - eg. non-Linux', () => {
  const result = getAvailableMemoryMB(() => { throw new Error('ENOENT'); });
  assert.equal(result, null);
});

test('getAvailableMemoryMB works against the real /proc/meminfo on this machine (or returns null off-Linux)', () => {
  const result = getAvailableMemoryMB();
  if (result === null) return; // non-Linux dev/CI machine - genuinely can't test the real path here
  assert.ok(result > 0, `expected a positive MB figure, got ${result}`);
});
