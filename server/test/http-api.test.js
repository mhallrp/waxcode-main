import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer as createSocketServer } from 'node:net';
import { Readable } from 'node:stream';
import { createServer, isOverWifi, isLocal, isOnSetupNetwork } from '../src/http-api.js';
import { createUploads, safeName } from '../src/uploads.js';
import { deckSocketPath } from '../src/xwax-status.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, 'fixtures');

async function withServer(fn, { deckCount, mountRoot, labelDir, uuidDir, readMountsFn, execFileFn, onTrackScanned, onFastScan, isWaveformCachedFn, cachedPathCheckerFn, deckStatusRegistry, wifiProvisioning, wifiMode, boxIdentity, apPassword, deckTimecode, recorder, deckControl, uploads, xwaxCan, devices, trackOrder, stickWriter, supportTunnel } = {}) {
  // A throwaway pairing store per server instance - otherwise every test run would read/write the real on-disk store.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-test-'));
  const server = createServer({
    pairingStoragePath: join(tmpDir, 'pairing-tokens.json'), deckCount, mountRoot, labelDir, uuidDir, readMountsFn, execFileFn, onTrackScanned, onFastScan, isWaveformCachedFn, cachedPathCheckerFn, deckStatusRegistry, wifiProvisioning, wifiMode, boxIdentity, apPassword, deckTimecode, recorder, deckControl,
    uploads: uploads ?? createUploads({ dir: join(tmpDir, 'uploads') }),
    // Default to a box whose audio engine IS current; the old-box path says so explicitly.
    xwaxCan: xwaxCan ?? (() => true),
    devices,
    trackOrder,
    stickWriter,
    supportTunnel,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://localhost:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function pair(base) {
  const res = await fetch(`${base}/pair`, { method: 'POST' });
  const { token } = await res.json();
  return token;
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

// /scan responds immediately and scans in the background - poll /library until scanning flips back to false, same as the app itself does.
async function waitForScanComplete(base, token, deviceId) {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${base}/library`, { headers: authHeaders(token) });
    const body = await res.json();
    const device = body.devices.find((d) => d.id === deviceId);
    if (device && !device.scanning) return device;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('scan did not finish in time');
}

test('GET /status reports the right shape, deriving ready from per-deck state', async () => {
  // Deliberately doesn't assert a specific true/false value - deck 1's socket may or may not exist depending on the machine. isDeckReady's
  // own true/false behavior is covered directly in xwax-status.test.js; this just confirms /status wires it through correctly.
  await withServer(async (base) => {
    const res = await fetch(`${base}/status`);
    const body = await res.json();
    assert.equal(typeof body.ready, 'boolean');
    assert.equal(typeof body.decks[1], 'boolean');
    assert.equal(body.ready, body.decks[1]);
  });
});

test('GET /library needs no token - the HTTP surface is open on the network', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/library`);
    assert.equal(res.status, 200);
  });
});

test('GET /library ignores a bogus token rather than rejecting it', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/library`, { headers: authHeaders('not-a-real-token') });
    assert.equal(res.status, 200);
  });
});

test('GET /library reports an empty devices list before any scan', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/library`, { headers: authHeaders(token) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { devices: [] });
  });
});

test('POST /scan responds immediately with an empty, scanning device entry', async () => {
  await withServer(async (base) => {
    // No token on the /scan call - mirrors how pi/usb-mount.sh actually calls it (loopback, see isLocal), not how the app would.
    const scanRes = await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES }),
    });
    assert.equal(scanRes.status, 200);
    const scanned = await scanRes.json();
    assert.equal(scanned.devices.length, 1);
    const [device] = scanned.devices;
    assert.equal(device.id, 'sda2');
    assert.equal(device.name, 'Test Stick');
    assert.equal(device.scanning, true);
    assert.equal(device.root, FIXTURES);
    assert.deepEqual(device.tracks, []);
  });
});

test('POST /scan carries volumeId through to the device entry, for favourites to key off', async () => {
  await withServer(async (base) => {
    const scanRes = await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'port-2', name: 'Test Stick', path: FIXTURES, volumeId: 'ABCD-1234' }),
    });
    const { devices } = await scanRes.json();
    assert.equal(devices[0].volumeId, 'ABCD-1234');
  });
});

test('POST /scan without a volumeId defaults to an empty string rather than crashing', async () => {
  await withServer(async (base) => {
    const scanRes = await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'port-2', name: 'Test Stick', path: FIXTURES }),
    });
    const { devices } = await scanRes.json();
    assert.equal(devices[0].volumeId, '');
  });
});

test('a scan streams tracks in as it finds them, then flips scanning off when done', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES }),
    });

    const token = await pair(base);
    const finished = await waitForScanComplete(base, token, 'sda2');
    assert.equal(finished.tracks.length, 7);
    assert.equal(finished.root, FIXTURES);
  });
});

test('onTrackScanned fires once per discovered track, streamed as the scan finds them (for waveform prefetching)', async () => {
  const scannedPaths = [];
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES }),
    });

    const token = await pair(base);
    const finished = await waitForScanComplete(base, token, 'sda2');

    assert.equal(scannedPaths.length, finished.tracks.length);
    assert.deepEqual(scannedPaths.sort(), finished.tracks.map((t) => t.path).sort());
  }, { onTrackScanned: (track) => scannedPaths.push(track.path) });
});

test('onTrackScanned receives volumeId and a path relative to the device root, not just the bare absolute path', async () => {
  const scannedTracks = [];
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES, volumeId: 'ABCD-1234' }),
    });

    const token = await pair(base);
    await waitForScanComplete(base, token, 'sda2');

    assert.ok(scannedTracks.length > 0);
    for (const track of scannedTracks) {
      assert.equal(track.volumeId, 'ABCD-1234');
      assert.ok(!track.relativePath.startsWith('/'), `relativePath should not include the device root: ${track.relativePath}`);
      assert.ok(track.path.endsWith(track.relativePath), `relativePath should be a suffix of the full path: ${track.relativePath} / ${track.path}`);
    }
  }, { onTrackScanned: (track) => scannedTracks.push(track) });
});

test('onFastScan fires once with the whole device file list, before onTrackScanned starts trickling in', async () => {
  const events = [];
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES, volumeId: 'ABCD-1234' }),
    });

    const token = await pair(base);
    const finished = await waitForScanComplete(base, token, 'sda2');

    assert.equal(events[0].type, 'fast');
    assert.equal(events[0].tracks.length, finished.tracks.length);
    assert.deepEqual(new Set(events[0].tracks.map((t) => t.path)), new Set(finished.tracks.map((t) => t.path)));
    for (const track of events[0].tracks) {
      assert.equal(track.volumeId, 'ABCD-1234');
      assert.ok(!track.relativePath.startsWith('/'), `relativePath should not include the device root: ${track.relativePath}`);
    }
    assert.ok(events.slice(1).every((e) => e.type === 'tracked'), 'every event after the fast scan should be a per-track onTrackScanned event');
  }, {
    onFastScan: (tracks) => events.push({ type: 'fast', tracks }),
    onTrackScanned: (track) => events.push({ type: 'tracked', track }),
  });
});

test('GET /library reports cache status per track, computed fresh on each request', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Test Stick', path: FIXTURES }),
    });

    const token = await pair(base);
    const finished = await waitForScanComplete(base, token, 'sda2');

    assert.ok(finished.tracks.length > 0);
    for (const track of finished.tracks) {
      assert.equal(track.cached, track.path.endsWith('sample.mp3'), `unexpected cached status for ${track.path}`);
    }
    /* Injected as a CHECKER BUILT PER DEVICE, not a per-track predicate. The listing reads the
     * cache directory once for the whole device rather than doing two syscalls a track, which took
     * about seven seconds on a real 3,115-track stick - see cachedPathChecker. */
  }, { cachedPathCheckerFn: () => (relativePath) => relativePath.endsWith('sample.mp3') });
});

