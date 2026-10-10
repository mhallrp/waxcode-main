import { createServer as createHttpServer } from 'node:http';
import { cookieHeader } from './connection-pin.js';
import { gzipSync } from 'node:zlib';
import { buildStickManifest } from './stick-manifest.js';
import { withWritableStick } from './stick-writable.js';
import { networkInterfaces, hostname } from 'node:os';
import { readdir, readlink, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve, extname, basename } from 'node:path';
import { readlinkSync, createReadStream } from 'node:fs';
import { RELEASES_DIR } from './box-paths.js';
import { fileURLToPath } from 'node:url';
import { scanLibrary } from './library-scan.js';
import { isDeckRunning } from './xwax-status.js';
import {
  loadTrack, unloadTrack, play, pause, seek, relocate,
  setCue, gotoCue, playCue, setLoop, clearLoop, setTimecode,
} from './deck-control.js';
import { cablePresentSince } from './cable-presence.js';
import { createDeckStatusRegistry } from './deck-status-registry.js';
import { isWaveformCached, cachedPathChecker, touchVolumeLastSeen, clearStickWaveforms, getOrComputeEncodedWaveform } from './waveform-cache.js';
import { encodeWaveformPeaks } from './waveform-binary.js';
import { getOrComputeBeatGrid } from './beatgrid-cache.js';
import { createGridOffsets } from './grid-offset.js';
import { VALID_SIDES } from './deck-timecode.js';
import { getOrComputeKey } from './key-cache.js';
import { relativeTrackPath } from './library-directory.js';
import { createUploads } from './uploads.js';
import { xwaxUnderstands } from './xwax-capabilities.js';

const execFileAsync = promisify(execFile);

// The browser UI's own files.
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));

// 10Hz: fast enough for a live meter, slow enough not to compete with the audio thread.
const SIGNAL_STREAM_INTERVAL_MS = 100;

// Where a diagnostics bundle goes.
const DIAGNOSTICS_URL = 'https://waxcode.co/api/diagnostics';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  // Nothing serves video any more - the wake-lock fallback that needed it is gone
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

