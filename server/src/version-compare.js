/** Comparing release versions, for deciding whether the feed is offering something newer. */

/** Numeric parts only, so `v0.10.6` and `0.10.6` compare equal. Null for anything unparseable. */
export function parts(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when a is older, 0 when equal, positive when a is newer. */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;

  for (let i = 0; i < 3; i++) {
    /** Compared NUMERICALLY, piece by piece. */
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}