test('POST /scan without a device or path returns 400', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('two devices scan independently and appear as separate entries', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Stick A', path: FIXTURES }),
    });
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sdb1', name: 'Stick B', path: FIXTURES }),
    });

    const token = await pair(base);
    await waitForScanComplete(base, token, 'sda2');
    await waitForScanComplete(base, token, 'sdb1');

    const res = await fetch(`${base}/library`, { headers: authHeaders(token) });
    const { devices } = await res.json();
    assert.equal(devices.length, 2);
    assert.deepEqual(devices.map((d) => d.name).sort(), ['Stick A', 'Stick B']);
    for (const device of devices) {
      assert.equal(device.tracks.length, 7);
    }
  });
});

test('a device already mounted at startup is discovered and scanned without any /scan call', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  mkdirSync(join(mountRoot, 'sda2'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  symlinkSync('../../sda2', join(labelDir, 'My Stick'));

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'sda2');
      assert.equal(device.name, 'My Stick');
      assert.equal(device.root, join(mountRoot, 'sda2'));
    }, { mountRoot, labelDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device resolves its volumeId via a by-uuid symlink, same technique as by-label', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  const uuidDir = join(tmpDir, 'by-uuid');
  mkdirSync(join(mountRoot, 'sda2'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  mkdirSync(uuidDir, { recursive: true });
  symlinkSync('../../sda2', join(uuidDir, 'ABCD-1234'));

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'sda2');
      assert.equal(device.volumeId, 'ABCD-1234');
    }, { mountRoot, labelDir, uuidDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device with no matching by-uuid symlink gets an empty volumeId, not a crash', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  const uuidDir = join(tmpDir, 'by-uuid'); // exists, but nothing points at sda2
  mkdirSync(join(mountRoot, 'sda2'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  mkdirSync(uuidDir, { recursive: true });

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'sda2');
      assert.equal(device.volumeId, '');
    }, { mountRoot, labelDir, uuidDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device with no by-uuid directory at all gets an empty volumeId, not a crash', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  const uuidDir = join(tmpDir, 'does-not-exist-by-uuid');
  mkdirSync(join(mountRoot, 'sda2'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'sda2');
      assert.equal(device.volumeId, '');
    }, { mountRoot, labelDir, uuidDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device with no matching by-label symlink falls back to its bare device id', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label'); // exists, but nothing points at sdb1
  mkdirSync(join(mountRoot, 'sdb1'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'sdb1');
      assert.equal(device.name, 'sdb1');
    }, { mountRoot, labelDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device is labelled correctly even though its port-based directory name differs from the kernel device name backing it', async () => {
  // Regression coverage: the mount root's subdirectory is now "port-3", not "sdb2", so by-label matching must resolve via /proc/mounts first.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  const mountPath = join(mountRoot, 'port-3');
  mkdirSync(mountPath, { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  symlinkSync('../../sdb2', join(labelDir, 'My Stick'));
  const readMountsFn = async () => `/dev/sdb2 ${mountPath} exfat ro,relatime 0 0\n`;

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'port-3');
      assert.equal(device.name, 'My Stick');
      assert.equal(device.root, mountPath);
    }, { mountRoot, labelDir, readMountsFn });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a stale directory nothing is actually mounted at is not reported as a device', async () => {
  // Regression coverage: a leftover directory from a previous session used to show up as a phantom device forever (directory existence alone
  // used to mean "a device is here").
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label');
  mkdirSync(join(mountRoot, 'port-1'), { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  const readMountsFn = async () => ''; // nothing actually mounted anywhere

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const res = await fetch(`${base}/library`, { headers: authHeaders(token) });
      assert.deepEqual(await res.json(), { devices: [] });
    }, { mountRoot, labelDir, readMountsFn });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an already-mounted device with no by-label match falls back to USB vendor/model via udevadm', async () => {
  // Regression coverage: a stick with no volume label used to fall back to its bare port id if already mounted at startup, even though the
  // hotplug path gives it a real vendor/model name (usb-mount.sh's get_device_name()) - this mirrors that.
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'media');
  const labelDir = join(tmpDir, 'by-label'); // exists, but nothing points at sdc1
  const mountPath = join(mountRoot, 'port-2');
  mkdirSync(mountPath, { recursive: true });
  mkdirSync(labelDir, { recursive: true });
  const readMountsFn = async () => `/dev/sdc1 ${mountPath} vfat ro,relatime 0 0\n`;
  const execFileFn = async () => ({ stdout: 'ID_VENDOR=SanDisk\nID_MODEL=Ultra_Fit\n', stderr: '' });

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const device = await waitForScanComplete(base, token, 'port-2');
      assert.equal(device.name, 'SanDisk Ultra Fit');
    }, { mountRoot, labelDir, readMountsFn, execFileFn });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a mount root that does not exist yet (first boot) is a harmless no-op', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pidvs-discover-test-'));
  const mountRoot = join(tmpDir, 'does-not-exist');
  const labelDir = join(tmpDir, 'also-does-not-exist');

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const res = await fetch(`${base}/library`, { headers: authHeaders(token) });
      assert.deepEqual(await res.json(), { devices: [] });
    }, { mountRoot, labelDir });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('POST /library/error sets an error on that device entry, local-only', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/library/error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sdc1', name: 'Weird Drive', message: 'USB drive uses an unsupported filesystem (apfs).' }),
    });
    assert.equal(res.status, 200);

    const token = await pair(base);
    const libRes = await fetch(`${base}/library`, { headers: authHeaders(token) });
    const { devices } = await libRes.json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'sdc1');
    assert.equal(devices[0].error, 'USB drive uses an unsupported filesystem (apfs).');
  });
});

test('POST /library/removed deletes only that device, leaving others intact', async () => {
  await withServer(async (base) => {
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2', name: 'Stick A', path: FIXTURES }),
    });
    await fetch(`${base}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sdb1', name: 'Stick B', path: FIXTURES }),
    });

    const token = await pair(base);
    await waitForScanComplete(base, token, 'sda2');
    await waitForScanComplete(base, token, 'sdb1');

    const removedRes = await fetch(`${base}/library/removed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'sda2' }),
    });
    assert.equal(removedRes.status, 200);

    const libRes = await fetch(`${base}/library`, { headers: authHeaders(token) });
    const { devices } = await libRes.json();
    assert.equal(devices.length, 1);
    assert.equal(devices[0].id, 'sdb1');
  });
});

/** A stub deckStatusRegistry reporting a fixed lastStatus per deck, without any real polling/socket connection - see the tests below for why. */
function fakeDeckStatusRegistry(lastStatusByDeck) {
  return {
    statusPollerFor: (deckNumber) => ({ lastStatus: lastStatusByDeck[deckNumber] ?? null }),
    stopAll: () => {},
    anyDeckPlaying: () => false,
  };
}

test('POST /library/removed unloads any deck currently loaded from that device', async () => {
  // Regression coverage for the "stuck loaded from a vanished device" bug - see DEVLOG 2026-08-04. deckStatusRegistry is faked purely to
  // control lastStatus directly; the actual UNLOAD delivery is verified against a real fake xwax socket below.
  const deckSocket = createSocketServer();
  let received = '';
  deckSocket.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => deckSocket.listen(deckSocketPath(1), resolve));

  const deckStatusRegistry = fakeDeckStatusRegistry({
    1: { state: 'STOPPED', remain: 100, pitch: 0, path: `${FIXTURES}/some-track.mp3` },
    2: { state: 'STOPPED', remain: 50, pitch: 0, path: '/media/pidvs/sdb1/other-track.mp3' },
  });

  try {
    await withServer(async (base) => {
      await fetch(`${base}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'sda2', name: 'Stick A', path: FIXTURES }),
      });

      await fetch(`${base}/library/removed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'sda2' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(received, 'UNLOAD\n');
    }, { deckCount: 2, deckStatusRegistry });
  } finally {
    deckSocket.close();
  }
});