/** Serves a file from web/, or returns false so the caller falls through to the API routes. */
async function serveStatic(req, res) {
  const pathname = decodeURIComponent(new URL(req.url, 'http://box').pathname);
  /** A path ending in "/" means the index inside it, not the directory itself */
  const wanted = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const filePath = resolve(WEB_ROOT, '.' + wanted);
  // resolve has already collapsed any ".." - this rejects anything that escaped web/.
  if (filePath !== WEB_ROOT.replace(/\/$/, '') && !filePath.startsWith(WEB_ROOT)) return false;
  let data;
  try {
    data = await readFile(filePath);
  } catch {
    return false;
  }
  const type = MIME[extname(filePath)] ?? 'application/octet-stream';

  /** Byte ranges, which for Safari are not optional. */
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const [, rawStart, rawEnd] = range;
    // A suffix range ("-500") means the LAST 500 bytes, not from 0 to 500.
    const start = rawStart === '' ? Math.max(0, data.length - Number(rawEnd)) : Number(rawStart);
    const end = rawStart === '' || rawEnd === '' ? data.length - 1 : Math.min(Number(rawEnd), data.length - 1);

    if (start >= data.length || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
      res.end();
      return true;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Range': `bytes ${start}-${end}/${data.length}`,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    res.end(data.subarray(start, end + 1));
    return true;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': data.length,
    // Advertised even on a full response, or a client never knows it may ask for part of one.
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  res.end(data);
  return true;
}

/** The HTTP API surface for the Node brain: serves the cached library as JSON, and triggers a (re-)scan on demand. */
export function createServer({
  deckCount = 1,
  deckStatusRegistry: providedDeckStatusRegistry,
  devices: providedDevices,
  mountRoot = '/media/pidvs',
  labelDir = '/dev/disk/by-label',
  uuidDir = '/dev/disk/by-uuid',
  readMountsFn = () => readFile('/proc/mounts', 'utf8'),
  execFileFn = execFileAsync,
  onTrackScanned,
  onFastScan,
  onDeviceAttached,
  isWaveformCachedFn = isWaveformCached,
  // Injectable like isWaveformCachedFn, for the same reason - tests need to control it.
  cachedPathCheckerFn = cachedPathChecker,
  // The same bound deck functions index.js builds, so there is only ever one control path.
  deckControl,
  recorder,
  recordLevel = null,
  gridOffsets = createGridOffsets(),
  favourites,
  wifiProvisioning = null,
  wifiMode = null,
  apPassword = null,
  boxIdentity = null,
  diagnostics = null,
  supportTunnel = null,
  selfUpdate = null,
  updateNotice = null,
  connectionPin = null,
  keyLockFeature = null,
  deckInputMode,
  deckTimecode,
  cacheDir,
  // One getter rather than five more injected stores - index.js already holds them all.
  deckState,
  exportRecording,
  /** Tracks sent from a laptop, staged on the box - see uploads.js. */
  uploads = createUploads(),
  /** What the xwax on this box can be told to do. */
  xwaxCan = xwaxUnderstands,
  /** A chosen order for the tracks in a folder, kept on the stick that holds them - see track-order.js. */
  trackOrder = null,
  /** Adds folders and tracks to a stick - see stick-writer.js, and the risk note at the top of it. */
  stickWriter = null,
} = {}) {
  // Keyed by device id (a stable physical-port id, eg.
  const devices = providedDevices ?? new Map();
  const orderStore = trackOrder ?? null;

  /** Staged uploads do not survive a restart, on purpose - see clearAll. */
  uploads.clearAll();

  // One status poller per deck, created lazily on that deck's first subscriber (SSE) and stopped once its last one disconnects
  const deckStatusRegistry = providedDeckStatusRegistry ?? createDeckStatusRegistry({ deckCount });
  const { statusPollerFor } = deckStatusRegistry;

  // Bumped per-device on every /scan, /library/error, or /library/removed call
  const scanGenerations = new Map();

  /** A rescan after a write, held back until the writes stop. */
  const RESCAN_SETTLE_MS = 1200;
  const pendingRescans = new Map();

  /** How many writes are in flight per device. */
  const writesInFlight = new Map();

  function writeStarted(deviceId) {
    writesInFlight.set(deviceId, (writesInFlight.get(deviceId) ?? 0) + 1);
    // Anything already scheduled is wrong now - more work has arrived since.
    clearTimeout(pendingRescans.get(deviceId));
    pendingRescans.delete(deviceId);
  }

  function writeFinished(deviceId, device) {
    const left = (writesInFlight.get(deviceId) ?? 1) - 1;
    if (left > 0) { writesInFlight.set(deviceId, left); return; }
    writesInFlight.delete(deviceId);
    rescanWhenSettled(device);
  }

  function rescanWhenSettled(device) {
    clearTimeout(pendingRescans.get(device.id));
    const timer = setTimeout(() => {
      pendingRescans.delete(device.id);
      /** Re-read from the map: the stick may have been pulled while this was waiting */
      const still = devices.get(device.id);
      /** And still nothing being written. */
      if (still?.root && !writesInFlight.has(device.id)) {
        startScan(still.id, still.name, still.root, still.volumeId);
      }
    }, RESCAN_SETTLE_MS);
    // Never a reason to hold the process open - a pending rescan is not work worth delaying a stop.
    timer.unref?.();
    pendingRescans.set(device.id, timer);
  }

  function bumpGeneration(deviceId) {
    const next = (scanGenerations.get(deviceId) ?? 0) + 1;
    scanGenerations.set(deviceId, next);
    return next;
  }

  // A read-only, computed-at-response-time addition (see waveform-cache.js)
  /** Memoised briefly: a 3,115-track stick is expensive enough to build that back-to-back
   * requests should share one. */
  const LIBRARY_MEMO_MS = 1500;
  let libraryMemo = null;

  function invalidateLibraryMemo() {
    libraryMemo = null;
  }

  function libraryResponse() {
    if (libraryMemo && Date.now() - libraryMemo.at < LIBRARY_MEMO_MS) return libraryMemo.value;
    const value = {
      devices: [...devices.values()].map((device) => {
        // One directory read for the whole device, not two syscalls per track.
        const isCached = cachedPathCheckerFn({ volumeId: device.volumeId, cacheDir });
        return {
          ...device,
          tracks: device.tracks.map((track) => ({
            ...track,
            cached: isCached(relativeTrackPath(track.path, device.root)),
          })),
        };
      }),
    };
    libraryMemo = { at: Date.now(), value };
    return value;
  }

  // Shared by POST /scan and discoverAlreadyMountedDevices below
  /** What each mount point is formatted as, straight from /proc/mounts. */
  async function filesystemTypes() {
    try {
      const mounts = await readMountsFn();
      return new Map(mounts.split('\n')
        .map((line) => line.split(' '))
        .filter((fields) => fields.length > 2)
        .map((fields) => [fields[1], fields[2]]));
    } catch {
      return new Map();
    }
  }

  function startScan(deviceId, deviceName, mountPath, volumeId = '') {
    const thisGeneration = bumpGeneration(deviceId);

    /** A RESCAN keeps showing what it already knows until the new answer is ready. */
    const previous = devices.get(deviceId);
    const rescan = Boolean(previous?.root === mountPath && previous.tracks.length > 0);
    const collected = [];

    devices.set(deviceId, {
      id: deviceId,
      name: deviceName,
      root: mountPath,
      scanning: true,
      tracks: rescan ? previous.tracks : [],
      playlists: rescan ? previous.playlists : [],
      folders: rescan ? previous.folders : [],
      error: null,
      volumeId,
      fsType: rescan ? previous.fsType : null,
    });
    invalidateLibraryMemo();

    // Filled in behind the scan rather than blocking it - nothing waits on knowing this.
    void filesystemTypes().then((types) => {
      const device = devices.get(deviceId);
      if (!device || device.root !== mountPath) return;
      device.fsType = types.get(mountPath) ?? null;
      invalidateLibraryMemo();
    });

    // Marks this stick as "still in circulation" (see waveform-cache.js's cleanupStaleVolumes) every time it's actually inserted
    if (volumeId) touchVolumeLastSeen(volumeId);
    // The stick's packed waveform file may have been rewritten since we last indexed it.
    if (volumeId) clearStickWaveforms(volumeId);
    // Lets favourites.js move anything this box still holds for the stick onto the stick itself, now that it's here and writable
    if (volumeId) onDeviceAttached?.(volumeId, mountPath);

    scanLibrary(mountPath, {
      // Fires almost immediately (a directory walk, not tag reading) with the device's true full path list
      onFilesFound: (paths) => {
        if (scanGenerations.get(deviceId) !== thisGeneration) return;
        onFastScan?.(paths.map((path) => ({ path, volumeId, relativePath: relativeTrackPath(path, mountPath) })));
      },
      onPlaylists: (playlists) => {
        if (scanGenerations.get(deviceId) !== thisGeneration) return;
        const device = devices.get(deviceId);
        if (device) device.playlists = playlists;
      },
      /** Reported so a folder with nothing in it yet is still browsable */
      onFolders: (folders) => {
        if (scanGenerations.get(deviceId) !== thisGeneration) return;
        const device = devices.get(deviceId);
        if (device) device.folders = folders.map((path) => relativeTrackPath(path, mountPath));
        invalidateLibraryMemo();
      },
      onTrack: (track) => {
        if (scanGenerations.get(deviceId) !== thisGeneration) return;
        const current = devices.get(deviceId);
        if (!current) return; // removed mid-scan
        collected.push(track);
        // On a rescan the OLD list stays up; this one goes in all at once when the scan finishes.
        if (!rescan) devices.set(deviceId, { ...current, tracks: [...current.tracks, track] });
        // Streamed per-track as the scan discovers them, not batched until the whole device is scanned
        onTrackScanned?.({ path: track.path, volumeId, relativePath: relativeTrackPath(track.path, mountPath) });
      },
    }).then(() => {
      if (scanGenerations.get(deviceId) !== thisGeneration) return;
      const current = devices.get(deviceId);
      if (!current) return;
      devices.set(deviceId, { ...current, scanning: false, tracks: rescan ? collected : current.tracks });
      invalidateLibraryMemo();

      // Hand back what this scan learned, so the next insert - here or on any other box - costs a directory walk rather than opening every file.
      const entries = current.tracks.map((track) => ({ ...track, relativePath: relativeTrackPath(track.path, mountPath) }));
      const manifest = buildStickManifest(mountPath, entries, { playlists: current.playlists });
      // Only make the stick writable if there is genuinely something to save.
      if (manifest.changed) withWritableStick(mountPath, () => manifest.commit());
    }).catch((err) => {
      if (scanGenerations.get(deviceId) !== thisGeneration) return;
      devices.set(deviceId, { id: deviceId, name: deviceName, root: null, scanning: false, tracks: [], error: err.message, volumeId });
      invalidateLibraryMemo();
    });
  }

  // Recovers from Node's own restart, not just the box's
  async function discoverAlreadyMountedDevices() {
    let entries;
    try {
      entries = await readdir(mountRoot, { withFileTypes: true });
    } catch {
      return; // mount root doesn't exist (eg. this box's very first boot) - nothing to discover
    }

    // A directory existing under mountRoot does NOT mean something is actually mounted there
    let mountedTargets = null;
    try {
      const mounts = await readMountsFn();
      mountedTargets = new Set(
        mounts.split('\n').map((line) => line.split(' ')[1]).filter(Boolean)
      );
    } catch {
      mountedTargets = null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const deviceId = entry.name;
      const mountPath = join(mountRoot, deviceId);
      if (mountedTargets && !mountedTargets.has(mountPath)) continue;
      const name = await deviceLabel(deviceId, mountPath);
      const volumeId = await deviceVolumeId(deviceId, mountPath);
      startScan(deviceId, name, mountPath, volumeId);
    }
  }

  // /dev/disk/by-label's symlinks point at kernel device names (sda1), not at mount paths.
  async function resolveKernelDeviceName(mountPath) {
    try {
      const mounts = await readMountsFn();
      for (const line of mounts.split('\n')) {
        const [source, target] = line.split(' ');
        if (target === mountPath) return source.replace(/^\/dev\//, '');
      }
    } catch {
      // No /proc/mounts to read, which is normal off Linux.
    }
    return null;
  }

  async function deviceLabel(deviceId, mountPath) {
    let kernelName = deviceId;
    try {
      kernelName = (await resolveKernelDeviceName(mountPath)) ?? deviceId;
      const labels = await readdir(labelDir);
      for (const label of labels) {
        const target = await readlink(join(labelDir, label)).catch(() => null);
        // by-label symlinks are relative (../../sda1), so match on the tail.
        if (target?.endsWith(`/${kernelName}`)) return label;
      }
    } catch {
      // fall through to the vendor/model fallback below
    }

    // No matching volume label - fall back to the USB device's own vendor/model strings via udevadm
    try {
      const { stdout } = await execFileFn('udevadm', ['info', '--query=property', `--name=/dev/${kernelName}`]);
      const vendor = /^ID_VENDOR=(.*)$/m.exec(stdout)?.[1];
      const model = /^ID_MODEL=(.*)$/m.exec(stdout)?.[1];
      const name = [vendor, model].filter(Boolean).join(' ').replace(/_/g, ' ').trim();
      if (name) return name;
    } catch {
      // fall through to the id itself below
    }

    return deviceId; // best-effort - a missing label/vendor/model shouldn't block discovery
  }

  // Same /dev/disk/by-<x> symlink-matching technique as deviceLabel just above, against by-uuid instead of by-label
  async function deviceVolumeId(deviceId, mountPath) {
    try {
      const kernelName = (await resolveKernelDeviceName(mountPath)) ?? deviceId;
      const uuids = await readdir(uuidDir);
      for (const uuid of uuids) {
        const target = await readlink(join(uuidDir, uuid)).catch(() => null);
        if (target?.endsWith(`/${kernelName}`)) return uuid;
      }
    } catch {
      // fall through
    }
    return '';
  }

  /** The attached device a track path sits under - needed to key the analysis caches by volume. */
  function deviceForPath(path) {
    return [...devices.values()].find((device) => device.root && path.startsWith(`${device.root}/`));
  }

  /** Shared by the three analysis routes - they differ only in which compute function they call. */
  async function serveAnalysis(req, res, compute, { binary = false } = {}) {
    const path = new URL(req.url, 'http://box').searchParams.get('path');
    if (!path) {
      respondJson(res, 400, { error: 'path is required' });
      return;
    }
    const device = deviceForPath(path);

    /** A client that has moved on should not leave a decode running. */
    const controller = new AbortController();
    res.on('close', () => controller.abort());

    try {
      const result = await compute(path, {
        cacheDir,
        volumeId: device?.volumeId ?? '',
        relativePath: device ? relativeTrackPath(path, device.root) : path,
        priority: 'ondemand',
        signal: controller.signal,
      });
      if (result === null || result === undefined) {
        respondJson(res, 404, { error: 'not available for this track' });
        return;
      }
      if (binary) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(result);
        return;
      }
      respondJson(res, 200, result);
    } catch (err) {
      // An abort is the client leaving, not a failure - and there is nobody left to tell anyway.
      if (controller.signal.aborted || err.name === 'AbortError') return;
      respondJson(res, 500, { error: err.message });
    }
  }

  discoverAlreadyMountedDevices();

  /** The probe paths each OS uses to decide whether a network has working internet. */
  const CAPTIVE_PROBE_PATHS = new Set([
    '/hotspot-detect.html',        // iOS, macOS
    '/library/test/success.html',  // older iOS
    '/generate_204',               // Android
    '/gen_204',                    // Android
    '/connecttest.txt',            // Windows
    '/ncsi.txt',                   // Windows
    '/canonical.html',             // Firefox
    '/success.txt',                // Firefox, NetworkManager's own check
  ]);

  const server = createHttpServer(async (req, res) => {
    // Declared here, not beside the deck routes
    const pathname = req.url.split('?')[0];

    /** Captive portal, so joining the setup network opens this page by itself. */
    if (req.method === 'GET' && CAPTIVE_PROBE_PATHS.has(pathname) && wifiMode?.isApUp()) {
      /** Straight to SETUP, not the deck screen and not the settings pane inside it. */
      res.writeHead(302, { Location: '/#setup', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    /** The connection PIN, for a LAN that is not somewhere you trust. */
    if (connectionPin) {
      if (pathname === '/pin') {
        if (req.method === 'GET') {
          respondJson(res, 200, connectionPin.status(req));
          return;
        }
        if (req.method === 'POST') {
          /** Changing the setting needs a session WHEN one is already required - otherwise anybody on the network could simply turn the gate off. */
          if (connectionPin.enabled() && !connectionPin.unlocked(req)) {
            respondJson(res, 401, { error: 'enter the current PIN first' });
            return;
          }
          const body = await readJsonBody(req).catch(() => null);
          const result = connectionPin.configure({ enabled: body?.enabled, pin: body?.pin });
          if (result.token) {
            res.setHeader('Set-Cookie', cookieHeader(result.token, result.maxAgeMs, isSecureRequest(req)));
          }
          respondJson(res, result.ok ? 200 : 400, result);
          return;
        }
      }

      if (pathname === '/pin/unlock' && req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => null);
        const result = connectionPin.unlock(req, body?.pin);
        if (result.ok) {
          res.setHeader('Set-Cookie', cookieHeader(result.token, result.maxAgeMs, isSecureRequest(req)));
          respondJson(res, 200, { ok: true });
          return;
        }
        respondJson(res, result.reason === 'too-many-attempts' ? 429 : 401, result);
        return;
      }

      if (connectionPin.blocked(req, pathname)) {
        respondJson(res, 401, { error: 'this box is PIN protected', pinRequired: true });
        return;
      }
    }

    if (req.method === 'GET' && req.url === '/status') {
      const decks = {};
      await Promise.all(
        Array.from({ length: deckCount }, (_, i) => i + 1).map(async (n) => {
          decks[n] = await isDeckRunning(n);
        })
      );
      // "ready" (both Node and every deck's xwax up) is the app's "Online" state; Node responding with ready:false is "Starting".
      respondJson(res, 200, {
        ready: Object.values(decks).every(Boolean),
        decks,
      });
      return;
    }

    // USB hotplug hooks (see pi/usb-mount.sh, triggered by udev on insert/remove) - local-only, not token-gated.
    if (req.url === '/library/error' && req.method === 'POST') {
      if (!isLocal(req)) {
        respondJson(res, 403, { error: 'local only' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        respondJson(res, 400, { error: 'malformed JSON body' });
        return;
      }
      if (!body?.device) {
        respondJson(res, 400, { error: 'device is required' });
        return;
      }
      bumpGeneration(body.device); // an explicit error supersedes any scan still in flight for this device
      devices.set(body.device, {
        id: body.device,
        name: body.name ?? body.device,
        root: null,
        scanning: false,
        tracks: [],
        error: body.message ?? 'Unknown error',
      });
      respondJson(res, 200, { ok: true });
      return;
    }

    if (req.url === '/library/removed' && req.method === 'POST') {
      if (!isLocal(req)) {
        respondJson(res, 403, { error: 'local only' });
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        respondJson(res, 400, { error: 'malformed JSON body' });
        return;
      }
      if (!body?.device) {
        respondJson(res, 400, { error: 'device is required' });
        return;
      }
      // Deletes the device's entry outright rather than keeping it around greyed out
      const removedDevice = devices.get(body.device); // read before deleting - need its root below
      bumpGeneration(body.device); // the files a scan in flight was reading may no longer exist
      devices.delete(body.device);
      invalidateLibraryMemo();

      // Any deck currently loaded from the device that was just removed gets unloaded immediately
      if (removedDevice?.root) {
        const removedPrefix = `${removedDevice.root}/`;
        for (let deckNumber = 1; deckNumber <= deckCount; deckNumber += 1) {
          const loadedPath = statusPollerFor(deckNumber).lastStatus?.path;
          if (!loadedPath?.startsWith(removedPrefix)) continue;
          unloadTrack(deckNumber).catch((err) => {
            console.log(`[http-api] failed to unload deck ${deckNumber} after device ${body.device} removed: ${err.message}`);
          });
        }
      }

      respondJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && req.url === '/scan') {

      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        respondJson(res, 400, { error: 'malformed JSON body' });
        return;
      }

      if (!body?.device || !body?.path) {
        respondJson(res, 400, { error: 'device and path are required' });
        return;
      }

      // Responds immediately - the scan itself runs in the background (see startScan above for why).
      startScan(body.device, body.name ?? body.device, body.path, body.volumeId ?? '');
      respondJsonMaybeGzipped(req, res, 200, libraryResponse());
      return;
    }

    // The browser UI's own files. Unknown paths fall through to the API routes below.
    if (req.method === 'GET' && (await serveStatic(req, res))) return;

    /** No token gate on the HTTP surface (owner's call, 2026-09-25). */

    if (req.method === 'GET' && req.url === '/library') {
      respondJsonMaybeGzipped(req, res, 200, libraryResponse());
      return;
    }

    // Server-Sent Events, not polling from the app
    const statusStreamMatch = req.method === 'GET' && pathname.match(/^\/decks\/(\d+)\/status\/stream$/);
    if (statusStreamMatch) {
      const deckNumber = Number(statusStreamMatch[1]);
      const poller = statusPollerFor(deckNumber);
      if (!poller) {
        respondJson(res, 404, { error: `no such deck: ${deckNumber}` });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      poller.start(); // no-op if another subscriber already has it running

      /** sentAt is the box's own clock, stamped beside the status it describes */
      const unsubscribe = poller.subscribe((status) => {
        /** The time the status was READ, carried through - not stamped here. */
        res.write(`data: ${JSON.stringify({ ...status, sentAt: status.at })}\n\n`);
      });
      // The only way this stream ever ends - the client (app) closing its side
      req.on('close', () => {
        unsubscribe();
        if (poller.listenerCount === 0) poller.stop();
      });
      return;
    }

    /** The calibration screen's live meters. */
    if (req.method === 'GET' && pathname === '/signal/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const pollers = [];
      for (let deckNumber = 1; deckNumber <= deckCount; deckNumber++) {
        const poller = statusPollerFor(deckNumber);
        if (!poller) continue;
        poller.start(); // no-op if status notifications already have it running
        pollers.push(poller);
      }

      let polling = false;
      const poll = async () => {
        if (polling) return; // a slow reply must not stack requests up behind it
        polling = true;
        try {
          const decks = [];
          for (let deckNumber = 1; deckNumber <= deckCount; deckNumber++) {
            try {
              decks.push({ deck: deckNumber, ...(await statusPollerFor(deckNumber).requestSignal()) });
            } catch {
              decks.push({ deck: deckNumber, offline: true });
            }
          }
          if (!res.writableEnded) res.write(`data: ${JSON.stringify({ decks })}\n\n`);
        } finally {
          polling = false;
        }
      };

      const timer = setInterval(() => { poll().catch(() => {}); }, SIGNAL_STREAM_INTERVAL_MS);
      poll().catch(() => {});

      req.on('close', () => {
        clearInterval(timer);
        for (const poller of pollers) {
          if (poller.listenerCount === 0) poller.stop();
        }
      });
      return;
    }

    const loadMatch = req.method === 'POST' && pathname.match(/^\/decks\/(\d+)\/load$/);
    if (loadMatch) {
      const deckNumber = Number(loadMatch[1]);
      if (deckNumber < 1 || deckNumber > deckCount) {
        respondJson(res, 404, { error: `no such deck: ${deckNumber}` });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        respondJson(res, 400, { error: 'malformed JSON body' });
        return;
      }
      if (!body?.path) {
        respondJson(res, 400, { error: 'path is required' });
        return;
      }

      try {
        // deckControl's version stops that deck's passthrough first, exactly as the app's does
        await (deckControl?.loadTrack ?? loadTrack)(deckNumber, body.path);
        /** A sent file lives exactly as long as a deck is holding it - loading anything else on this deck is what releases the last one. */
        uploads.claim(deckNumber, body.path);
        respondJson(res, 200, { ok: true });
      } catch (err) {
        // Deliberately 502, not 500 - the request itself was fine, it's xwax on the other end of the socket that wasn't reachable (not running
        respondJson(res, 502, { error: `Couldn't reach deck ${deckNumber}: ${err.message}` });
      }
      return;
    }

    // Everything else a deck can be told to do.
    const deckActionMatch = req.method === 'POST' && pathname.match(/^\/decks\/(\d+)\/([a-z/-]+)$/);
    if (deckActionMatch) {
      const deckNumber = Number(deckActionMatch[1]);
      const action = deckActionMatch[2];
      if (deckNumber < 1 || deckNumber > deckCount) {
        respondJson(res, 404, { error: `no such deck: ${deckNumber}` });
        return;
      }

      // Most of these take no body at all, so a missing or malformed one is not an error here
      let body = {};
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        body = {};
      }

      const seconds = Number(body.seconds);
      try {
        // EVERY one of these returns a promise that rejects when the deck socket is not there, so every one has to be awaited inside this try.
        switch (action) {
          case 'play': await play(deckNumber); break;
          case 'pause': await pause(deckNumber); break;
          case 'unload': await unloadTrack(deckNumber); break;
          case 'cue': await gotoCue(deckNumber); break;
          case 'cue/play': await playCue(deckNumber); break;
          case 'cue/set': await setCue(deckNumber, Number.isFinite(seconds) ? seconds : 0); break;
          case 'seek': await seek(deckNumber, Number.isFinite(seconds) ? seconds : 0); break;
          case 'relocate': await relocate(deckNumber, Number.isFinite(seconds) ? seconds : 0); break;
          case 'loop':
            if (body.clear) await clearLoop(deckNumber);
            else await setLoop(deckNumber, Number(body.start), Number(body.end));
            break;
          // These need the versions index.js bound to the box's own stores (a deck's relative and key-lock choices are reapplied after a fresh xwax
          case 'passthrough':
            if (!deckControl) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            await deckControl.passthrough(deckNumber, body.on === true);
            break;
          case 'relative':
            if (!deckControl) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            await deckControl.setRelativeMode(deckNumber, body.on === true);
            break;
          case 'keylock': {
            if (!deckControl) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            /** The ONLY deck action whose result is inspected: key lock is an experiment that can be switched off box-wide */
            const result = await deckControl.setKeyLock(deckNumber, body.on === true);
            if (result?.ok === false) { respondJson(res, 409, result); return; }
            break;
          }
          case 'timecode-side':
            if (!deckTimecode) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            /** The FULL side name, which is what the store accepts, what /state reports, and what the env file holds. */
            if (!VALID_SIDES.includes(body.side)) {
              respondJson(res, 400, { error: `side must be one of ${VALID_SIDES.join(', ')}` });
              return;
            }
            /** The side is a LIVE setting now, not a startup argument. */
            deckTimecode.set(deckNumber, body.side);

            if (xwaxCan('TIMECODE')) {
              try {
                await setTimecode(deckNumber, body.side);
              } catch {
                /* Not running: it reads the env file when it starts. */
              }
              respondJson(res, 200, { ok: true, live: true });
              return;
            }

            /** An xwax too old to know TIMECODE. */
            {
              const before = statusPollerFor(deckNumber)?.lastStatus ?? null;
              if (deckControl?.restartDeck) await deckControl.restartDeck(deckNumber);

              if (before?.path && deckControl?.loadTrack) {
                try {
                  await deckControl.loadTrack(deckNumber, before.path);
                  if (typeof before.elapsed === 'number' && before.elapsed > 0) {
                    await deckControl.seek?.(deckNumber, before.elapsed);
                  }
                  if (before.cuePoint > 0) await setCue(deckNumber, before.cuePoint);
                  if (before.loopActive && before.loopEnd > before.loopStart) {
                    await setLoop(deckNumber, before.loopStart, before.loopEnd);
                  }
                } catch (err) {
                  console.log(`[deck ${deckNumber}] reload after side change failed: ${err.message}`);
                }
              }
            }
            respondJson(res, 200, { ok: true, live: false });
            return;
          case 'sensitivity':
            if (!deckControl) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            await deckControl.setSensitivity(deckNumber, Number(body.level));
            break;
          case 'restart':
            if (!deckControl) { respondJson(res, 501, { error: 'not wired on this server' }); return; }
            await deckControl.restartDeck(deckNumber);
            break;
          default:
            respondJson(res, 404, { error: `no such deck action: ${action}` });
            return;
        }
        respondJson(res, 200, { ok: true });
      } catch (err) {
        // Same reasoning as /load - the request was fine, xwax wasn't reachable.
        respondJson(res, 502, { error: `Couldn't reach deck ${deckNumber}: ${err.message}` });
      }
      return;
    }

    // Everything the deck screen needs to render itself on first paint, before any STATUS arrives.
    const deckStateMatch = req.method === 'GET' && pathname.match(/^\/decks\/(\d+)\/state$/);
    if (deckStateMatch) {
      if (!deckState) {
        respondJson(res, 501, { error: 'not wired on this server' });
        return;
      }
      respondJson(res, 200, deckState(Number(deckStateMatch[1])));
      return;
    }

    // Analysis.
    if (req.method === 'GET' && pathname === '/analysis/waveform') {
      await serveAnalysis(req, res, getOrComputeEncodedWaveform, { binary: true });
      return;
    }
    /** The same waveform, but arriving in slices so the overview can fill in as it decodes rather than appearing all at once ~900ms later. */
    if (req.method === 'GET' && pathname === '/analysis/waveform/stream') {
      const path = new URL(req.url, 'http://box').searchParams.get('path');
      if (!path) {
        respondJson(res, 400, { error: 'path is required' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const device = deviceForPath(path);
      const controller = new AbortController();
      // A client that navigates away mid-decode should stop the decode, not finish it unwatched.
      req.on('close', () => controller.abort());

      const send = (payload) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      try {
        const encoded = await getOrComputeEncodedWaveform(path, {
          cacheDir,
          volumeId: device?.volumeId ?? '',
          relativePath: device ? relativeTrackPath(path, device.root) : path,
          priority: 'ondemand',
          signal: controller.signal,
          onPartial: ({ startBucket, peaks }) => {
            if (controller.signal.aborted || peaks.length === 0) return;
            send({ startBucket, b64: encodeWaveformPeaks(peaks).toString('base64') });
          },
        });
        send({ done: true, b64: Buffer.from(encoded).toString('base64') });
      } catch (err) {
        send({ error: err.message });
      }
      res.end();
      return;
    }

    /** The beat grid, with this track's nudge already in it. */
    if (req.method === 'GET' && pathname === '/analysis/beatgrid') {
      await serveAnalysis(req, res, async (path, options) => {
        const grid = await getOrComputeBeatGrid(path, options);
        if (!grid) return grid;
        const offset = gridOffsets.get(options.volumeId, options.relativePath);
        return { ...grid, firstBeatSeconds: (grid.firstBeatSeconds ?? 0) + offset, offset };
      });
      return;
    }

    /** Nudging that grid. */
    if (req.method === 'POST' && pathname === '/analysis/beatgrid/offset') {
      const path = new URL(req.url, 'http://box').searchParams.get('path');
      const body = await readJsonBody(req).catch(() => null);
      if (!path || typeof body?.seconds !== 'number' || !Number.isFinite(body.seconds)) {
        respondJson(res, 400, { error: 'path and a finite seconds are required' });
        return;
      }
      const device = deviceForPath(path);
      const stored = gridOffsets.set(
        device?.volumeId ?? '',
        device ? relativeTrackPath(path, device.root) : path,
        body.seconds,
      );
      respondJson(res, 200, { ok: true, offset: stored });
      return;
    }
    if (req.method === 'GET' && pathname === '/analysis/key') {
      await serveAnalysis(req, res, getOrComputeKey);
      return;
    }

    /** The record input's live level, so somebody can see a signal arriving before committing to a take */
    if (req.method === 'GET' && pathname === '/record/level/stream' && recordLevel) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const unsubscribe = recordLevel.subscribe((reading) => {
        if (!res.writableEnded) res.write(`data: ${JSON.stringify(reading)}\n\n`);
      });
      req.on('close', unsubscribe);
      return;
    }

    /** Tracks sent straight from a laptop, so a mix is not gated on having the right USB stick. */
    if (req.method === 'POST' && pathname === '/uploads') {
      const declared = Number(req.headers['content-length']);
      try {
        const saved = await uploads.receive(req, new URL(req.url, 'http://box').searchParams.get('name'), {
          declaredBytes: Number.isFinite(declared) && declared > 0 ? declared : null,
        });
        /** The PATH is in the answer, because the client's next move is usually to load it onto a deck and it must not have to guess where this box */
        respondJson(res, 200, {
          name: saved.name, path: saved.path, bytes: saved.bytes, availableBytes: uploads.availableBytes(),
        });
      } catch (err) {
        /** A client that walked away mid-transfer is not an error worth reporting - the partial file is already gone, and there is nobody left to tell. */
        if (req.aborted || err.code === 'ECONNRESET') return;
        respondJson(res, err.status ?? 500, { error: err.message });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/uploads') {
      respondJson(res, 200, {
        /** The PATH as well as the name: a client that has just sent a track needs to load it, and must not have to guess where this box stages things. */
        tracks: uploads.entries().map(({ name, bytes, path }) => ({ name, bytes, path })),
        usedBytes: uploads.usedBytes(),
        availableBytes: uploads.availableBytes(),
        maxFileBytes: uploads.maxFileBytes,
      });
      return;
    }

    if (req.method === 'DELETE' && pathname.startsWith('/uploads/')) {
      const name = decodeURIComponent(pathname.slice('/uploads/'.length));
      if (!uploads.remove(name)) {
        respondJson(res, 404, { error: 'there is no staged track by that name' });
        return;
      }
      respondJson(res, 200, { ok: true, availableBytes: uploads.availableBytes() });
      return;
    }

    /** The recording, over the network - a second way to get a mix off the box that needs no stick. */
    if (req.method === 'GET' && pathname === '/record/download' && recorder) {
      const file = recorder.existing();
      if (!file) {
        respondJson(res, 404, { error: 'there is no recording to download' });
        return;
      }

      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      const start = range
        ? (range[1] === '' ? Math.max(0, file.bytes - Number(range[2])) : Number(range[1]))
        : 0;
      const end = range && range[1] !== '' && range[2] !== ''
        ? Math.min(Number(range[2]), file.bytes - 1)
        : file.bytes - 1;

      if (start >= file.bytes || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${file.bytes}` });
        res.end();
        return;
      }

      res.writeHead(range ? 206 : 200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${file.bytes}` } : {}),
        /** The name as recorded - "2026-09-30 21-15.mp3" - so a folder of these sorts itself and nobody has to work out which download was which set. */
        'Content-Disposition': `attachment; filename="${file.name.replace(/"/g, '')}"`,
        'Cache-Control': 'no-cache',
      });

      const stream = createReadStream(file.path, { start, end });
      // A browser that goes away mid-download should stop the read, not finish it unwatched.
      res.on('close', () => stream.destroy());
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    if (pathname === '/record' && recorder) {
      if (req.method === 'GET') {
        respondJson(res, 200, recorder.status());
        return;
      }
      if (req.method === 'POST') {
        let body = {};
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          body = {};
        }
        try {
          if (body.command === 'start') recorder.start();
          else if (body.command === 'stop') recorder.stop();
          else if (body.command === 'purge') recorder.remove();
          else if (body.command === 'export') {
            if (!exportRecording) {
              respondJson(res, 501, { error: 'not wired on this server' });
              return;
            }
            const result = await exportRecording();
            respondJson(res, 200, { ...recorder.status(), exported: result?.path ?? null });
            return;
          } else {
            respondJson(res, 400, { error: `unknown record command: ${body.command}` });
            return;
          }
          respondJson(res, 200, recorder.status());
        } catch (err) {
          respondJson(res, 500, { error: err.message });
        }
        return;
      }
    }

    /** A report about this box, for whoever supports it. */
    if (pathname === '/diagnostics' && diagnostics) {
      /** Wrapped, because a throw in here used to hang the REQUEST. */
      let bundle;
      try {
        bundle = await diagnostics.collect();
      } catch (err) {
        console.log(`[http] diagnostics could not be collected: ${err.message}`);
        respondJson(res, 500, { ok: false, reason: 'collect-failed', detail: err.message });
        return;
      }

      if (req.method === 'GET') {
        respondJson(res, 200, bundle);
        return;
      }
      if (req.method === 'POST') {
        /** Defaulted in CODE, not required from the environment. */
        const endpoint = process.env.PIDVS_DIAGNOSTICS_URL ?? DIAGNOSTICS_URL;
        if (!endpoint) {
          // Nowhere to send it is not a failure to collect it - hand it back so it can still be read, copied, or sent some other way.
          respondJson(res, 200, { ok: false, reason: 'no-endpoint', reference: bundle.reference, bundle });
          return;
        }
        try {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(process.env.PIDVS_UPDATE_TOKEN ? { Authorization: `Bearer ${process.env.PIDVS_UPDATE_TOKEN}` } : {}),
            },
            body: JSON.stringify(bundle),
            signal: AbortSignal.timeout(20000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          console.log(`[http] diagnostics sent, reference ${bundle.reference}`);
          respondJson(res, 200, { ok: true, reference: bundle.reference });
        } catch (err) {
          console.log(`[http] diagnostics send failed: ${err.message}`);
          respondJson(res, 200, { ok: false, reason: 'send-failed', detail: err.message, reference: bundle.reference, bundle });
        }
        return;
      }
    }

    /** The key lock experiment: off unless somebody opted in, having been told what it costs. */
    if (pathname === '/key-lock' && keyLockFeature) {
      if (req.method === 'GET') {
        respondJson(res, 200, { enabled: keyLockFeature.enabled() });
        return;
      }
      if (req.method === 'POST') {
        const body = await readJsonBody(req).catch(() => null);
        const result = keyLockFeature.setEnabled(body?.enabled);

        /** Turning it OFF must also clear what is already engaged */
        if (result.ok && result.enabled === false) {
          for (let deck = 1; deck <= 2; deck += 1) {
            await deckControl?.setKeyLock(deck, false)?.catch?.(() => {});
          }
        }
        respondJson(res, result.ok ? 200 : 500, result);
        return;
      }
    }

    /** Whether an update is waiting, answered from a cached check so opening a page costs nothing. */
    if (pathname === '/update/notice' && updateNotice) {
      if (req.method === 'GET') {
        respondJson(res, 200, updateNotice.notice());
        return;
      }
      if (req.method === 'POST') {
        /** Dismissal is recorded on the BOX, not in the browser: one owner, often two devices */
        const body = await readJsonBody(req).catch(() => null);
        respondJson(res, 200, updateNotice.dismiss(body?.version));
        return;
      }
    }

    /** Updates, pulled by the box itself. */
    if (pathname === '/update' && selfUpdate) {
      if (req.method === 'GET') {
        const [offered, safety] = await Promise.all([
          selfUpdate.check(),
          Promise.resolve(selfUpdate.safety()),
        ]);
        respondJson(res, 200, { ...offered, ...safety });
        return;
      }

      if (req.method === 'POST') {
        const offered = await selfUpdate.check();
        if (!offered.ok) { respondJson(res, 200, offered); return; }
        /** Spread FIRST, then set the verdict. */
        if (!offered.newer) { respondJson(res, 200, { ...offered, ok: false, reason: 'already-current' }); return; }

        /** Checked again HERE, not trusted from the GET. */
        const safety = selfUpdate.safety();
        if (!safety.safe) {
          respondJson(res, 200, { ...offered, ...safety, ok: false, reason: 'not-safe' });
          return;
        }

        /** Answered BEFORE applying: activate-file restarts this very server */
        respondJson(res, 200, { ...offered, ok: true, applying: offered.latest });
        selfUpdate.apply(offered).catch((err) => {
          console.log(`[self-update] failed: ${err.message}`);
        });
        return;
      }
    }

    /** A support session, opened and closed by whoever has the box. */
    if (pathname === '/support-tunnel' && supportTunnel) {
      if (req.method === 'GET') {
        respondJson(res, 200, { ok: true, ...supportTunnel.status() });
        return;
      }
      if (req.method === 'POST') {
        const answer = await supportTunnel.start();
        // 200 even for a refusal, like /diagnostics: the reason is the useful part and the caller renders it
        respondJson(res, 200, answer);
        return;
      }
      if (req.method === 'DELETE') {
        respondJson(res, 200, supportTunnel.stop());
        return;
      }
    }

    /** Look again for networks, which on this box means taking the setup network DOWN to do it. */
    if (req.method === 'POST' && pathname === '/network/rescan' && wifiProvisioning) {
      respondJson(res, 200, { ok: true, seconds: 20 });

      void (async () => {
        const hosting = wifiMode?.isApUp?.() ?? false;
        try {
          if (hosting) await wifiProvisioning.apDown();
          await wifiProvisioning.scan({ force: true });
        } catch (err) {
          console.log(`[network] rescan failed: ${err.message}`);
        } finally {
          /** Back up whatever happened, including after a failure. */
          if (hosting) {
            const back = await wifiProvisioning.apUp(apPassword?.get() ?? null);
            if (!back?.ok) console.log(`[network] could not restore the setup network: ${back?.detail}`);
          }
        }
      })();
      return;
    }

    if (pathname === '/network' && wifiProvisioning) {
      if (req.method === 'GET') {
        // Identity is merged in at the reporting site rather than inside the provisioning module
        respondJson(res, 200, {
          ...(await wifiProvisioning.status()),
          ...(boxIdentity?.describe() ?? {}),
          networks: await wifiProvisioning.scan(),
          // What the box has been TOLD about, as opposed to what it can currently see.
          saved: await wifiProvisioning.saved(),
          // WHY the setup network is up, if it is.
          ...(wifiMode ? wifiMode.describe() : {}),
          /** Shown, not hidden. */
          apPassword: apPassword?.get() ?? null,
          /** null means the setup network is OPEN and the portal must not let anyone past until a password is set - see ap-password.js. */
          apOpen: apPassword?.isOpen() ?? null,
        });
        return;
      }
      if (req.method === 'POST') {
        let body = {};
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          body = {};
        }
        // The admin password is read out of the request and goes no further - not into the log line below, not into the response, not onto disk.
        const result = await wifiProvisioning.join({
          ssid: body.ssid,
          psk: body.psk,
          adminPassword: body.adminPassword,
        });
    /** Named only once the whole form is RIGHT (owner's call, 2026-09-26). */
        if (result.ok && body.boxName && boxIdentity) boxIdentity.setName(body.boxName);
        console.log(`[http] network join ssid="${body.ssid}": ${result.ok ? 'ok' : result.reason}`);
        respondJson(res, result.ok ? 200 : 400, result);
        return;
      }
    }

    /** Changing the setup network's own password. */
    if (pathname === '/network/ap-password' && req.method === 'POST' && apPassword) {
      let body = {};
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        body = {};
      }
      const result = body.reset ? apPassword.reset() : apPassword.set(body.apPassword);
      // The password itself is never logged: this file's output ends up in diagnostics bundles.
      console.log(`[http] setup network password ${body.reset ? 'reset' : 'change'}: ${result.ok ? 'ok' : result.reason}`);
      respondJson(res, result.ok ? 200 : 400, result);
      return;
    }

    /** Removing a saved network, which is only reachable from the AP portal in practice. */
    if (pathname === '/network/forget' && req.method === 'POST' && wifiProvisioning) {
      let body = {};
      try {
        body = (await readJsonBody(req)) ?? {};
      } catch {
        body = {};
      }
      const result = await wifiProvisioning.forget(body.ssid);
      console.log(`[http] network forget ssid="${body.ssid}": ${result.ok ? 'ok' : result.reason}`);
      respondJson(res, result.ok ? 200 : 400, result);
      return;
    }

    /** Adding a folder or a track to a stick, from the browser. */
    if ((pathname === '/stick/folder' || pathname === '/stick/track') && stickWriter) {
      if (req.method !== 'POST' && req.method !== 'DELETE') {
        respondJson(res, 405, { error: 'POST or DELETE only' });
        return;
      }

      const query = new URL(req.url, 'http://box').searchParams;
      const device = devices.get(query.get('device') ?? '');
      if (!device?.root) { respondJson(res, 404, { error: 'no such device' }); return; }
      if (device.scanning) {
        respondJson(res, 409, { error: 'that stick is still being scanned - try again in a moment' });
        return;
      }

      /** Counted from HERE, before anything is read */
      writeStarted(device.id);

      /* The folder the client is adding INTO, as path segments. Empty means the stick's root. */
      const into = (query.get('folder') ?? '').split('/').filter(Boolean);

      try {
        /** Before the create branch, which reads a JSON body a DELETE does not carry */
        if (req.method === 'DELETE') {
          /** A whole relative path, not a folder plus a name: the client already knows exactly which row it is deleting */
          const gone = pathname === '/stick/folder'
            ? await stickWriter.removeFolder(device.root, query.get('path'))
            : await stickWriter.removeTrack(device.root, query.get('path'));
          writeFinished(device.id, device);
          respondJson(res, 200, { ok: true, ...gone });
          return;
        }

        if (pathname === '/stick/folder') {
          let body = {};
          try {
            body = (await readJsonBody(req)) ?? {};
          } catch {
            respondJson(res, 400, { error: 'malformed JSON body' });
            return;
          }
          const made = await stickWriter.makeFolder(device.root, into, body.name);
          writeFinished(device.id, device);
          respondJson(res, 200, { ok: true, ...made });
          return;
        }

        const declared = Number(req.headers['content-length']);
        const added = await stickWriter.addTrack(device.root, into, query.get('name'), req, {
          declaredBytes: Number.isFinite(declared) && declared > 0 ? declared : null,
        });
        /** Rescanned so the library describes what is actually on the stick now - but only once nothing is being written any more. */
        writeFinished(device.id, device);
        respondJson(res, 200, { ok: true, name: added.name, bytes: added.bytes });
        return;
      } catch (err) {
        /** Counted down on EVERY exit, or one failure would leave the device looking permanently busy and nothing would ever rescan it again. */
        writeFinished(device.id, device);
        if (req.aborted || err.code === 'ECONNRESET') return;
        respondJson(res, err.status ?? 500, { error: err.message });
        return;
      }
    }

    /** A chosen order for one folder's tracks, stored on the stick that holds them. */
    if (pathname === '/order' && orderStore) {
      const query = new URL(req.url, 'http://box').searchParams;
      const device = devices.get(query.get('device') ?? '');
      if (!device?.root) {
        respondJson(res, 404, { error: 'no such device' });
        return;
      }
      const folder = query.get('folder') ?? '';

      if (req.method === 'GET') {
        respondJson(res, 200, { names: orderStore.get(device.root, folder) });
        return;
      }

      if (req.method === 'POST') {
        let body = {};
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          respondJson(res, 400, { error: 'malformed JSON body' });
          return;
        }
        if (!Array.isArray(body.names)) {
          respondJson(res, 400, { error: 'names must be an array of filenames' });
          return;
        }
        /** A refusal is an ANSWER here: a stick that is genuinely read-only, or full, or was pulled mid-write cannot hold an order */
        const wrote = await orderStore.set(device.root, folder, body.names);
        respondJson(res, wrote ? 200 : 507, wrote ? { ok: true } : { error: 'that stick would not take it' });
        return;
      }
    }

    if (pathname === '/favourites' && favourites) {
      if (req.method === 'GET') {
        respondJson(res, 200, { favourites: favourites.list() });
        return;
      }
      if (req.method === 'POST') {
        let body = {};
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          body = {};
        }
        if (!body.volumeId || !body.path) {
          respondJson(res, 400, { error: 'volumeId and path are required' });
          return;
        }
        /** AWAITED, not fire-and-forget. */
        if (body.on === false) await favourites.remove(body.volumeId, body.path);
        else await favourites.add(body.volumeId, body.path);
        respondJson(res, 200, { favourites: favourites.list() });
        return;
      }
    }

    if (req.method === 'GET' && pathname === '/version') {
      let version = null;
      try {
        version = basename(readlinkSync(join(RELEASES_DIR, 'current')));
      } catch {
        // A box running from a checkout rather than a staged release has no symlink to read.
      }
      respondJson(res, 200, {
        version,
        /** Told, not guessed: the captive portal's fragment does not survive Apple's cut-down browser */
        onSetupNetwork: isOnSetupNetwork(req),
      });
      return;
    }

    if (pathname === '/input-mode' && deckInputMode) {
      if (req.method === 'GET') {
        respondJson(res, 200, { mode: deckInputMode.get() });
        return;
      }
      if (req.method === 'POST') {
        let body = {};
        try {
          body = (await readJsonBody(req)) ?? {};
        } catch {
          body = {};
        }
        deckInputMode.set(body.mode === 'phono' ? 'phono' : 'line');
        respondJson(res, 200, { mode: deckInputMode.get() });
        return;
      }
    }

    respondJson(res, 404, { error: 'not found' });
  });

  // Only stop pollers this server instance owns
  if (!providedDeckStatusRegistry) {
    server.on('close', () => deckStatusRegistry.stopAll());
  }

  return server;
}

