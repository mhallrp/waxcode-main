/** Compact binary encoding for waveform peak data sent to a client */
export function encodeWaveformPeaks(peaks) {
  const buf = Buffer.alloc(2 + peaks.length * 5);
  buf.writeUInt16LE(peaks.length, 0);
  peaks.forEach(({ envelope, color }, i) => {
    const offset = 2 + i * 5;
    buf.writeInt8(envelope.min, offset);
    buf.writeInt8(envelope.max, offset + 1);
    buf.writeUInt8(color.low, offset + 2);
    buf.writeUInt8(color.mid, offset + 3);
    buf.writeUInt8(color.high, offset + 4);
  });
  return buf;
}

/** A PARTIAL waveform: only the buckets decoded since the last one, prefixed with where they belong. */
export function encodeWaveformDelta(startBucket, peaks) {
  const buf = Buffer.alloc(4 + peaks.length * 5);
  buf.writeUInt16LE(startBucket, 0);
  buf.writeUInt16LE(peaks.length, 2);
  peaks.forEach(({ envelope, color }, i) => {
    const offset = 4 + i * 5;
    buf.writeInt8(envelope.min, offset);
    buf.writeInt8(envelope.max, offset + 1);
    buf.writeUInt8(color.low, offset + 2);
    buf.writeUInt8(color.mid, offset + 3);
    buf.writeUInt8(color.high, offset + 4);
  });
  return buf;
}
