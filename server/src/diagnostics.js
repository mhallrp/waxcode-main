import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BOX_HOME, RELEASES_DIR } from './box-paths.js';

const execFile = promisify(execFileCb);

/** Enough to be read out over the phone, short enough that nobody mistypes it. */
function reference(serial, at) {
  const digest = createHash('sha1').update(`${serial ?? ''}${at}`).digest('hex');
  // No I, O, 0 or 1 - they are the characters people get wrong reading aloud.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[parseInt(digest.slice(i * 2, i * 2 + 2), 16) % alphabet.length];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** Anything that looks like a secret, removed before it leaves the box. */
export function redact(text) {
  return String(text)
    .replace(/(password|psk|passwd|secret|token|bearer)(["'\s:=]+)(\S+)/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\b/g, '[redacted]') // anything JWT-shaped
    /** Everything after a `join` or `connect` on a logged command line. */
    /** Anchored to the COMMANDS that take a secret, not the bare words. */
    .replace(/((?:pidvs-network\s+join|wifi\s+connect)\s+(?:'[^']*'|"[^"]*"|\S+)\s+)\S+/gi, '$1[redacted]');
}

/** Each field is capped rather than the bundle as a whole: one runaway log must cost its own section */
const MAX_FIELD_CHARS = 40_000;
function clamp(text, limit = MAX_FIELD_CHARS) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}\n(truncated)`;
}

/** Raspberry Pi throttling flags, decoded. */
const THROTTLE_FLAGS = [
  [0, 'under-voltage right now'],
  [1, 'arm frequency capped right now'],
  [2, 'throttled right now'],
  [3, 'soft temperature limit active right now'],
  [16, 'under-voltage has occurred since boot'],
  [17, 'arm frequency capping has occurred since boot'],
  [18, 'throttling has occurred since boot'],
  [19, 'soft temperature limit has been hit since boot'],
];

export function decodeThrottled(raw) {
  const hex = String(raw ?? '').match(/0x([0-9a-f]+)/i)?.[1];
  if (!hex) return null;
  const bits = BigInt(`0x${hex}`);
  const flags = THROTTLE_FLAGS.filter(([bit]) => (bits >> BigInt(bit)) & 1n).map(([, name]) => name);
  return { raw: `0x${hex}`, flags, clean: flags.length === 0 };
}

/** Where the box's intent and xwax's reality disagree. */
export function settingMismatches(intended, status) {
  if (!intended || !status) return [];
  const out = [];
  const compare = (name, want, got, describe) => {
    if (want === null || want === undefined || got === null || got === undefined) return;
    if (want !== got) out.push(`${name}: the box has it ${describe(want)}, xwax reports ${describe(got)}`);
  };
  const onOff = (v) => (v ? 'ON' : 'OFF');
  /** Named as xwax names it, with the inversion spelled out. */
  compare('relative mode (i.e. position lock is OFF while this is ON)',
    intended.relative, status.relative, onOff);
  compare('key lock', intended.keyLock, status.keyLock, onOff);
  return out;
}

/** Everything worth knowing about a box that is misbehaving somewhere else. */
export function createDiagnostics({
  boxIdentity,
  wifiProvisioning = null,
  wifiMode = null,
  getDevices = () => [],
  deckCount = 2,
  statusPollerFor = () => null,
  serverVersion = null,
  /** What the box BELIEVES each deck is set to, as opposed to what xwax reports. */
  deckState = null,
  /** So the hostname of an open support session travels in the bundle */
  supportTunnel = null,
  watchdogDir = join(BOX_HOME, 'diagnostics'),
  releasesDir = RELEASES_DIR,
  execFileFn = execFile,
} = {}) {
  /** SSIDs only - a saved network's password is never read here, and never could be without root. */
  async function savedNetworkNames() {
    try {
      return (await wifiProvisioning.saved()).map((n) => n.ssid);
    } catch {
      return null;
    }
  }

  /** Gathers one section, and turns a failure into a note inside the bundle rather than no bundle. */
  async function section(name, gather, fallback = null) {
    try {
      return await gather();
    } catch (err) {
      return fallback ?? `(could not read ${name}: ${err.message})`;
    }
  }

  async function run(cmd, args) {
    try {
      const { stdout } = await execFileFn(cmd, args, { maxBuffer: 4 * 1024 * 1024 });
      return clamp(redact(stdout).trim());
    } catch (err) {
      return `(${cmd} failed: ${err.message})`;
    }
  }

  /** Whether a systemd unit is there, enabled and running - three genuinely different answers. */
  async function unitState(unit) {
    /** `systemctl show`, not `is-active`. */
    const out = await run('systemctl',
      ['show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'NRestarts', unit]);
    const field = (name) => out.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim() ?? null;
    const load = field('LoadState');
    if (load === null) return `unknown (${out.split('\n')[0]})`;
    // Never installed at all.
    if (load === 'not-found') return 'absent';
    const active = field('ActiveState') ?? 'unknown';
    const restarts = field('NRestarts');
    // Restarts only when there have been some: "restarts=0" on every unit is noise that hides the one line that matters
    return restarts && restarts !== '0' ? `${active} restarts=${restarts}` : active;
  }

  /** The shared dmix/dsnoop layer's real state, which is the only thing that couples the two decks. */
  async function sharedLayer(kind, path) {
    const status = await run('cat', [path]);
    const pid = status.match(/owner_pid\s*:\s*(\d+)/)?.[1] ?? null;
    let ownerAlive = null;
    if (pid) {
      const owner = await run('ps', ['-o', 'comm=', '-p', pid]);
      ownerAlive = Boolean(owner) && !/^\(/.test(owner) ? owner.trim() : false;
    }
    return {
      kind,
      status,
      ownerPid: pid,
      // false here is the smoking gun: a shared layer owned by a process that no longer exists.
      ownerAlive,
      ...(pid && ownerAlive === false
        ? { warning: 'the shared ALSA layer is owned by a process that no longer exists - this is the '
            + 'fault the dmix keepers exist to prevent, and only a reboot clears it' }
        : {}),
    };
  }

  return {
    reference,

    async collect() {
      const at = Date.now();
      const identity = boxIdentity?.describe() ?? {};

      const [journal, uptime, disk, memory, load] = await Promise.all([
        // Bounded: enough to see what led up to a problem, small enough to send over a phone's connection without anyone waiting for it.
        run('journalctl', ['-u', 'pidvs-server', '-n', '300', '--no-pager', '-o', 'short-iso']),
        run('uptime', ['-p']),
        run('df', ['-h', '/']),
        run('free', ['-h']),
        run('cat', ['/proc/loadavg']),
      ]);

      /** WHICH FIXES THIS BOX ACTUALLY HAS. */
      const provisioning = await section('provisioning', () => Promise.all([
        unitState('pidvs-dmix-keeper-playback.service'),
        unitState('pidvs-dmix-keeper-capture.service'),
        unitState('pidvs-boot-recovery.service'),
        run('sh', ['-c', 'test -x /usr/local/bin/pidvs-deck-watchdog && echo present || echo absent']),
        run('sh', ['-c', "grep -hs '^Storage=' /etc/systemd/journald.conf /etc/systemd/journald.conf.d/*.conf | tail -1 || echo '(default: volatile)'"]),
        run('sh', ['-c', 'journalctl --list-boots 2>/dev/null | wc -l']),
        run('sh', ['-c', "grep -c . /etc/asound.conf 2>/dev/null || echo absent"]),
        run('sh', ['-c', 'test -f /etc/udev/rules.d/41-pidvs-cable-presence.rules && echo present || echo absent']),
        run('sh', ['-c', 'test -f /etc/sudoers.d/pidvs-network && echo present || echo absent']),
        run('sh', ['-c', "grep -qs CAP_NET_BIND_SERVICE /etc/systemd/system/pidvs-server.service && echo present || echo absent"]),
        /** WHICH AUDIO ENGINE THIS BOX IS ACTUALLY RUNNING, and whether it can ever be updated. */
        /** The FIRST binary that exists, not a fallback chain: --version prints its banner and then exits non-zero */
        run('sh', ['-c', "for b in ~/bin/xwax /usr/local/bin/xwax; do [ -x \"$b\" ] && { \"$b\" --version 2>&1 | head -1 | cut -d' ' -f2; exit 0; }; done; echo unknown"]),
        run('sh', ['-c', "grep -hs '^ExecStart' /etc/systemd/system/xwax@.service | grep -q '/usr/local/bin/xwax' && echo 'card (never updated)' || echo 'over the air'"]),
        run('systemctl', ['--failed', '--no-legend', '--no-pager']),
      ]), []);
      const [
        keeperPlayback, keeperCapture, bootRecovery, deckWatchdog, journalStorage, boots,
        asoundConf, cableRule, networkGrant, portEighty, xwaxVersion, xwaxDelivery, failedUnits,
      ] = Array.isArray(provisioning) ? provisioning : [];

      /** The shared layer both decks attach to, and the processes attached to it. */
      const audioReadings = await section('audio', () => Promise.all([
        sharedLayer('playback', '/proc/asound/card0/pcm0p/sub0/status'),
        sharedLayer('capture', '/proc/asound/card0/pcm0c/sub0/status'),
        /** Priority is in here on purpose. */
        run('sh', ['-c', "ps -eo pid,pri,ni,rtprio,pcpu,pmem,etimes,comm,args | "
          + "grep -E 'xwax|alsaloop|ffmpeg|aplay|arecord|qmtempo' | grep -v grep || echo '(nothing holding audio open)'"]),
        run('sh', ['-c', 'vcgencmd measure_temp 2>/dev/null || echo unavailable']),
        run('sh', ['-c', 'vcgencmd get_throttled 2>/dev/null || echo unavailable']),
      ]), []);
      const [playbackLayer, captureLayer, audioProcesses, temperature, throttled] =
        Array.isArray(audioReadings) ? audioReadings : [];

      /* The box's own identity beyond a version string, and the watchdog's captures. */
      const [xwaxRevision, uptimeSeconds, watchdogFiles, watchdogLatest] = await Promise.all([
        run('sh', ['-c', `cat '${releasesDir}/current/xwax-src/REVISION' 2>/dev/null || echo unknown`]),
        run('sh', ['-c', "cut -d. -f1 /proc/uptime 2>/dev/null || echo unknown"]),
        run('sh', ['-c', `ls -1t '${watchdogDir}' 2>/dev/null | head -20 || echo '(no capture directory)'`]),
        /** The most RECENT capture in full. */
        run('sh', ['-c',
          `f="$(ls -1t '${watchdogDir}'/* 2>/dev/null | head -1)"; `
          + 'if [ -n "$f" ]; then echo "=== $f ==="; cat "$f"; else echo "(no captures - either the deck '
          + 'has never wedged, or this box has no watchdog installed)"; fi']),
      ]);
      const watchdog = { captures: watchdogFiles, latest: watchdogLatest };

      /** Kernel-level causes that no application log will ever mention */
      const kernel = await section('kernel log', () => run('sh', ['-c',
        "journalctl -k --no-pager -o short-iso 2>/dev/null "
        + "| grep -iE 'under-voltage|undervoltage|oom|killed process|throttl|xrun|brcmfmac: .*error|i2s|hifiberry' "
        + "| tail -60 || echo '(nothing relevant in the kernel log)'"]));

      /** The fault being chased appeared HOURS into a session */
      const serverEvents = await section('server events', () => run('sh', ['-c',
        "journalctl -u pidvs-server --no-pager -o short-iso 2>/dev/null "
        + "| grep -iE 'error|fail|xrun|overrun|crash|restart|oom|memory|throttl|alsaloop|stale|refus|could not' "
        + "| tail -200 || echo '(no events)'"]));

      const decks = await section('decks', async () => {
      const list = [];
      for (let n = 1; n <= deckCount; n += 1) {
        const status = statusPollerFor(n)?.lastStatus ?? null;
        const intended = deckState
          ? await section(`deck ${n} settings`, async () => deckState(n), null)
          : null;
        /** A LIVE timecode reading, not a remembered one. */
        const signal = await section(`deck ${n} signal`,
          () => statusPollerFor(n).requestSignal(), '(deck did not answer SIGNAL)');
        list.push({
          deck: n,
          // Kept at the top level as well as inside `status`
          state: status?.state ?? 'unknown',
          path: status?.path ?? null,
          timecodeValid: status?.timecodeValid ?? null,

          /** EVERY field xwax reports, not a hand-picked three. */
          status,
          intended,
          /** The comparison, computed rather than left to whoever reads this. */
          mismatches: settingMismatches(intended, status),
          signal,
          /** Did xwax restart mid-session? */
          service: await unitState(`xwax@${n}.service`),
          log: await run('journalctl', ['-u', `xwax@${n}`, '-n', '120', '--no-pager', '-o', 'short-iso']),
          /** xwax reports its own xruns, and those lines are what distinguish "the box was starved" from "the shared layer was broken". */
          xruns: await run('sh', ['-c',
            `journalctl -u xwax@${n} --no-pager -o short-iso 2>/dev/null `
            + "| grep -icE 'xrun|overrun|underrun' || echo 0"]),
        });
      }
      return list;
      // An array either way: waxcode-web rejects a bundle whose `decks` is not one.
      }, []);

      return {
        reference: reference(identity.serial, at),
        at: new Date(at).toISOString(),
        support: supportTunnel ? supportTunnel.status() : null,
        box: {
          ...identity,
          serverVersion,
          /** Which xwax commit is actually running. */
          xwaxRevision,
          uptime,
          // Seconds as well as the human form: "it was fine for six hours" needs a number to check against, and `uptime -p` rounds the detail away.
          uptimeSeconds,
        },
        network: {
          ...(wifiProvisioning ? await wifiProvisioning.status() : {}),
          // WHY the box is or is not broadcasting its own network.
          ...(wifiMode ? wifiMode.describe() : {}),
          // Guarded, not assumed.
          saved: await savedNetworkNames(),
        },
        decks,

        /** Which `pi/`-installed fixes this box actually has. */
        fixes: {
          dmixKeeperPlayback: keeperPlayback,
          dmixKeeperCapture: keeperCapture,
          bootRecovery,
          deckWatchdog,
          cablePresenceRule: cableRule,
          networkGrant,
          portEightyCapability: portEighty,
          /* The audio engine's own revision, and whether a release can ever replace it. */
          xwaxVersion,
          xwaxDelivery,
          asoundConfLines: asoundConf,
          journalStorage,
          bootsRecorded: boots,
        },

        /** The shared ALSA layer, which is the only thing coupling the two decks */
        audio: {
          sharedPlayback: playbackLayer,
          sharedCapture: captureLayer,
          processes: audioProcesses,
        },

        health: {
          load,
          temperature,
          // Sticky since boot, so it still answers for a brownout that happened hours ago.
          throttled: decodeThrottled(throttled) ?? throttled,
          failedUnits: failedUnits || '(none)',
        },

        /** What the deck watchdog captured BEFORE it restarted anything. */
        watchdog,

        storage: { disk, memory },
        // Counts, not contents: a track list is large, personal, and never the reason something is broken.
        library: getDevices().map((device) => ({
          id: device.id,
          name: device.name,
          scanning: device.scanning,
          tracks: (device.tracks ?? []).length,
          error: device.error ?? null,
        })),
        journal,
        serverEvents,
        kernel,
      };
    },
  };
}