/** JSON this size is mostly repeated field names and shared path prefixes */
function respondJsonMaybeGzipped(req, res, status, body) {
  const json = JSON.stringify(body);
  if (json.length < 4096 || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
    return;
  }
  const packed = gzipSync(json);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Encoding': 'gzip',
    'Content-Length': packed.length,
  });
  res.end(packed);
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  // EventSource cannot set request headers - it is the one client that has no way to send a bearer token
  const query = req.url.indexOf('?');
  return query === -1 ? null : new URLSearchParams(req.url.slice(query + 1)).get('token');
}

/** Whether this request came from somebody on the box's OWN setup network. */
export function isOnSetupNetwork(req) {
  /** BOTH ends, because the AP is NATted out through any wired link. */
  const setupSubnet = (value) => {
    const address = value?.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
    return Boolean(address?.startsWith('10.42.'));
  };
  return setupSubnet(req.socket.localAddress) || setupSubnet(req.socket.remoteAddress);
}

/** True if a request arrived on the box's WiFi interface specifically. */
export function isOverWifi(req, getInterfaces = networkInterfaces) {
  let address = req.socket.localAddress;
  if (address?.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  const wifiAddresses = (getInterfaces().wlan0 ?? []).map((i) => i.address);
  return wifiAddresses.includes(address);
}

/** True if a request arrived over loopback - the only requests that could realistically be pi/usb-mount.sh calling in from the box's own udev */
export function isLocal(req) {
  let address = req.socket.localAddress;
  if (address?.startsWith('::ffff:')) {
    address = address.slice('::ffff:'.length);
  }
  return address === '127.0.0.1' || address === '::1';
}

function respondJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Whether this request arrived over TLS. */
function isSecureRequest(req) {
  return req.socket?.encrypted === true;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
