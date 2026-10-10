import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, isValidVersion, compareVersions, highestVersion, bumpVersion } from '../semver.js';

test('parseVersion: a well-formed version parses into its three parts', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3 });
});

test('parseVersion: leading zeros in a component are still read as the plain number', () => {
  assert.deepEqual(parseVersion('0.01.0'), { major: 0, minor: 1, patch: 0 });
});

test('parseVersion: rejects the old bare-integer scheme outright, not as version "N.0.0"', () => {
  assert.equal(parseVersion('67'), null);
});

test('parseVersion: rejects pre-release/build-metadata suffixes - this project has no use for them', () => {
  assert.equal(parseVersion('1.2.3-beta'), null);
  assert.equal(parseVersion('1.2.3+build5'), null);
});

test('parseVersion: rejects garbage and non-strings', () => {
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion('not.a.version'), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(undefined), null);
});

test('isValidVersion mirrors parseVersion', () => {
  assert.equal(isValidVersion('1.2.3'), true);
  assert.equal(isValidVersion('67'), false);
});

test('compareVersions: orders by major first, regardless of minor/patch', () => {
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
});

test('compareVersions: falls through to minor when major is equal', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
});

test('compareVersions: falls through to patch when major and minor are equal', () => {
  assert.equal(compareVersions('1.1.2', '1.1.1'), 1);
});

test('compareVersions: equal versions compare as 0', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('compareVersions: throws on a malformed version rather than silently misordering', () => {
  assert.throws(() => compareVersions('1.2.3', '67'));
});

test('highestVersion: picks the true highest, not just the last in the list', () => {
  assert.equal(highestVersion(['1.0.0', '2.5.1', '2.4.9', '0.9.9']), '2.5.1');
});

test('highestVersion: a single-element list returns that element', () => {
  assert.equal(highestVersion(['3.1.4']), '3.1.4');
});

test('highestVersion: an empty list returns null', () => {
  assert.equal(highestVersion([]), null);
});

test('bumpVersion: patch bump increments only the patch component', () => {
  assert.equal(bumpVersion('1.2.3', 'patch'), '1.2.4');
});

test('bumpVersion: minor bump increments minor and resets patch to 0', () => {
  assert.equal(bumpVersion('1.2.3', 'minor'), '1.3.0');
});

test('bumpVersion: major bump increments major and resets minor and patch to 0', () => {
  assert.equal(bumpVersion('1.2.3', 'major'), '2.0.0');
});

test('bumpVersion: defaults to a patch bump when no bumpType is given', () => {
  assert.equal(bumpVersion('1.2.3'), '1.2.4');
});

test('bumpVersion: with no current version (the very first release ever), bumps from an implicit 0.0.0 baseline', () => {
  assert.equal(bumpVersion(null, 'patch'), '0.0.1');
  assert.equal(bumpVersion(null, 'minor'), '0.1.0');
  assert.equal(bumpVersion(undefined, 'major'), '1.0.0');
});

test('bumpVersion: rejects an unknown bump type', () => {
  assert.throws(() => bumpVersion('1.2.3', 'banana'));
});

test('bumpVersion: rejects a malformed current version', () => {
  assert.throws(() => bumpVersion('67', 'patch'));
});