test('POST /library/removed does not unload a deck loaded from a DIFFERENT, still-present device', async () => {
  const deckSocket = createSocketServer();
  let received = '';
  deckSocket.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => deckSocket.listen(deckSocketPath(2), resolve));

  const deckStatusRegistry = fakeDeckStatusRegistry({
    2: { state: 'STOPPED', remain: 50, pitch: 0, path: '/media/pidvs/sdb1/other-track.mp3' },
  });

  try {
    await withServer(async (base) => {
      await fetch(`${base}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'sda2', name: 'Stick A', path: FIXTURES }),
      });
      await fetch(`${base}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'sdb1', name: 'Stick B', path: '/media/pidvs/sdb1' }),
      });

      await fetch(`${base}/library/removed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: 'sda2' }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(received, '');
    }, { deckCount: 2, deckStatusRegistry });
  } finally {
    deckSocket.close();
  }
});

test('an unknown route is a 404, not an auth failure', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nonsense`);
    assert.equal(res.status, 404);
  });
});

test('unknown routes return 404 once authenticated', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/nonsense`, { headers: authHeaders(token) });
    assert.equal(res.status, 404);
  });
});

test('isOverWifi is true when the request arrived on an address bound to wlan0', () => {
  const fakeInterfaces = () => ({
    wlan0: [{ address: '192.168.1.134', family: 'IPv4' }],
  });
  const req = { socket: { localAddress: '192.168.1.134' } };
  assert.equal(isOverWifi(req, fakeInterfaces), true);
});

test('isOverWifi is false for an address not bound to wlan0 (eg. wired USB tethering)', () => {
  const fakeInterfaces = () => ({
    wlan0: [{ address: '192.168.1.134', family: 'IPv4' }],
    eth1: [{ address: '172.20.10.8', family: 'IPv4' }],
  });
  const req = { socket: { localAddress: '172.20.10.8' } };
  assert.equal(isOverWifi(req, fakeInterfaces), false);
});

test('isOverWifi normalizes IPv4-mapped IPv6 addresses before comparing', () => {
  const fakeInterfaces = () => ({
    wlan0: [{ address: '192.168.1.134', family: 'IPv4' }],
  });
  const req = { socket: { localAddress: '::ffff:192.168.1.134' } };
  assert.equal(isOverWifi(req, fakeInterfaces), true);
});

test('isOverWifi is false when the box has no wlan0 interface at all', () => {
  const fakeInterfaces = () => ({});
  const req = { socket: { localAddress: '192.168.1.134' } };
  assert.equal(isOverWifi(req, fakeInterfaces), false);
});

test('isLocal is true for IPv4 loopback', () => {
  assert.equal(isLocal({ socket: { localAddress: '127.0.0.1' } }), true);
});

test('isLocal is true for IPv6 loopback', () => {
  assert.equal(isLocal({ socket: { localAddress: '::1' } }), true);
});

test('isLocal normalizes IPv4-mapped IPv6 loopback', () => {
  assert.equal(isLocal({ socket: { localAddress: '::ffff:127.0.0.1' } }), true);
});

test('isLocal is false for a real network address', () => {
  assert.equal(isLocal({ socket: { localAddress: '192.168.1.134' } }), false);
});

// Deck numbers in the 99xx range throughout - keeps these tests from colliding with a real xwax instance's socket (decks 1-4) if run on the Pi.

test('POST /decks/:n/load sends LOAD to the right deck socket', async () => {
  const deckNumber = 9921;
  await withServer(async (base) => {
    const socketPath = deckSocketPath(deckNumber);
    const fakeXwax = createSocketServer();
    let received = '';
    fakeXwax.on('connection', (socket) => {
      socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
    });
    await new Promise((resolve) => fakeXwax.listen(socketPath, resolve));

    try {
      const token = await pair(base);
      const res = await fetch(`${base}/decks/${deckNumber}/load`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: '/media/pidvs/sda2/track.mp3' }),
      });
      assert.equal(res.status, 200);
      // The write reaching the fake xwax socket is async from the
      // response's perspective - give its 'data' event a moment.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(received, 'LOAD /media/pidvs/sda2/track.mp3\n');
    } finally {
      fakeXwax.close();
    }
  }, { deckCount: deckNumber });
});

test('POST /decks/:n/load needs no token', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/decks/1/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/some/track.mp3' }),
    });
    // 502 - the request was accepted and tried to reach a deck that is not there in a test.
    assert.equal(res.status, 502);
  });
});

test('POST /decks/:n/load for a deck number outside deckCount returns 404', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/decks/2/load`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/some/track.mp3' }),
    });
    assert.equal(res.status, 404);
  }, { deckCount: 1 });
});

test('POST /decks/:n/load without a path returns 400', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/decks/1/load`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test('POST /decks/:n/load returns 502 when the deck socket is unreachable', async () => {
  const deckNumber = 9922;
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/decks/${deckNumber}/load`, {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/some/track.mp3' }),
    });
    assert.equal(res.status, 502);
  }, { deckCount: deckNumber });
});

async function readOneSSEEvent(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended before an event arrived');
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) continue;
      const block = buffer.slice(0, boundary);
      if (!block.startsWith('data: ')) continue;
      return JSON.parse(block.slice('data: '.length));
    }
  } finally {
    await reader.cancel();
  }
}

test('GET /decks/:n/status/stream relays live STATUS updates over SSE', async () => {
  const deckNumber = 9931;
  await withServer(async (base) => {
    const socketPath = deckSocketPath(deckNumber);
    const fakeXwax = createSocketServer();
    fakeXwax.on('connection', (socket) => {
      socket.on('data', (chunk) => {
        if (chunk.toString().includes('STATUS')) socket.write('STATUS PLAYING 187.4 1.000 0 0.000 0 0.000 0.000 /media/pidvs/sda2/track.mp3\n');
      });
    });
    await new Promise((resolve) => fakeXwax.listen(socketPath, resolve));

    try {
      const token = await pair(base);
      const res = await fetch(`${base}/decks/${deckNumber}/status/stream`, { headers: authHeaders(token) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');
      const event = await readOneSSEEvent(res);
      /* sentAt is the box's own clock, stamped beside the status rather than derived from arrival
       * time - BPMSpeedTracker's speed measurement is only valid if both halves come from one
       * clock. Checked separately because its value is a live reading, not a fixture. */
      assert.equal(typeof event.sentAt, 'number', 'the stream must stamp the box clock on each status');
      assert.ok(event.sentAt > 0);
      /* Same clock reading as the poller's own `at`, carried through rather than re-stamped - the
       * event loop can spend tens of milliseconds between the two while a waveform is bucketed, and
       * all of it would land in the speed measurement as error. */
      assert.equal(event.sentAt, event.at, 'sentAt is the time the status was READ, not sent');
      delete event.sentAt;
      delete event.at;
      assert.deepEqual(event, {
        state: 'PLAYING',
        remain: 187.4,
        pitch: 1.0,
        relative: false,
        cuePoint: 0,
        loopActive: false,
        loopStart: 0,
        loopEnd: 0,
        elapsed: null,
        timecodeValid: null,
        unreadableSeconds: null,
        keyLock: null,
        path: '/media/pidvs/sda2/track.mp3',
      });
    } finally {
      fakeXwax.close();
    }
  }, { deckCount: deckNumber });
});

test('GET /signal/stream streams every deck at once, and reports a deck that is not running as offline', async () => {
  await withServer(async (base) => {
    // Deck 1 answers SIGNAL; deck 2 has no socket at all, which is a normal state here.
    const fakeXwax = createSocketServer();
    fakeXwax.on('connection', (socket) => {
      socket.on('data', (chunk) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          if (line === 'SIGNAL') socket.write('SIGNAL 1073741824 536870912 900000000 4231 17 1 1 8388608 2\n');
          else if (line === 'STATUS') socket.write('STATUS STOPPED 0.0 0.000 0 0.000 0 0.000 0.000\n');
        }
      });
    });
    await new Promise((resolve) => fakeXwax.listen(deckSocketPath(1), resolve));

    try {
      const token = await pair(base);
      const res = await fetch(`${base}/signal/stream`, { headers: authHeaders(token) });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/event-stream');

      const event = await readOneSSEEvent(res);
      assert.equal(event.decks.length, 2);
      assert.equal(event.decks[0].deck, 1);
      assert.equal(event.decks[0].peakLeft, 1073741824);
      assert.equal(event.decks[0].refLevel, 900000000);
      assert.equal(event.decks[0].validCounter, 4231);
      assert.equal(event.decks[0].safe, true);
      assert.equal(event.decks[0].threshold, 8388608);
      assert.equal(event.decks[0].sensitivity, 2);
      // The whole point of the per-deck try: one dead deck must not fail the other's reading.
      assert.deepEqual(event.decks[1], { deck: 2, offline: true });
    } finally {
      fakeXwax.close();
    }
  }, { deckCount: 2 });
});

