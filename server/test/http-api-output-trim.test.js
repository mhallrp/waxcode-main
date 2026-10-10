import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/http-api.js';
import { createOutputTrim } from '../src/output-trim.js';

async function withServer(opts, fn) {
  const tmp = mkdtempSync(join(tmpdir(), 'trim-route-'));
  const server = createServer({ pairingStoragePath: join(tmp, 'p.json'), xwaxCan: () => true, ...opts });
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try { await fn(`http://localhost:${port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

test('GET /output-trim answers with the stored value and range', async () => {
  const outputTrim = createOutputTrim({ dataDir: mkdtempSync(join(tmpdir(), 'ot-')) });
  await withServer({ outputTrim }, async (base) => {
    const res = await fetch(`${base}/output-trim`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { available: true, db: 0, min: -20, max: 0 });
  });
});

test('POST /output-trim stores it and pushes it at the running decks', async () => {
  const outputTrim = createOutputTrim({ dataDir: mkdtempSync(join(tmpdir(), 'ot-')) });
  const pushed = [];
  await withServer({ outputTrim, applyOutputTrim: async (m) => { pushed.push(m); } }, async (base) => {
    const res = await fetch(`${base}/output-trim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ db: -6 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).db, -6);
  });
  assert.equal(pushed.length, 1);
  assert.ok(Math.abs(pushed[0] - 0.5012) < 0.001, `multiplier was ${pushed[0]}`);
});

test('an old xwax reports unavailable, so the UI can hide the slider', async () => {
  const outputTrim = createOutputTrim({ dataDir: mkdtempSync(join(tmpdir(), 'ot-')) });
  await withServer({ outputTrim, xwaxCan: () => false }, async (base) => {
    assert.equal((await (await fetch(`${base}/output-trim`)).json()).available, false);
  });
});

test('a non-numeric db is refused', async () => {
  const outputTrim = createOutputTrim({ dataDir: mkdtempSync(join(tmpdir(), 'ot-')) });
  await withServer({ outputTrim }, async (base) => {
    const res = await fetch(`${base}/output-trim`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ db: 'loud' }),
    });
    assert.equal(res.status, 400);
  });
});
