import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { UPDATER_CLI } from './box-paths.js';
import { serverVersion } from './box-version.js';
import { compareVersions } from './version-compare.js';

const execFileAsync = promisify(execFile);

/** The box fetching and installing its own updates. */

/** Defaulted in CODE, not the environment: an env var means editing the systemd unit */
const UPDATE_SERVER = 'https://www.waxcode.co';

/** The header the server side reads to know which box is asking. */
const BOX_ID_HEADER = 'x-waxcode-box';

/** A manifest is a few hundred bytes. Short, because somebody is watching a button when this runs. */
const CHECK_TIMEOUT_MS = 20_000;

/** A release is over a megabyte and may be coming down a domestic line. */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** Whether it is SAFE to install right now. */
export function updateSafety(decks, { recording = false } = {}) {
  const reasons = [];

  for (const deck of decks ?? []) {
    const status = deck?.status ?? null;
    if (status?.path) reasons.push(`deck ${deck.deck} has a track loaded`);
    if (status?.state === 'PLAYING') reasons.push(`deck ${deck.deck} is playing`);
    if (status?.timecodeValid) reasons.push(`deck ${deck.deck} has a needle on timecode`);
  }
  if (recording) reasons.push('a recording is running');

  return { safe: reasons.length === 0, reasons };
}

export function createSelfUpdate({
  updateServer = UPDATE_SERVER,
  updaterCli = UPDATER_CLI,
  fetchFn = fetch,
  execFileFn = execFileAsync,
  readIdentity,
  currentVersion = () => serverVersion(),
  downloadDir = tmpdir(),
  log = console.log,
  /** What "is anybody using this box" is read from. */
  readDecks = () => [],
  isRecording = () => false,
} = {}) {
  /** The box's own credential, read fresh: it is written during first-boot setup, not at startup. */
  function identity() {
    const config = readIdentity?.();
    if (!config?.id || !config?.token) return null;
    return config;
  }

  function headers(config) {
    return { Authorization: `Bearer ${config.token}`, [BOX_ID_HEADER]: config.id };
  }

  /** What the feed is offering, and whether it is newer than what is running. */
  async function check() {
    const config = identity();
    if (config === null) return { ok: false, reason: 'no-identity' };

    let manifest;
    try {
      const res = await fetchFn(`${updateServer}/api/updates/manifest`, {
        headers: headers(config),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
        /** NOT followed. */
        redirect: 'error',
      });
      if (res.status === 401) return { ok: false, reason: 'unauthorized' };
      if (!res.ok) return { ok: false, reason: 'feed-error', detail: `HTTP ${res.status}` };
      manifest = await res.json();
    } catch (err) {
      return { ok: false, reason: 'unreachable', detail: err.message };
    }

    /** The manifest's real shape, from tools/package-release.js rather than guessed. */
    const latest = manifest?.latest ?? null;
    if (!latest) return { ok: false, reason: 'no-releases' };

    const release = manifest?.releases?.[latest] ?? null;
    if (!release?.file) return { ok: false, reason: 'no-releases' };

    const running = currentVersion();
    return {
      ok: true,
      running,
      /** Reported WITH the v, because that is what every other surface shows - /version, the release directories, the web UI. */
      latest: `v${String(latest).replace(/^v/, '')}`,
      newer: compareVersions(latest, running) > 0,
      file: release.file,
      checksum: release.checksum ?? release.sha256 ?? null,
      minimumAppVersion: release.minimumAppVersion ?? null,
    };
  }

  /** Fetches a release to disk and checks it is what the manifest said it would be. */
  async function download(file, checksum) {
    const config = identity();
    // basename: `file` is whatever the feed's manifest said, and a path in it would otherwise
    // choose where this writes - before the checksum is even seen.
    const path = join(downloadDir, basename(file));
    const res = await fetchFn(`${updateServer}/api/updates/${file}`, {
      headers: headers(config),
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!res.ok) throw new Error(`downloading ${file}: HTTP ${res.status}`);

    await pipeline(Readable.fromWeb(res.body), createWriteStream(path));

    /** Verified HERE as well as by the updater. */
    if (checksum) {
      const hash = createHash('sha256');
      await pipeline(createReadStream(path), hash);
      const got = hash.digest('hex');
      if (got !== checksum) {
        await rm(path, { force: true });
        throw new Error(`checksum mismatch: expected ${checksum.slice(0, 12)}, got ${got.slice(0, 12)}`);
      }
    }

    const { size } = await stat(path);
    return { path, size };
  }

  /** Installs a release, through the updater that is already on the box. */
  async function apply(offered) {
    /** Takes what check RETURNS, field for field. */
    const { latest: version, file, checksum } = offered ?? {};
    if (!version || !file) throw new Error('apply needs the result of check(), with latest and file');

    const { path, size } = await download(file, checksum);
    log(`[self-update] fetched ${file} (${Math.round(size / 1024 / 1024)}MB), activating ${version}`);

    try {
      const { stdout } = await execFileFn('node', [updaterCli, 'activate-file', version.replace(/^v/, ''), path, checksum ?? '']);
      log(`[self-update] ${String(stdout).trim()}`);
      return { ok: true, version };
    } catch (err) {
      /** SUCCESS LOOKS LIKE THIS. */
      const killed = Boolean(err.killed) || typeof err.signal === 'string';
      const noExitCode = err.code === undefined || err.code === null;
      if (killed || noExitCode) {
        log(`[self-update] activating ${version}; this server is being restarted by it`);
        return { ok: true, version, restarted: true };
      }

      /** The updater's OWN words, not just "Command failed". */
      const detail = [err.stderr, err.stdout]
        .map((part) => String(part ?? '').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 500);
      log(`[self-update] activation of ${version} failed: ${detail || err.message}`);
      throw Object.assign(new Error(detail || err.message), { cause: err });
    } finally {
      await rm(path, { force: true });
    }
  }

  /** Whether it is safe to install right now, asked fresh every time it is asked. */
  function safety() {
    return updateSafety(readDecks(), {
      recording: isRecording(),
    });
  }

  return { check, download, apply, safety };
}