test('GET /decks/:n/status/stream for a deck that does not exist is a 404, not an auth failure', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/decks/9/status/stream`);
    assert.equal(res.status, 404);
  });
});

test('GET /decks/:n/status/stream for a deck number outside deckCount returns 404', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/decks/2/status/stream`, { headers: authHeaders(token) });
    assert.equal(res.status, 404);
  }, { deckCount: 1 });
});


/*
 * /network - the whole surface the AP portal is built on. Untested until now, which mattered rather
 * more once it became the only way to configure a box that has no other way in.
 */
function fakeWifi({ saved = [], forgetResult = { ok: true }, apUp = false, apPassword = null } = {}) {
  let stored = apPassword;
  const calls = [];
  return {
    calls,
    wifiProvisioning: {
      async status() { return { connection: 'Home Wi-Fi', ip: '192.168.1.87/24', ap: 'no' }; },
      async scan() { return [{ ssid: 'Home Wi-Fi', signal: 71, secure: true }]; },
      async saved() { return saved; },
      async forget(ssid) { calls.push(['forget', ssid]); return forgetResult; },
      async join(args) { calls.push(['join', args.ssid]); return { ok: true }; },
    },
    wifiMode: {
      describe: () => ({ managementDisabled: false, lastReason: 'cable' }),
      isApUp: () => apUp,
    },
    apPassword: {
      get: () => stored,
      isOpen: () => stored === null,
      set: (v) => {
        if (!v) return { ok: false, reason: 'no-password', field: 'apPassword' };
        if (v.length < 8) return { ok: false, reason: 'too-short', field: 'apPassword' };
        stored = v;
        return { ok: true };
      },
    },
  };
}

test('GET /network reports saved networks, visible ones, and why the AP is up', async () => {
  const { wifiProvisioning, wifiMode } = fakeWifi({ saved: [{ ssid: 'Home Wi-Fi', active: true }] });
  await withServer(async (base) => {
    const res = await fetch(`${base}/network`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.saved, [{ ssid: 'Home Wi-Fi', active: true }]);
    assert.deepEqual(body.networks, [{ ssid: 'Home Wi-Fi', signal: 71, secure: true }]);
    assert.equal(body.connection, 'Home Wi-Fi');
    // The reason, not just the state - a page reached OVER the setup network has to say what ends it.
    assert.equal(body.lastReason, 'cable');
  }, { wifiProvisioning, wifiMode });
});

/* The setup network's password. `apOpen` is what the portal gates on, so it has to be reported
 * separately from the password itself - a client that cannot show the password still needs to know the
 * box is open to the room. */
test('GET /network says whether the setup network is still open', async () => {
  const { wifiProvisioning, wifiMode, apPassword } = fakeWifi();
  await withServer(async (base) => {
    let body = await (await fetch(`${base}/network`)).json();
    assert.equal(body.apOpen, true);
    assert.equal(body.apPassword, null);

    const res = await fetch(`${base}/network/ap-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apPassword: 'mybooth2026' }),
    });
    assert.equal(res.status, 200);

    body = await (await fetch(`${base}/network`)).json();
    assert.equal(body.apOpen, false);
    assert.equal(body.apPassword, 'mybooth2026');
  }, { wifiProvisioning, wifiMode, apPassword });
});

test('POST /network/ap-password refuses one WPA2 would reject, with a named reason', async () => {
  const { wifiProvisioning, apPassword } = fakeWifi();
  await withServer(async (base) => {
    const res = await fetch(`${base}/network/ap-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apPassword: 'short' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'too-short');
    // And the box is still open, not left in some half-set state.
    assert.equal((await (await fetch(`${base}/network`)).json()).apOpen, true);
  }, { wifiProvisioning, apPassword });
});

test('POST /network/forget removes a saved network', async () => {
  const { wifiProvisioning, calls } = fakeWifi();
  await withServer(async (base) => {
    const res = await fetch(`${base}/network/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: 'Old Flat' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [['forget', 'Old Flat']]);
  }, { wifiProvisioning });
});

/* A refusal has to arrive as a refusal. This one is the box declining to strand itself, and a 200
 * here would show as "removed" in a list that still has it. */
test('POST /network/forget answers 400 when the box refuses to strand itself', async () => {
  const { wifiProvisioning } = fakeWifi({ forgetResult: { ok: false, reason: 'last-network', field: 'ssid' } });
  await withServer(async (base) => {
    const res = await fetch(`${base}/network/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid: 'Home Wi-Fi' }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).reason, 'last-network');
  }, { wifiProvisioning });
});

test('POST /network/forget with no ssid is a named refusal, not a crash', async () => {
  const { wifiProvisioning } = fakeWifi({ forgetResult: { ok: false, reason: 'no-ssid', field: 'ssid' } });
  await withServer(async (base) => {
    const res = await fetch(`${base}/network/forget`, { method: 'POST' });
    assert.equal(res.status, 400);
  }, { wifiProvisioning });
});

/*
 * The captive portal. A phone probes a fixed URL after joining a network to decide whether it has
 * internet; answering that probe with anything other than success is what makes it open this page by
 * itself, which is the difference between a box a person can set up and one they have to be told an
 * address for.
 */
test('on the setup network, a captive-portal probe is redirected to the page', async () => {
  const { wifiProvisioning, wifiMode } = fakeWifi({ apUp: true });
  await withServer(async (base) => {
    for (const probe of ['/hotspot-detect.html', '/generate_204', '/ncsi.txt']) {
      const res = await fetch(`${base}${probe}`, { redirect: 'manual' });
      assert.equal(res.status, 302, probe);
      /* SETUP, not the deck screen and not the settings pane inside it. This lands in a sheet the
       * OS opened, often with no address bar to correct, for somebody who has just plugged a box
       * in - they are not trying to mix, they are trying to get it onto their wifi. */
      assert.equal(res.headers.get('location'), '/#setup', probe);
    }
  }, { wifiProvisioning, wifiMode });
});

/* The gate that keeps this from being a hijack. A box sitting on a real network must answer these
 * paths the way it answers any other unknown path - the probe it would be intercepting is how some
 * other device decides whether the whole network works. */
test('off the setup network, a probe path is not intercepted', async () => {
  const { wifiProvisioning, wifiMode } = fakeWifi({ apUp: false });
  await withServer(async (base) => {
    const res = await fetch(`${base}/hotspot-detect.html`, { redirect: 'manual' });
    assert.notEqual(res.status, 302);
  }, { wifiProvisioning, wifiMode });
});

/* A server built without the watcher at all - an older wiring, or a test - must not throw on every
 * request that happens to look like a probe. */
