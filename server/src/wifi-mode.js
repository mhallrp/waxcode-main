import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isCableCurrentlyPresent } from './cable-presence.js';
import { DATA_DIR } from './box-paths.js';

/** Decides when the box puts up its own setup network, and when it takes it down. */

// The escape hatch, same shape as enable-prefetch/disable-cache.
export const DISABLE_WIFI_MANAGEMENT_FLAG = 'disable-wifi-management';

const POLL_INTERVAL_MS = 5000;

/** Backoff for an action that keeps failing. */
const RETRY_BACKOFF_START_MS = 10_000;
const RETRY_BACKOFF_MAX_MS = 300_000;
const CABLE_FLAG = '/run/pidvs/cable-present';

/** The AP's own connection name, which is never something the box has "joined". */
const AP_CONNECTION_NAME = 'pidvs-setup';

/** Off every network for this long means stranded, not merely reconnecting. */
const STRANDED_AFTER_MS = 90_000;

/** One radio: an AP that never comes down means autoconnect never gets the chance to find the saved network again. */
const STAND_ASIDE_EVERY_MS = 3 * 60_000;
const STAND_ASIDE_FOR_MS = 25_000;

/** The mtime of the current cable insert, or null if nothing is plugged in. Identifies the session. */
function cableInsertId(flagPath) {
  try {
    return statSync(flagPath).mtimeMs;
  } catch {
    return null;
  }
}

