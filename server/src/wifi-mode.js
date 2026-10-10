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

/*
 * How long a join is allowed to hold the watcher off.
 *
 * A join takes the box off every network for a few seconds while nmcli brings the new one up. With
 * a cable in, that is indistinguishable from "nowhere to be" - so the watcher raised the AP ON TOP
 * of the join in progress, which interrupted the very connection the answer had to come back over.
 * Seen on hardware 2026-10-11: ap-up at 15:27:04, "The base network connection was interrupted",
 * and the join reported ok at 15:27:05 to a phone that was never going to hear it. The setup screen
 * read that as a failed join and went back to the form, and the AP it had just raised stayed up.
 *
 * A deadline rather than a flag, so a join that dies without ever reporting back cannot freeze the
 * watcher: worst case it waits this long and carries on.
 */
const JOIN_GRACE_MS = 45_000;

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
  /** When a join started, or 0. The watcher keeps its hands off the radio until it settles. */
  let joiningSince = 0;
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
    /* Nothing touches the radio while a join is in flight. The box is deliberately off every
     * network for those few seconds, and acting on that reading is acting on a transient. */
    if (joiningSince && nowFn() - joiningSince < JOIN_GRACE_MS) return;
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

    /** Called before a join touches the radio, so the watcher does not act on the gap it opens. */
    noteJoinStarted() {
      joiningSince = nowFn();
    },

    /** Called however a join ends, success or not: the radio has settled either way. */
    noteJoinSettled() {
      joiningSince = 0;
    },

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