test('a probe path is harmless when there is no watcher to ask', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/generate_204`, { redirect: 'manual' });
    assert.notEqual(res.status, 302);
  });
});

/* A path ending in "/" means the index inside it. Only the bare root was handled, which was enough
 * while there was one page to serve - and then a second app at /next/ 404'd while its own assets
 * served fine, which is a confusing way to find out. */
test('a directory path serves the index.html inside it', async () => {
  await withServer(async (base) => {
    const root = await fetch(`${base}/`);
    assert.equal(root.status, 200, 'the root page still works');
    assert.match(await root.text(), /<!doctype html>/i);
  });
});

/* The slashes are ENCODED deliberately. A plain `/../../etc/passwd` is collapsed by WHATWG URL
 * inside fetch before anything is sent, so the server only ever sees /etc/passwd and the guard in
 * serveStatic is never reached - the test passed with the guard deleted. %2f survives URL parsing
 * and decodeURIComponent turns it back into a separator, which is the actual bypass. */
test('a path that escapes web/ is still refused', async () => {
  await withServer(async (base) => {
    // A file that EXISTS one level above web/, so the guard is the only thing refusing it. Aiming
    // at /etc/passwd proved nothing: it resolves to waxcode/etc/passwd, which is simply absent,
    // and the test stayed green with the guard deleted.
    const res = await fetch(`${base}/%2e%2e%2fpackage.json`);
    assert.equal(res.status, 404);
  });
});

/*
 * Safari will not play a <video> from a server that answers 200 to a range request - it asks for
 * bytes=0-1 first and refuses the media with NotSupportedError otherwise. This box answered 200 to
 * everything, so the wake-lock fallback video never played on it, in either app (2026-09-29).
 */
test('a range request gets 206 and only that slice', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { headers: { Range: 'bytes=0-1' } });
    assert.equal(res.status, 206, 'a 200 here is what stops Safari playing video at all');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.match(res.headers.get('content-range'), /^bytes 0-1\/\d+$/);
    assert.equal((await res.arrayBuffer()).byteLength, 2, 'two bytes, not the whole file');
  });
});

test('a plain request still gets the whole file, and says ranges are allowed', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('accept-ranges'), 'bytes', 'or nobody knows they may ask');
  });
});

/* "-N" means the LAST N bytes. Reading it as 0..N serves the wrong part of the file, which for
 * media is a header where there should be a frame. */
test('a suffix range is counted from the end', async () => {
  await withServer(async (base) => {
    const whole = await (await fetch(`${base}/`)).arrayBuffer();
    const res = await fetch(`${base}/`, { headers: { Range: 'bytes=-4' } });
    assert.equal(res.status, 206);
    assert.deepEqual(
      Buffer.from(await res.arrayBuffer()),
      Buffer.from(whole.slice(whole.byteLength - 4)),
    );
  });
});

test('a range past the end is refused, not clamped silently', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`, { headers: { Range: 'bytes=99999999-' } });
    assert.equal(res.status, 416);
    assert.match(res.headers.get('content-range'), /^bytes \*\/\d+$/);
  });
});

/*
 * The captive portal redirects to /#setup, and that fragment does not survive Apple's Captive
 * Network Assistant - so the app loaded with no idea it was being set up and showed the deck
 * screen's "rotate to landscape" over the only page that mattered. Asking the browser where it
 * thinks it is was the wrong question; the box knows (2026-09-29).
 */
test('the box can tell somebody is on its own setup network', () => {
  // NetworkManager's shared mode always puts the AP on 10.42.0.1.
  assert.equal(isOnSetupNetwork({ socket: { localAddress: '10.42.0.1' } }), true);
  assert.equal(isOnSetupNetwork({ socket: { localAddress: '::ffff:10.42.0.1' } }), true, 'v4-mapped');
  assert.equal(isOnSetupNetwork({ socket: { localAddress: '192.168.1.86' } }), false, 'the LAN is not setup');
  assert.equal(isOnSetupNetwork({ socket: { localAddress: '127.0.0.1' } }), false);

  /* The case that was wrong on hardware: avahi answers waxcodedvs.local with the WIRED address too,
   * the AP is NATted out through it, so a phone on the setup network lands on the LAN address. */
  assert.equal(
    isOnSetupNetwork({ socket: { localAddress: '192.168.1.86', remoteAddress: '10.42.0.5' } }),
    true,
    'from the setup network, arriving on the wired address',
  );
  assert.equal(
    isOnSetupNetwork({ socket: { localAddress: '::ffff:192.168.1.86', remoteAddress: '::ffff:10.42.0.5' } }),
    true,
    'v4-mapped, both ends',
  );
  assert.equal(
    isOnSetupNetwork({ socket: { localAddress: '192.168.1.86', remoteAddress: '192.168.1.40' } }),
    false,
    'an ordinary visitor on the LAN is still not setup',
  );
});

/*
 * The side picker did nothing. The route narrowed the client's value to 'a' or 'b' before storing
 * it - values createDeckTimecode rejects outright - so every change threw, came back 502, and the
 * picker snapped back to where it started. BLE never had this: it decodes its 0x00/0x01 byte
 * straight to the same full names the store uses (owner-reported, 2026-09-30).
 */
test('a deck accepts a full timecode side name, and refuses anything else', async () => {
  const sides = new Map();
  const deckTimecode = {
    get: (deck) => sides.get(deck) ?? 'serato_2a',
    set: (deck, side) => {
      // The real store throws on an unknown side; anything less would hide this bug again.
      if (!['serato_2a', 'serato_2b'].includes(side)) throw new Error(`Unknown side: ${side}`);
      sides.set(deck, side);
    },
  };

  await withServer(async (base) => {
    const token = await pair(base);

    const toB = await fetch(`${base}/decks/1/timecode-side`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ side: 'serato_2b' }),
    });
    assert.equal(toB.status, 200, await toB.text());
    assert.equal(sides.get(1), 'serato_2b', 'side B is actually reachable');

    const back = await fetch(`${base}/decks/1/timecode-side`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ side: 'serato_2a' }),
    });
    assert.equal(back.status, 200);
    assert.equal(sides.get(1), 'serato_2a');

    // A bad value is the client's fault, and saying so beats a 502 blaming the deck.
    const bad = await fetch(`${base}/decks/1/timecode-side`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ side: 'b' }),
    });
    assert.equal(bad.status, 400);
  }, { deckTimecode });
});

/*
 * A second route to a mix that needs no USB stick at all - which matters most for the person whose
 * stick is the slow one. Streamed rather than buffered: serveStatic reads a whole file into memory,
 * which is right for a favicon and ruinous for a 300MB set on a box with 990MB of RAM and no swap.
 */