export function createWifiMode({
  wifiProvisioning,
  /** Optional. */
  apPassword = null,
  isCablePresentFn = isCableCurrentlyPresent,
  cableInsertIdFn = cableInsertId,
  cableFlagPath = CABLE_FLAG,
  dataDir = DATA_DIR,
  pollIntervalMs = POLL_INTERVAL_MS,
  /** How long the box must be off every network before its AP goes up. */
  strandedAfterMs = STRANDED_AFTER_MS,
  /* How often the AP stands aside, and for how long, so the saved network can be found. */
  standAsideEveryMs = STAND_ASIDE_EVERY_MS,
  standAsideForMs = STAND_ASIDE_FOR_MS,
  nowFn = () => Date.now(),
  log = (message) => console.log(`[wifi-mode] ${message}`),
} = {}) {
  let timer = null;
  let acting = false;
  /** The cable insert whose management session a successful join already ended. */
  let joinedDuringInsert = null;
  let lastDesired = null;
  /** When the next attempt is allowed, and how long to wait after the one after that. */
  let retryAfter = 0;
  let retryDelay = RETRY_BACKOFF_START_MS;
  /** The last failure reported, so a stuck box says so once rather than once per attempt. */
  let lastFailure = null;
  /** When the box was first seen off every network, or null while it is on one. */
  let disconnectedSince = null;
  /** When the AP last stepped aside so autoconnect could have the radio. */
  let lastStoodAside = null;
  /** While set, the AP is deliberately down to leave the radio free. */
  let standAsideUntil = null;
  /** The last observed AP state, so a request handler can ask without shelling out to nmcli on every hit. */
  let lastApUp = false;

  const disabled = () => existsSync(join(dataDir, DISABLE_WIFI_MANAGEMENT_FLAG));

  /** Whether the AP belongs up right now, and why - the reason is reported, because "the box is broadcasting a network" is alarming without it. */
  async function desiredState() {
    if (disabled()) return { ap: false, reason: 'disabled' };

    if (isCablePresentFn(cableFlagPath)) {
      const insert = cableInsertIdFn(cableFlagPath);
      if (insert !== null && insert === joinedDuringInsert) {
        return { ap: false, reason: 'joined-during-this-insert' };
      }
      return { ap: true, reason: 'cable' };
    }

    // No cable. The only remaining reason to broadcast is having nowhere else to be.
    const saved = await wifiProvisioning.saved();
    if (saved.length === 0) return { ap: true, reason: 'no-saved-networks' };

    /** Saved networks are not the same as being ON one. */
    /** activeWifi, not status: it is unprivileged, and polling through sudo writes three journal lines every five seconds */
    const active = await wifiProvisioning.activeWifi();
    const connection = active?.connection ?? '';
    const connected = Boolean(connection) && connection !== AP_CONNECTION_NAME;

    if (connected) {
      disconnectedSince = null;
      lastStoodAside = null;
      standAsideUntil = null;
      return { ap: false, reason: 'station' };
    }

    if (disconnectedSince === null) disconnectedSince = nowFn();
    if (nowFn() - disconnectedSince < strandedAfterMs) {
      return { ap: false, reason: 'reconnecting' };
    }

    /** Up, but not for ever: one radio cannot host a network and look for another at the same time */
    if (standAsideUntil !== null) {
      if (nowFn() < standAsideUntil) return { ap: false, reason: 'standing-aside' };
      lastStoodAside = standAsideUntil;
      standAsideUntil = null;
    }

    if (nowFn() - (lastStoodAside ?? disconnectedSince) >= standAsideEveryMs) {
      standAsideUntil = nowFn() + standAsideForMs;
      return { ap: false, reason: 'standing-aside' };
    }

    return { ap: true, reason: 'stranded' };
  }

  /** Brings reality in line with the decision, re-asserting rather than tracking */
  async function reconcile() {
    if (acting) return;
    acting = true;
    try {
      const desired = await desiredState();
      const { ap } = await wifiProvisioning.activeWifi();
      // null is "nmcli could not say", which is not the same as "no AP up".
      if (ap === null) return;
      lastApUp = ap;

      if (desired.ap === ap) {
        // Reality agrees, so whatever was failing is not failing any more.
        if (lastFailure) log(`the setup network is ${ap ? 'up' : 'down'} again (was: ${lastFailure})`);
        lastFailure = null;
        retryAfter = 0;
        retryDelay = RETRY_BACKOFF_START_MS;
        lastDesired = desired.reason;
        return;
      }
      if (Date.now() < retryAfter) return; // still backing off from a failure - see the note above
      // Logged every time it acts, never every poll
      log(`${desired.ap ? 'raising' : 'lowering'} the setup network (${desired.reason})`);
      /** One last look around BEFORE the radio is committed to hosting. */
      if (desired.ap) {
        try {
          await wifiProvisioning.scan?.();
        } catch {
          // Deliberately swallowed, and optional at all: nothing about a scan may stop the AP.
        }
      }

      const result = desired.ap
        ? await wifiProvisioning.apUp(apPassword?.get())
        : await wifiProvisioning.apDown();
      if (!result.ok) {
        /** Reported once per DISTINCT reason, not once per attempt. */
        if (result.reason !== lastFailure) {
          log(`could not ${desired.ap ? 'raise' : 'lower'} it: ${result.reason}`
            + `${result.detail ? ` (${result.detail})` : ''} - retrying, backing off`);
          lastFailure = result.reason;
        }
        retryAfter = Date.now() + retryDelay;
        retryDelay = Math.min(retryDelay * 2, RETRY_BACKOFF_MAX_MS);
      } else {
        lastApUp = desired.ap;
        lastFailure = null;
        retryAfter = 0;
        retryDelay = RETRY_BACKOFF_START_MS;
      }
      lastDesired = desired.reason;
    } catch (err) {
      log(`reconcile failed: ${err.message}`);
    } finally {
      acting = false;
    }
  }

  return {
    desiredState,
    reconcile,

    /** Called by whatever drove a join, so the AP is not put straight back up on top of it. */
    noteJoinSucceeded() {
      joinedDuringInsert = cableInsertIdFn(cableFlagPath);
    },

    /** For diagnostics: what the box last decided and what is holding the AP up, if anything. */
    describe() {
      return { managementDisabled: disabled(), lastReason: lastDesired, lastFailure };
    },

    /** Whether the setup network is up, as last observed. Cheap enough to ask per request. */
    isApUp() {
      return lastApUp;
    },

    start() {
      if (timer) return;
      reconcile();
      timer = setInterval(reconcile, pollIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
