import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutputTrim, trimMultiplier, MIN_TRIM_DB, MAX_TRIM_DB } from '../src/output-trim.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'output-trim-'));

test('defaults to 0dB - the level every release before this one played at', () => {
  const store = createOutputTrim({ dataDir: tempDir() });
  assert.equal(store.get(), 0);
  assert.equal(store.multiplier(), 1);
});

test('remembers a setting across a restart', () => {
  const dataDir = tempDir();
  createOutputTrim({ dataDir }).set(-6);

  // A fresh instance is what a server restart looks like.
  assert.equal(createOutputTrim({ dataDir }).get(), -6);
});

test('clamps to the published range rather than trusting the caller', () => {
  const store = createOutputTrim({ dataDir: tempDir() });
  assert.equal(store.set(-40), MIN_TRIM_DB);
  assert.equal(store.set(12), MAX_TRIM_DB);
});

test('refuses to go above 0dB, because xwax cannot deliver it', () => {
  // The clamp on target_volume means a multiplier over 1.0 buys at most 1.16dB and then stops.
  // Offering a boost in the UI would be offering something the engine will not do.
  const store = createOutputTrim({ dataDir: tempDir() });
  assert.equal(store.set(6), 0);
  assert.equal(store.multiplier(), 1);
});

test('rounds to half a decibel', () => {
  const store = createOutputTrim({ dataDir: tempDir() });
  assert.equal(store.set(-6.3), -6.5);
  assert.equal(store.set(-6.1), -6);
});

test('a value that is not a number falls back to 0dB rather than NaN', () => {
  const store = createOutputTrim({ dataDir: tempDir() });
  assert.equal(store.set('loud'), 0);
  assert.equal(store.set(Number.NaN), 0);
  assert.equal(store.set(Number.POSITIVE_INFINITY), 0);
});

test('an unreadable file reads back as 0dB, not as a crash', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'output-trim.json'), 'not json at all');
  assert.equal(createOutputTrim({ dataDir }).get(), 0);
});

test('decibels convert to the multiplier xwax expects', () => {
  // Checked against the definition, not against the implementation: -6dB is half the amplitude.
  assert.equal(trimMultiplier(0), 1);
  assert.ok(Math.abs(trimMultiplier(-6) - 0.5) < 0.002);
  assert.ok(Math.abs(trimMultiplier(-20) - 0.1) < 1e-9);
  assert.ok(Math.abs(trimMultiplier(-12) - 0.25) < 0.002);
});