test('a recording can be downloaded, whole or by range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-dl-'));
  const payload = Buffer.from('a fake mix, but a real file');
  writeFileSync(join(dir, '2026-09-30 21-15.mp3'), payload);

  const recorder = {
    existing: () => ({
      name: '2026-09-30 21-15.mp3',
      path: join(dir, '2026-09-30 21-15.mp3'),
      bytes: payload.length,
      recordedAt: Date.now(),
    }),
    status: () => ({}),
  };

  try {
    await withServer(async (base) => {
      const token = await pair(base);

      const whole = await fetch(`${base}/record/download`, { headers: authHeaders(token) });
      assert.equal(whole.status, 200);
      assert.equal(whole.headers.get('accept-ranges'), 'bytes', 'so a client knows it may ask for part');
      assert.match(
        whole.headers.get('content-disposition') ?? '',
        /attachment; filename="2026-09-30 21-15\.mp3"/,
        'named as recorded, so a folder of these sorts itself',
      );
      assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), payload.toString());

      // A resumed download asks for the rest, and must not be given the whole file again.
      const rest = await fetch(`${base}/record/download`, {
        headers: { ...authHeaders(token), Range: 'bytes=10-' },
      });
      assert.equal(rest.status, 206);
      assert.equal(rest.headers.get('content-range'), `bytes 10-${payload.length - 1}/${payload.length}`);
      assert.equal(Buffer.from(await rest.arrayBuffer()).toString(), payload.subarray(10).toString());

      const past = await fetch(`${base}/record/download`, {
        headers: { ...authHeaders(token), Range: `bytes=${payload.length + 5}-` },
      });
      assert.equal(past.status, 416);
    }, { recorder });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('downloading with nothing recorded says so rather than serving nothing', async () => {
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/record/download`, { headers: authHeaders(token) });
    assert.equal(res.status, 404);
  }, { recorder: { existing: () => null, status: () => ({}) } });
});



/*
 * Tracks sent straight from a laptop, so a mix is not gated on having the right USB stick with you.
 *
 * The thing under test is not really the transfer - it is the bounds. The rootfs filling up is not
 * a degraded box, it is one somebody has to physically fetch, and two are in the field.
 */
test('a staged name keeps what the person called the file, and refuses what will not play', () => {
  assert.equal(safeName('Artist - Title (12" Mix).mp3'), 'Artist - Title (12- Mix).mp3');
  // The extension is normalised rather than merely accepted - one spelling on disk, either way in.
  assert.equal(safeName('track.FLAC'), 'track.flac');

  // A name is about to become a path, and a client is free to send anything at all.
  assert.equal(safeName('../../../etc/passwd.mp3'), 'passwd.mp3', 'no traversal survives');
  assert.equal(safeName('/absolute/path.wav'), 'path.wav');
  assert.equal(safeName('..\\windows\\evil.mp3'), 'evil.mp3');

  assert.equal(safeName('notes.txt'), null, 'not something a deck can play');
  assert.equal(safeName('nodotextension'), null);
  assert.equal(safeName('.mp3'), null, 'an extension alone is not a name');
  assert.equal(safeName(''), null);
  assert.equal(safeName(null), null);
});

test('a track sent from a laptop lands, appears as a library device, and can be deleted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  const uploads = createUploads({ dir });
  try {
    await withServer(async (base) => {
      const token = await pair(base);

      const sent = await fetch(`${base}/uploads?name=${encodeURIComponent('Some Track.mp3')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/mpeg', ...authHeaders(token) },
        body: Buffer.alloc(4096, 7),
      });
      assert.equal(sent.status, 200, await sent.text());
      assert.deepEqual(uploads.entries().map((e) => e.name), ['Some Track.mp3']);

      // It has to show up where tracks are chosen, or it cannot be loaded.
      const listed = await (await fetch(`${base}/uploads`, { headers: authHeaders(token) })).json();
      assert.equal(listed.tracks.length, 1);
      assert.equal(listed.tracks[0].name, 'Some Track.mp3');
      assert.equal(listed.tracks[0].bytes, 4096);
      // The path too: whoever just sent a track has to load it, and must not guess where it landed.
      assert.ok(listed.tracks[0].path.endsWith('Some Track.mp3'));

      const gone = await fetch(`${base}/uploads/${encodeURIComponent('Some Track.mp3')}`, {
        method: 'DELETE', headers: authHeaders(token),
      });
      assert.equal(gone.status, 200);
      assert.equal(uploads.isEmpty(), true);

      const missing = await fetch(`${base}/uploads/nothing.mp3`, { method: 'DELETE', headers: authHeaders(token) });
      assert.equal(missing.status, 404);
    }, { uploads });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file the box cannot play, or cannot fit, is refused rather than written', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  // A deliberately tiny budget: the point is the refusal, not the arithmetic.
  const uploads = createUploads({ dir, budgetBytes: 8192, maxFileBytes: 4096, reserveBytes: 0 });
  try {
    await withServer(async (base) => {
      const token = await pair(base);

      const wrongType = await fetch(`${base}/uploads?name=notes.txt`, {
        method: 'POST', headers: authHeaders(token), body: Buffer.alloc(16),
      });
      assert.equal(wrongType.status, 415);

      const tooBig = await fetch(`${base}/uploads?name=huge.mp3`, {
        method: 'POST', headers: authHeaders(token), body: Buffer.alloc(5000),
      });
      assert.equal(tooBig.status, 413);
      assert.equal(uploads.isEmpty(), true, 'nothing half-written is left behind');
    }, { uploads });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The budget is kept by dropping the OLDEST staged track, not by refusing the new one: somebody
 * sending a track is asking for that track, and a staging area that fills up and then says no is
 * a staging area that needs explaining. */
test('staging evicts the oldest track to stay inside its budget', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  const uploads = createUploads({ dir, budgetBytes: 9000, maxFileBytes: 8192, reserveBytes: 0 });
  try {
    const send = (readable, name) => uploads.receive(readable, name, { declaredBytes: 4096 });
    const body = () => Readable.from([Buffer.alloc(4096, 1)]);

    await send(body(), 'first.mp3');
    // Mtime resolution is coarse enough that two writes in the same millisecond sort arbitrarily.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send(body(), 'second.mp3');
    assert.deepEqual(uploads.entries().map((e) => e.name), ['first.mp3', 'second.mp3']);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await send(body(), 'third.mp3');
    assert.deepEqual(
      uploads.entries().map((e) => e.name),
      ['second.mp3', 'third.mp3'],
      'the oldest made room for the newest',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Staged tracks must not quietly become a library somebody relies on, on the one filesystem that
 * cannot be allowed to fill up. So a restart starts empty - including any .part left by a transfer
 * that was cut off halfway. */
test('staged tracks do not survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  try {
    writeFileSync(join(dir, 'left-over.mp3'), Buffer.alloc(32));
    writeFileSync(join(dir, 'interrupted.mp3.part'), Buffer.alloc(32));

    const uploads = createUploads({ dir });
    assert.equal(uploads.entries().length, 1, 'the finished file is there to begin with');

    await withServer(async () => {
      assert.equal(uploads.isEmpty(), true, 'and gone once a server starts');
      assert.equal(readdirSync(dir).length, 0, 'including the part file');
    }, { uploads });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/*
 * A sent track must not become data nobody is managing.
 *
 * Owner's expectation, and the right one: it goes into RAM, gets used, and is forgotten when the
 * deck moves on. It cannot be QUITE that - xwax LOADs by path, so the bytes have to reach the disk
 * first - but the file can live exactly as long as a deck is holding it, which is what this checks.
 */
test('a sent track is dropped once its deck moves on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  try {
    const uploads = createUploads({ dir });
    const staged = (name) => {
      writeFileSync(join(dir, name), Buffer.alloc(16));
      return join(dir, name);
    };

    const first = staged('first.mp3');
    uploads.claim(1, first);
    assert.equal(uploads.entries().length, 1, 'held by deck 1 while it is on it');

    // Deck 1 moves to another sent track: the one it was holding goes.
    const second = staged('second.mp3');
    uploads.claim(1, second);
    assert.deepEqual(uploads.entries().map((e) => e.name), ['second.mp3']);

    // And moving to a track on a stick releases it too - nothing is left behind.
    uploads.claim(1, '/media/pidvs/port-3/Real Track.mp3');
    assert.equal(uploads.isEmpty(), true, 'nothing staged once no deck holds anything');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* Both decks can be playing the same sent file. The first to move on must NOT delete it from under
 * the other - only the last one out turns the light off. */
test('a sent track both decks are holding survives one of them moving on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  try {
    const uploads = createUploads({ dir });
    writeFileSync(join(dir, 'shared.mp3'), Buffer.alloc(16));
    const shared = join(dir, 'shared.mp3');

    uploads.claim(1, shared);
    uploads.claim(2, shared);

    uploads.claim(1, '/media/pidvs/port-3/Other.mp3');
    assert.equal(uploads.entries().length, 1, 'deck 2 is still playing it');

    uploads.claim(2, '/media/pidvs/port-3/Other.mp3');
    assert.equal(uploads.isEmpty(), true, 'now nobody is');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* The analysis outlived the track it described: a waveform and a beat grid keyed to a staged file
 * that had already been deleted, sitting in a directory nobody would think to look in. For a stick
 * that is the point of a cache; for a file dropped the moment a deck lets go, it is litter. */
test('dropping a sent track takes its waveform and beat grid with it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pidvs-uploads-'));
  try {
    const forgotten = [];
    const uploads = createUploads({ dir, forgetAnalysis: (path) => forgotten.push(path) });
    writeFileSync(join(dir, 'sent.mp3'), Buffer.alloc(16));
    const sent = join(dir, 'sent.mp3');

    uploads.claim(1, sent);
    assert.deepEqual(forgotten, [], 'still on the deck, still wanted');

    uploads.claim(1, '/media/pidvs/port-3/Real.mp3');
    assert.deepEqual(forgotten, [sent], 'gone with the file, not left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


/*
 * Changing the Serato side used to restart xwax@N and then put the track, position, cue and loop
 * back afterwards. The restart raced the reload, so a deck sometimes took the restart and dropped
 * the reload - emptying itself because somebody changed a setting.
 *
 * None of it was necessary. xwax rebuilds its timecoder in place now (TIMECODE, see PROTOCOL.md),
 * so there is nothing to restart and therefore nothing to put back.
 */
test('changing the timecode side tells the running deck, and restarts nothing', async () => {
  const deckSocket = createSocketServer();
  let received = '';
  deckSocket.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => deckSocket.listen(deckSocketPath(1), resolve));

  const deckStatusRegistry = fakeDeckStatusRegistry({
    1: { state: 'PLAYING', path: '/music/a.mp3', elapsed: 30, cuePoint: 12, loopActive: true, loopStart: 16, loopEnd: 18 },
  });
  let restarts = 0;
  let loads = 0;
  const deckControl = {
    restartDeck: () => { restarts += 1; return Promise.resolve(); },
    loadTrack: () => { loads += 1; return Promise.resolve(); },
    seek: () => Promise.resolve(),
  };
  const sides = new Map();
  const deckTimecode = { get: () => 'serato_2a', set: (deck, side) => sides.set(deck, side) };

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const res = await fetch(`${base}/decks/1/timecode-side`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ side: 'serato_2b' }),
      });
      assert.equal(res.status, 200, await res.text());

      assert.equal(sides.get(1), 'serato_2b', 'written to the env file, for a deck starting later');
      assert.match(received, /TIMECODE serato_2b/, 'and told to the deck running now');

      /* The whole point. Nothing is restarted, so nothing has to be put back - and the cue and the
       * loop survive by never having been disturbed rather than by being restored. */
      assert.equal(restarts, 0, 'no restart');
      assert.equal(loads, 0, 'and so nothing to reload');
      assert.doesNotMatch(received, /LOAD /, 'the track is never touched');
      assert.doesNotMatch(received, /SET_CUE/, 'nor the cue');
    }, { deckStatusRegistry, deckTimecode, deckControl });
  } finally {
    deckSocket.close();
  }
});

/* A deck that is not running has nothing to tell - it reads the env file when it starts. That must
 * not read as a failure, or changing the side on an idle deck would report an error. */
test('a side change on a deck that is not running still succeeds', async () => {
  const sides = new Map();
  const deckTimecode = { get: () => 'serato_2a', set: (deck, side) => sides.set(deck, side) };

  await withServer(async (base) => {
    const token = await pair(base);
    // Deck 1 with no socket listening, which is what "not running" looks like from here.
    const res = await fetch(`${base}/decks/1/timecode-side`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ side: 'serato_2b' }),
    });
    assert.equal(res.status, 200, await res.text());
    assert.equal(sides.get(1), 'serato_2b');
  }, { deckTimecode });
});




