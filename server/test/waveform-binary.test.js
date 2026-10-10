import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWaveformPeaks } from '../src/waveform-binary.js';

function decodeWaveformPeaks(buf) {
  const count = buf.readUInt16LE(0);
  const peaks = [];
  for (let i = 0; i < count; i++) {
    const offset = 2 + i * 5;
    peaks.push({
      envelope: { min: buf.readInt8(offset), max: buf.readInt8(offset + 1) },
      color: {
        low: buf.readUInt8(offset + 2),
        mid: buf.readUInt8(offset + 3),
        high: buf.readUInt8(offset + 4),
      },
    });
  }
  assert.equal(2 + count * 5, buf.length, 'decoder should consume exactly the whole buffer');
  return peaks;
}

function bucket(envelope, color) {
  return { envelope, color };
}

test('encodeWaveformPeaks round-trips bucket count, envelope min/max, and the low/mid/high colour blend', () => {
  const input = [
    bucket({ min: -128, max: 127 }, { low: 255, mid: 0, high: 0 }),
    bucket({ min: 0, max: 0 }, { low: 0, mid: 0, high: 0 }),
    bucket({ min: -5, max: 12 }, { low: 28, mid: 57, high: 170 }),
  ];
  assert.deepEqual(decodeWaveformPeaks(encodeWaveformPeaks(input)), input);
});

test('encodeWaveformPeaks handles zero buckets', () => {
  assert.deepEqual(decodeWaveformPeaks(encodeWaveformPeaks([])), []);
});

test('encodeWaveformPeaks handles a realistic full-size (300 bucket) payload', () => {
  // i % 128 === 0 would produce -0 for min, which assert.deepEqual
  // (Object.is-based) treats as distinct from 0 - not what this test
  // is actually checking, so avoid it.
  const envelope = (i) => {
    const m = i % 128;
    return { min: m === 0 ? 0 : -m, max: m };
  };
  const color = (i) => ({ low: i % 256, mid: (i * 2) % 256, high: (i * 3) % 256 });
  const input = Array.from({ length: 300 }, (_, i) => bucket(envelope(i), color(i)));
  assert.deepEqual(decodeWaveformPeaks(encodeWaveformPeaks(input)), input);
});
