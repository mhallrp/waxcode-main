import { createServer as createHttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createServer } from './http-api.js';
import { networkInterfaces } from 'node:os';
import { advertise } from './bonjour-advertise.js';
import { createDeckStatusRegistry } from './deck-status-registry.js';
import { loadTrack, setRelativeMode, setKeyLock, setCue, gotoCue, playCue, seek, play, pause, relocate, setLoop, clearLoop, setSensitivity } from './deck-control.js';
import { stopDeckService, restartDeckService } from './xwax-lifecycle.js';
import { createDeckKeyLock } from './deck-key-lock.js';
import { createDeckSensitivity } from './deck-sensitivity.js';
import { createWifiProvisioning } from './wifi-provision.js';
import { createWifiMode } from './wifi-mode.js';
import { createApPassword } from './ap-password.js';
import { createBoxIdentity } from './box-identity.js';
import { createDiagnostics } from './diagnostics.js';
import { createSelfUpdate } from './self-update.js';
import { createUpdateNotice } from './update-notice.js';
import { createConnectionPin } from './connection-pin.js';
import { createKeyLockFeature } from './key-lock-feature.js';
import { readConfig, ensureRegistered } from './box-credential.js';
import { createSupportTunnel } from './support-tunnel.js';
import { DATA_DIR, RELEASES_DIR } from './box-paths.js';
import { readlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeckRunning } from './xwax-status.js';
import { createWaveformPrefetcher } from './waveform-prefetch.js';
import { cleanupStaleVolumes } from './waveform-cache.js';
import { getOrComputeBeatGrid } from './beatgrid-cache.js';
import { computeBeatGridViaAutocorrelation } from './beatgrid-autocorrelation.js';
import { computeBeatGridViaQm } from './beatgrid-qm.js';
import { PassthroughManager } from './passthrough.js';
import { createDeckTimecode } from './deck-timecode.js';
import { createDeckRelativeMode } from './deck-relative-mode.js';
import { createDeckInputMode } from './deck-input-mode.js';
import { createFavourites } from './favourites.js';
import { createStickStorage } from './stick-storage.js';
import { createTrackOrder } from './track-order.js';
import { createStickWriter } from './stick-writer.js';
import { createRecorder } from './recorder.js';
import { createRecordLevel } from './record-level.js';
import { statfsSync } from 'node:fs';
import { markReady, startLedStatusLoop } from './led-status.js';

const PORT = process.env.PORT || 8080;

// Two decks shipped by default.
/** A stray rejected promise must not take the box down. */
process.on('unhandledRejection', (reason) => {
  console.log(`[server] unhandled rejection, staying up: ${reason?.stack ?? reason}`);
});

const DECK_COUNT = process.env.DECK_COUNT ? Number(process.env.DECK_COUNT) : 2;