/*
 * A box whose audio engine cannot be updated over the air.
 *
 * The server ships in every release; xwax does not, unless pi/enable-ota-xwax.sh has been run. So
 * the server can be months ahead of the engine it is talking to - and an xwax that has never heard
 * of TIMECODE logs it as unknown and carries on, which means the side silently does not change.
 * Worse, a track load does not restart a running deck, so it would not take effect "next time"
 * either. Those boxes keep the old way instead.
 */
test('an old audio engine gets the restart, because the command would do nothing', async () => {
  const deckSocket = createSocketServer();
  let received = '';
  deckSocket.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => deckSocket.listen(deckSocketPath(1), resolve));

  const deckStatusRegistry = fakeDeckStatusRegistry({
    1: { state: 'PLAYING', path: '/music/a.mp3', elapsed: 30, cuePoint: 12, loopActive: false, loopStart: 0, loopEnd: 0 },
  });
  let restarts = 0;
  const loaded = [];
  const deckControl = {
    restartDeck: () => { restarts += 1; return Promise.resolve(); },
    loadTrack: (deck, path) => { loaded.push(path); return Promise.resolve(); },
    seek: () => Promise.resolve(),
  };
  const deckTimecode = { get: () => 'serato_2a', set: () => {} };

  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const res = await fetch(`${base}/decks/1/timecode-side`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ side: 'serato_2b' }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, live: false }, 'and it says it was not live');

      assert.equal(restarts, 1, 'restarted, because telling it would have done nothing');
      assert.deepEqual(loaded, ['/music/a.mp3'], 'and what was on it is put back');
      assert.match(received, /SET_CUE 12/, 'cue included');
      assert.doesNotMatch(received, /TIMECODE/, 'never sent a command it cannot understand');
    }, { deckStatusRegistry, deckTimecode, deckControl, xwaxCan: () => false });
  } finally {
    deckSocket.close();
  }
});

/* A chosen order for a folder, stored on the stick that holds it. Addressed by DEVICE and folder,
 * because a client has no business knowing where this box mounted anything. */
test('a folder order round-trips, and an unknown device is refused', async () => {
  let stored = null;
  const trackOrder = {
    get: () => (stored ?? []),
    set: async (_root, _folder, names) => { stored = names; return true; },
  };
  const devices = new Map([['port-3', { id: 'port-3', name: 'Stick', root: '/media/pidvs/port-3', tracks: [], playlists: [], scanning: false }]]);

  await withServer(async (base) => {
    const token = await pair(base);

    const empty = await (await fetch(`${base}/order?device=port-3&folder=House`, { headers: authHeaders(token) })).json();
    assert.deepEqual(empty.names, [], 'no opinion to begin with');

    const saved = await fetch(`${base}/order?device=port-3&folder=House`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ names: ['b.mp3', 'a.mp3'] }),
    });
    assert.equal(saved.status, 200, await saved.text());
    assert.deepEqual(stored, ['b.mp3', 'a.mp3']);

    const gone = await fetch(`${base}/order?device=nope&folder=House`, { headers: authHeaders(token) });
    assert.equal(gone.status, 404, 'a device that is not there is not a silent empty order');
  }, { devices, trackOrder });
});

/* A stick that is genuinely read-only, full, or was pulled mid-write cannot hold an order. That is
 * an ANSWER the client has to show, not something to swallow - otherwise somebody arranges a folder
 * and loses it the moment the stick moves. */
