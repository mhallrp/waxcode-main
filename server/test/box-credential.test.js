import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readConfig, ensureRegistered } from '../src/box-credential.js';

/*
 * What survives of public-cert.js. The DNS name, the certificate and the https listener were all
 * removed on 2026-10-10; this file is now only the credential the box uses to fetch updates, and
 * these are the tests from the old suite that still describe live behaviour.
 */

const temp = () => mkdtempSync(join(tmpdir(), 'waxcode-cred-'));

test('a half-written config is treated as no config, not as a broken one', () => {
  /* self-update refuses to run without BOTH id and token, so a partial file has to read as absent.
   * Treating it as present would send an Authorization header of "Bearer undefined". */
  const dir = temp();
  try {
    writeFileSync(join(dir, 'public-cert.json'), JSON.stringify({ id: 'k7q2zp' }));
    assert.equal(readConfig(dir), null, 'id without token');
    writeFileSync(join(dir, 'public-cert.json'), JSON.stringify({ token: 'abc' }));
    assert.equal(readConfig(dir), null, 'token without id');
    writeFileSync(join(dir, 'public-cert.json'), 'not json at all');
    assert.equal(readConfig(dir), null, 'not parseable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a complete config is returned, with the endpoint defaulted', () => {
  const dir = temp();
  try {
    writeFileSync(join(dir, 'public-cert.json'), JSON.stringify({ id: 'k7q2zp', token: 'abc' }));
    const config = readConfig(dir);
    assert.equal(config.id, 'k7q2zp');
    assert.equal(config.token, 'abc');
    /* Defaulted rather than required: boxes registered before this field existed still have to
     * know where to ask. */
    assert.equal(config.endpoint, 'https://www.waxcode.co');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing credential is never replaced', async () => {
  /* Re-registering would be harmless server-side - the answer is derived from the serial, so it is
   * the same one - but rewriting the file on every boot is a chance to lose it for nothing. */
  const dir = temp();
  try {
    writeFileSync(join(dir, 'public-cert.json'), JSON.stringify({ id: 'k7q2zp', token: 'abc' }));
    const before = readFileSync(join(dir, 'public-cert.json'), 'utf8');
    const config = await ensureRegistered({ dataDir: dir, log: () => {} });
    assert.equal(config.id, 'k7q2zp');
    assert.equal(readFileSync(join(dir, 'public-cert.json'), 'utf8'), before, 'untouched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an endpoint that cannot be reached gives up quietly, writing nothing', async () => {
  /* The shape of every real failure - no internet at the venue - and it has to end in "carry on
   * without updates", never a stack trace and never a half-written credential. */
  const dir = temp();
  try {
    assert.equal(await ensureRegistered({ dataDir: dir, log: () => {} }), null);
    assert.equal(existsSync(join(dir, 'public-cert.json')), false, 'nothing written on failure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