// Guard so `npm test` importing http-api.js doesn't also start a listener.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deckStatusRegistry = createDeckStatusRegistry({ deckCount: DECK_COUNT });
  const devices = new Map();
  // Where a real record comes out - line or the mixer's phono input.
  const deckInputMode = createDeckInputMode({ deckCount: DECK_COUNT });
  const passthrough = new PassthroughManager({ deckInputMode });
  const deckTimecode = createDeckTimecode();
  const deckRelativeMode = createDeckRelativeMode();
  const deckSensitivity = createDeckSensitivity({ deckCount: DECK_COUNT });

  // xwax resets sensitivity to 0 on init, so every path that can start a deck has to put it back
  const deckKeyLock = createDeckKeyLock();
  /** Whether key lock is available at all. */
  const keyLockFeature = createKeyLockFeature();
  /** Everything a starting deck needs that xwax does not remember for itself. */
  const reapplyDeckSettings = async (deckNumber) => {
    const level = deckSensitivity.get(deckNumber);
    if (level !== 0) setSensitivity(deckNumber, level);
    // Only when ON: sending KEYLOCK OFF to a deck that already starts off is noise, and this runs on every deck start.
    if (deckKeyLock.get(deckNumber)) {
      console.log(`[deck-key-lock] reapplying key lock on deck ${deckNumber}`);
      await setKeyLock(deckNumber, true, { keyLockStore: deckKeyLock, keyLockFeature });
    }
  };
  // Favourites live on the stick they describe, not on this box - see stick-storage.js.
  const stickStorage = createStickStorage();
  /** A chosen order for a folder's tracks, kept on the stick that holds them - see track-order.js. */
  const trackOrder = createTrackOrder({ stickStorage });
  const stickWriter = createStickWriter({ stickStorage });
  const recorder = createRecorder();
  // Captures nothing until a screen subscribes, and stops again when the last one closes.
  const recordLevel = createRecordLevel();

  /** Copies the recording onto whichever stick is mounted. */
  async function exportRecording() {
    const mounted = [...devices.values()].filter((device) => device.root);
    if (mounted.length === 0) throw new Error('Plug in a USB key first.');
    const mountPath = mounted[0].root;

    let freeBytesOnStick = 0;
    try {
      const stat = statfsSync(mountPath);
      freeBytesOnStick = stat.bavail * stat.bsize;
    } catch {
      throw new Error("Couldn't read the USB key.");
    }

    return recorder.exportTo({ mountPath, stickStorage, freeBytesOnStick });
  }
  const favourites = createFavourites({
    stickStorage,
    resolveMounted: () => [...devices.values()]
      .filter((device) => device.volumeId && device.root)
      .map((device) => ({ volumeId: device.volumeId, root: device.root })),
  });

  /** Queen Mary's beat tracker for tempo, this project's onset alignment for phase */
  const computeBeatGridPreferringQm = async (path, options) => {
    const viaQm = await computeBeatGridViaQm(path, options).catch(() => null);
    if (viaQm) return viaQm;
    console.log('[beatgrid] qmtempo unavailable or inconclusive, falling back to autocorrelation');
    return computeBeatGridViaAutocorrelation(path, options);
  };

  const getOrComputeBeatGridViaAutocorrelation = (path, options) =>
    getOrComputeBeatGrid(path, { ...options, computeBeatGridFn: computeBeatGridPreferringQm });


  // OFF unless the box carries an opt-in flag (owner's call, 2026-09-15) - see waveform-prefetch.js.
  const waveformPrefetcher = createWaveformPrefetcher({
    getOrComputeBeatGridFn: getOrComputeBeatGridViaAutocorrelation,
  });

  // Once at startup, then daily - deletes a stick's entire waveform cache once it hasn't been inserted in 30+ days.
  cleanupStaleVolumes();
  setInterval(() => cleanupStaleVolumes(), 24 * 60 * 60 * 1000);

  // Guarantees each deck's EnvironmentFile= actually exists on disk before xwax@N.service ever starts, not just in memory.
  for (let deckNumber = 1; deckNumber <= DECK_COUNT; deckNumber += 1) {
    deckTimecode.set(deckNumber, deckTimecode.get(deckNumber));
  }

  // Passthrough defaults on at start, but skips a deck whose xwax@N is already up.
  for (let deckNumber = 1; deckNumber <= DECK_COUNT; deckNumber += 1) {
    const xwaxAlreadyRunning = await isDeckRunning(deckNumber, { timeoutMs: 200 });
    if (xwaxAlreadyRunning) {
      console.log(`[index] deck ${deckNumber}: xwax already running at startup, not starting passthrough for it`);
      continue;
    }
    passthrough.start(deckNumber);
  }

  // The deck functions the HTTP surface is given, so every client drives the same path.
  const deckControl = {
    /** Passthrough must be stopped AND de-requested first, or it restarts underneath. */
    loadTrack: async (deckNumber, path) => {
      passthrough.stop(deckNumber);
      passthrough.setRequested(deckNumber, false);
      return loadTrack(deckNumber, path, { relativeModeStore: deckRelativeMode, onStarted: reapplyDeckSettings });
    },
    passthrough: (deckNumber, on) => {
      if (on) {
        stopDeckService(deckNumber).catch((err) => {
          console.log(`[http] passthrough deck ${deckNumber} stop failed: ${err.message}`);
        });
        deckStatusRegistry.statusPollerFor(deckNumber)?.markStopped();
        passthrough.start(deckNumber);
        passthrough.setRequested(deckNumber, true);
      } else {
        passthrough.setRequested(deckNumber, false);
      }
    },
    setRelativeMode: (deckNumber, on) => setRelativeMode(deckNumber, on, { relativeModeStore: deckRelativeMode, passthrough }),
    setKeyLock: (deckNumber, on) => setKeyLock(deckNumber, on, { keyLockStore: deckKeyLock, keyLockFeature, passthrough }),
    setSensitivity,
    restartDeck: (deckNumber) => restartDeckService(deckNumber, { onStarted: reapplyDeckSettings }),
    /** So a deck restarted for a timecode side change can be put back where the needle was, rather than reloading at zero */
    seek,
  };

  /** One definition of "what this deck is set to", shared by the HTTP surface and diagnostics. */
  const deckStateFor = (deckNumber) => ({
    passthrough: passthrough.isRequested(deckNumber),
    relative: deckRelativeMode.get(deckNumber),
    keyLock: deckKeyLock.get(deckNumber),
    timecodeSide: deckTimecode.get(deckNumber),
    sensitivity: deckSensitivity.get(deckNumber),
    inputMode: deckInputMode.get(),
  });

  /** The watcher and the provisioning module each need the other: a successful join has to stand the watcher down */
  let wifiMode = null;
  const wifiProvisioning = createWifiProvisioning({
    onJoinSucceeded: () => wifiMode?.noteJoinSucceeded(),
  });
  const boxIdentity = createBoxIdentity();
  const apPassword = createApPassword();
  wifiMode = createWifiMode({ wifiProvisioning, apPassword });
  const supportTunnel = createSupportTunnel();

  /** The box pulling its own updates, so the app is no longer required to deliver them. */
  const selfUpdate = createSelfUpdate({
    readIdentity: () => readConfig(DATA_DIR),
    readDecks: () => Array.from({ length: DECK_COUNT }, (_, i) => ({
      deck: i + 1,
      status: deckStatusRegistry.statusPollerFor(i + 1)?.lastStatus ?? null,
    })),
    isRecording: () => recorder.status().recording === true,
  });

  /** Carries the news that an update is waiting and leaves the decision to whoever is standing there. */
  const updateNotice = createUpdateNotice({ selfUpdate });
  const stopUpdateNotice = updateNotice.start();

  /** Off unless somebody asks for it. */
  const connectionPin = createConnectionPin();


  const diagnostics = createDiagnostics({
    boxIdentity,
    wifiProvisioning,
    wifiMode,
    /** Lets a bundle compare what the box thinks each deck is set to against what xwax actually reports */
    deckState: deckStateFor,
    supportTunnel,
    getDevices: () => [...devices.values()],   // a Map, as everything else here treats it
    deckCount: DECK_COUNT,
    statusPollerFor: deckStatusRegistry.statusPollerFor,
    // The staged release this box is running, read the same way GET /version does
    serverVersion: (() => {
      try {
        return basename(readlinkSync(join(RELEASES_DIR, 'current')));
      } catch {
        return null; // running from a checkout rather than a staged release
      }
    })(),
  });

  const server = createServer({
    deckCount: DECK_COUNT,
    deckStatusRegistry,
    devices,
    trackOrder,
    stickWriter,
    deckControl,
    recorder,
    recordLevel,
    exportRecording,
    favourites,
    deckInputMode,
    deckTimecode,
    wifiProvisioning,
    wifiMode,
    apPassword,
    boxIdentity,
    diagnostics,
    supportTunnel,
    selfUpdate,
    updateNotice,
    connectionPin,
    keyLockFeature,
    deckState: deckStateFor,
    onTrackScanned: (track) => waveformPrefetcher.enqueue([track]),
    // Fires once per device scan with its whole file list, well before onTrackScanned's slow per-track trickle
    onFastScan: (tracks) => waveformPrefetcher.enqueue(tracks),
    onDeviceAttached: (volumeId, mountPath) => {
      // Fire-and-forget: a stick that won't take them keeps them here, which is the fallback working, not a failure worth reporting into a scan.
      favourites.migrateToStick(volumeId, mountPath).catch(() => {});
    },
  });
  server.listen(PORT, () => {
    console.log(`Waxcode server listening on port ${PORT}`);
  });

  // Also answer on 80, so the address people type is just http://waxcodedvs.local with no port to remember.
  const plainPort = createHttpServer(server.listeners('request')[0]);
  plainPort.on('error', (err) => {
    console.log(`[http] port 80 not available (${err.code}) - reach the box on :${PORT} instead`);
  });
  plainPort.listen(80, () => console.log('Waxcode server also listening on port 80'));

  /** Register for updates, and keep trying. */
  const REGISTER_RETRY_MS = 15 * 60 * 1000;
  const keepRegistered = async () => {
    await ensureRegistered().catch(() => null);
  };
  void keepRegistered();
  setInterval(() => { void keepRegistered(); }, REGISTER_RETRY_MS).unref();

  /** Started only once the HTTP server is listening. */
  wifiMode.start();

  const bonjour = advertise(PORT);

  /* The box's ready signal: the HTTP server is listening and the decks can be driven. */
  markReady();
  const ledStatusLoop = startLedStatusLoop({ wifiMode });

  // systemd sends SIGTERM on stop/restart - unpublish cleanly so the service doesn't linger as a stale entry until the mDNS TTL expires.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await bonjour.stop();
      waveformPrefetcher.stop();
      // Before the cgroup kill takes ffmpeg with it - SIGINT lets it finalise the file.
      recorder.stop();
      deckStatusRegistry.stopAll();
      passthrough.stopAll();
      ledStatusLoop.stop();
      stopUpdateNotice();
      // A restart must not leave a way in: the cgroup kill would get it anyway
      supportTunnel.stop('server stopping');
      server.close(() => process.exit(0));
    });
  }
}