test('a stick that will not take the order says so', async () => {
  const trackOrder = { get: () => [], set: async () => false };
  const devices = new Map([['port-3', { id: 'port-3', name: 'Stick', root: '/media/pidvs/port-3', tracks: [], playlists: [], scanning: false }]]);

  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/order?device=port-3&folder=House`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ names: ['a.mp3'] }),
    });
    assert.equal(res.status, 507);
  }, { devices, trackOrder });
});

/* A scan is walking the very directories a write would change, and the device entry it builds
 * would then describe something that moved underneath it. Waiting costs seconds. */
test('adding to a stick is refused while that stick is being scanned', async () => {
  let wrote = false;
  const stickWriter = {
    makeFolder: async () => { wrote = true; return { name: 'x' }; },
    addTrack: async () => { wrote = true; return { name: 'x', bytes: 1 }; },
  };
  const devices = new Map([['port-3', {
    id: 'port-3', name: 'Stick', root: '/media/pidvs/port-3', tracks: [], playlists: [], scanning: true,
  }]]);

  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/stick/folder?device=port-3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ name: 'New Crate' }),
    });
    assert.equal(res.status, 409);
    assert.equal(wrote, false, 'and nothing was written while it decided');
  }, { devices, stickWriter });
});

test('a stick that is not there is refused rather than written to blindly', async () => {
  const stickWriter = { makeFolder: async () => ({ name: 'x' }), addTrack: async () => ({ name: 'x', bytes: 1 }) };
  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/stick/folder?device=gone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ name: 'New Crate' }),
    });
    assert.equal(res.status, 404);
  }, { devices: new Map(), stickWriter });
});

/* The refusals the writer raises have to reach the client as themselves - a full stick and a
 * rejected path are different problems and only one of them is worth retrying. */
test('a refusal from the stick keeps its own status', async () => {
  const stickWriter = {
    makeFolder: async () => { throw Object.assign(new Error('there is not enough room on that stick'), { status: 507 }); },
    addTrack: async () => ({ name: 'x', bytes: 1 }),
  };
  const devices = new Map([['port-3', {
    id: 'port-3', name: 'Stick', root: '/media/pidvs/port-3', tracks: [], playlists: [], scanning: false,
  }]]);

  await withServer(async (base) => {
    const token = await pair(base);
    const res = await fetch(`${base}/stick/folder?device=port-3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ name: 'New Crate' }),
    });
    assert.equal(res.status, 507);
    assert.match((await res.json()).error, /not enough room/);
  }, { devices, stickWriter });
});

/* A scan REPLACES a device's track list and refills it, so the folder on screen empties and comes
 * back. Rescanning after every file emptied it once per file, and anybody watching reasonably
 * concluded the copy had failed. One scan after ALL the writes finish. */
test('a batch of writes causes one rescan, not one per file', async () => {
  const added = [];
  const stickWriter = {
    makeFolder: async () => ({ name: 'x' }),
    addTrack: async (_root, _into, name) => { added.push(name); return { name, bytes: 1 }; },
  };
  // A real directory, so the scan the rescan triggers actually runs rather than erroring out.
  const root = mkdtempSync(join(tmpdir(), 'waxcode-rescan-'));
  const devices = new Map([['port-3', {
    id: 'port-3', name: 'Stick', root, volumeId: 'V',
    tracks: [], playlists: [], folders: [], scanning: false,
  }]]);

  let scans = 0;
  try {
  await withServer(async (base) => {
    const token = await pair(base);
    for (const name of ['one.mp3', 'two.mp3', 'three.mp3']) {
      const res = await fetch(`${base}/stick/track?device=port-3&folder=&name=${name}`, {
        method: 'POST', headers: authHeaders(token), body: Buffer.alloc(16),
      });
      assert.equal(res.status, 200, await res.text());
    }
    assert.deepEqual(added, ['one.mp3', 'two.mp3', 'three.mp3'], 'all three were written');

    // Nothing has rescanned yet - the writes are still settling.
    assert.equal(scans, 0, 'no scan while the files are still arriving');

    await new Promise((resolve) => { setTimeout(resolve, 1600); });
    assert.equal(scans, 1, 'and exactly one once they stopped');
  }, {
    devices,
    stickWriter,
    onFastScan: () => { scans += 1; },
  });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/*
 * The failure the owner actually hit: a drop of 14 tracks stopped partway with "that stick is still
 * being scanned".
 *
 * A timer measuring the gap after a write COMPLETED could never have worked - the next file in the
 * batch is still uploading during that gap, so the scan starts in the middle and every file after
 * it is refused. What has to be counted is writes in flight, not time since one ended.
 */
test('a write that is still arriving holds the rescan back', async () => {
  const root = mkdtempSync(join(tmpdir(), 'waxcode-inflight-'));
  const devices = new Map([['port-3', {
    id: 'port-3', name: 'Stick', root, volumeId: 'V',
    tracks: [], playlists: [], folders: [], scanning: false,
  }]]);

  /* The first write is held open while a second one is sent, which is exactly the overlap a batch
   * of large files produces. */
  let releaseFirst;
  const firstHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const stickWriter = {
    makeFolder: async () => ({ name: 'x' }),
    addTrack: async (_root, _into, name) => {
      calls += 1;
      if (calls === 1) await firstHeld;
      return { name, bytes: 1 };
    },
  };

  let scans = 0;
  try {
    await withServer(async (base) => {
      const token = await pair(base);
      const send = (name) => fetch(`${base}/stick/track?device=port-3&folder=&name=${name}`, {
        method: 'POST', headers: authHeaders(token), body: Buffer.alloc(16),
      });

      const first = send('one.mp3');
      await new Promise((resolve) => { setTimeout(resolve, 50); });

      // The second must NOT be refused just because the first is still going.
      const second = await send('two.mp3');
      assert.equal(second.status, 200, await second.text());

      releaseFirst();
      assert.equal((await first).status, 200);

      await new Promise((resolve) => { setTimeout(resolve, 1700); });
      assert.equal(scans, 1, 'one scan, once both had finished');
    }, { devices, stickWriter, onFastScan: () => { scans += 1; } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


/*
 * The support tunnel route. The module's own behaviour is tested in support-tunnel.test.js - these
 * cover the wiring, including the part that is easy to get wrong: a refusal has to arrive as a
 * readable reason rather than a bare error status, because the pane renders the reason.
 */

function fakeTunnel({ startAnswer, status } = {}) {
  const calls = [];
  let state = status ?? { active: false, hostname: null, secondsRemaining: 0 };
  return {
    calls,
    start: async () => {
      calls.push('start');
      if (startAnswer && !startAnswer.ok) return startAnswer;
      state = { active: true, hostname: 'brave-kite.trycloudflare.com', secondsRemaining: 1800 };
      return { ok: true, ...state };
    },
    stop: () => {
      calls.push('stop');
      state = { active: false, hostname: null, secondsRemaining: 0 };
      return { ok: true, stopped: true, ...state };
    },
    status: () => state,
  };
}

test('GET /support-tunnel reports no session on a box with none open', async () => {
  const supportTunnel = fakeTunnel();
  await withServer(async (base) => {
    const res = await fetch(`${base}/support-tunnel`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.active, false);
    assert.equal(body.hostname, null);
  }, { supportTunnel });
});

test('POST /support-tunnel opens a session and returns where it is', async () => {
  const supportTunnel = fakeTunnel();
  await withServer(async (base) => {
    const res = await fetch(`${base}/support-tunnel`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hostname, 'brave-kite.trycloudflare.com');
    assert.equal(body.secondsRemaining, 1800);

    // And the session is then visible to anything that asks, not just the caller that opened it.
    const after = await (await fetch(`${base}/support-tunnel`)).json();
    assert.equal(after.active, true);
  }, { supportTunnel });
});

test('a box that could not reach the internet says which half failed', async () => {
  /* The pane prints this reason verbatim, and "no internet" is a different instruction to the owner
   * than "it broke" - so it must survive the trip rather than becoming a 500. */
  const supportTunnel = fakeTunnel({
    startAnswer: { ok: false, reason: 'no-binary', detail: 'fetch failed' },
  });
  await withServer(async (base) => {
    const res = await fetch(`${base}/support-tunnel`, { method: 'POST' });
    assert.equal(res.status, 200, 'a refusal is an answer, not an error status');
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.reason, 'no-binary');
  }, { supportTunnel });
});

test('DELETE /support-tunnel ends the session', async () => {
  const supportTunnel = fakeTunnel();
  await withServer(async (base) => {
    await fetch(`${base}/support-tunnel`, { method: 'POST' });
    const res = await fetch(`${base}/support-tunnel`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    const after = await (await fetch(`${base}/support-tunnel`)).json();
    assert.equal(after.active, false);
    assert.deepEqual(supportTunnel.calls, ['start', 'stop']);
  }, { supportTunnel });
});

test('a box without the feature does not answer the route at all', async () => {
  // Rather than claiming no session: an older box genuinely has nothing here, and 404 says so.
  await withServer(async (base) => {
    const res = await fetch(`${base}/support-tunnel`);
    assert.equal(res.status, 404);
  }, {});
});
