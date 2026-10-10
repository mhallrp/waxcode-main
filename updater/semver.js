// A tiny semver-lite comparator/bumper - deliberately no external dependency for something this small.

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(version) {
  const match = typeof version === 'string' ? VERSION_PATTERN.exec(version) : null;
  if (!match) return null;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function isValidVersion(version) {
  return parseVersion(version) !== null;
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on a malformed version - callers should validate first, eg. via isValidVersion. */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`compareVersions: not a valid MAJOR.MINOR.PATCH version (${a}, ${b})`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

/** The highest version in a list, or null for an empty list. */
export function highestVersion(versions) {
  return versions.reduce((highest, version) => (highest === null || compareVersions(version, highest) > 0 ? version : highest), null);
}

/** Bumps `current` (or "0.0.0" as the implicit baseline if this is the very first release ever, ie. */
export function bumpVersion(current, bumpType = 'patch') {
  const base = current === null || current === undefined ? { major: 0, minor: 0, patch: 0 } : parseVersion(current);
  if (!base) throw new Error(`bumpVersion: "${current}" is not a valid MAJOR.MINOR.PATCH version`);

  switch (bumpType) {
    case 'major':
      return `${base.major + 1}.0.0`;
    case 'minor':
      return `${base.major}.${base.minor + 1}.0`;
    case 'patch':
      return `${base.major}.${base.minor}.${base.patch + 1}`;
    default:
      throw new Error(`bumpVersion: unknown bump type "${bumpType}" - expected "major", "minor", or "patch"`);
  }
}
