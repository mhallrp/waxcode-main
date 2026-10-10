import { execFile as execFileCb, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { userInfo } from 'node:os';

const execFile = promisify(execFileCb);

/** One command as root, with the password on stdin. */
/** Runs a command with something secret on stdin, where it cannot be logged or read from /proc. */
function runWithInput(command, argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${command} exited ${code}`), { stderr, stdout, code }));
    });
    child.stdin.end(input);
  });
}

function sudoWithPassword(password, shellCommand) {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-S', '-k', '-p', '', 'sh', '-c', shellCommand]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`sudo exited ${code}`), { stderr, stdout, code }));
    });
    child.stdin.end(`${password}\n`);
  });
}

const PROVISIONING = join(dirname(fileURLToPath(import.meta.url)), '..', 'provisioning');
const HELPER = '/usr/local/bin/pidvs-network';
const SUDOERS = '/etc/sudoers.d/pidvs-network';
// The connection name pidvs-network.sh gives the box's own setup hotspot.
const AP_CONNECTION = 'pidvs-setup';

/** Puts the box on a wireless network, told to it over HTTP. */
export function createWifiProvisioning({
  execFileFn = execFile,
  sudoRun = sudoWithPassword,
  runWithInputFn = runWithInput,
  helperPath = HELPER,
  sudoersPath = SUDOERS,
  provisioningDir = PROVISIONING,
  boxUser = userInfo().username,
  /** Injectable only so a test can cross it without sleeping for twenty real seconds */
  scanCacheMs = 20000,
  /** Fired only on a join that actually worked */
  onJoinSucceeded = () => {},
} = {}) {
  /** True once the narrow grant is in place and no password is needed any more. */
  async function isBootstrapped() {
    try {
      await execFileFn('sudo', ['-n', helperPath, 'status']);
      return true;
    } catch {
      return false;
    }
  }

  /** Installs the helper and its sudoers entry, spending the password to do it. */
  async function install(password) {
    const script = join(tmpdir(), 'pidvs-network.staged.sh');
    const sudoers = join(tmpdir(), 'pidvs-network.staged.sudoers');
    writeFileSync(script, readFileSync(join(provisioningDir, 'pidvs-network.sh'), 'utf8'), { mode: 0o600 });
    // `__BOX_USER__` is the placeholder every file under pi/ uses - see provision.sh's substitute.
    writeFileSync(
      sudoers,
      readFileSync(join(provisioningDir, 'pidvs-network.sudoers'), 'utf8').replace(/__BOX_USER__/g, boxUser),
      { mode: 0o600 }
    );

    try {
      await sudoRun(password, [
        `install -m 0755 -o root -g root '${script}' '${helperPath}'`,
        `/usr/sbin/visudo -cf '${sudoers}'`,
        `install -m 0440 -o root -g root '${sudoers}' '${sudoersPath}'`,
      ].join(' && '));
    } finally {
      rmSync(script, { force: true });
      rmSync(sudoers, { force: true });
    }
  }

  /** Scan results are cached briefly. */
  let scanCache = { at: 0, networks: [] };

  /** The last scan that actually saw the neighbourhood, kept indefinitely. */
  let lastUseful = [];

  /** Nothing, or nothing but this box's own setup network. */
  const degenerate = (networks) => networks.every((seen) => seen.ssid.startsWith('Waxcode Setup'));

  return {
    isBootstrapped,

    /** What the box can see, so nobody has to type an SSID exactly right. */
    /** `force` skips the cache, for a deliberate "look again" - see the /network/rescan route. */
    async scan({ force = false } = {}) {
      if (!force && Date.now() - scanCache.at < scanCacheMs) return scanCache.networks;
      let stdout = '';
      try {
        ({ stdout } = await execFileFn('sudo', ['-n', helperPath, 'scan']));
      } catch {
        /** No grant yet - which is exactly the state a box is in the first time anyone sets it up */
        try {
          ({ stdout } = await execFileFn('nmcli',
            ['-t', '-f', 'SSID,SIGNAL,SECURITY', 'device', 'wifi', 'list', '--rescan', 'no']));
        } catch {
          return scanCache.networks;
        }
      }
      const strongest = new Map();
      for (const line of stdout.split('\n')) {
        // nmcli -t escapes colons inside fields, so an SSID containing one survives the split.
        const [ssid, signal, security] = line.split(/(?<!\\):/);
        if (!ssid) continue;
        const name = ssid.replace(/\\:/g, ':');
        const strength = Number(signal) || 0;
        if (!strongest.has(name) || strongest.get(name).signal < strength) {
          strongest.set(name, { ssid: name, signal: strength, secure: Boolean(security?.trim()) });
        }
      }
      const found = [...strongest.values()].sort((a, b) => b.signal - a.signal).slice(0, 30);
      if (!degenerate(found)) lastUseful = found;
      scanCache = {
        at: Date.now(),
        // What the radio can see now, or the last time it could see anything.
        networks: degenerate(found) && lastUseful.length ? lastUseful : found,
      };
      return scanCache.networks;
    },

    /** What the box is on right now, for the app to show. Works with or without the grant. */
    async status() {
      try {
        const { stdout } = await execFileFn('sudo', ['-n', helperPath, 'status']);
        return Object.fromEntries(
          stdout.trim().split('\n').filter(Boolean).map((line) => {
            const at = line.indexOf('=');
            return [line.slice(0, at), line.slice(at + 1)];
          })
        );
      } catch {
        return { bootstrapped: 'no' };
      }
    },

    /** Joins `ssid`, bootstrapping first if this box has never been given the grant. */
    async join({ ssid, psk, adminPassword }) {
      /** Every answer names the FIELD at fault, not just what went wrong. */
      if (!ssid) return { ok: false, reason: 'no-ssid', field: 'ssid' };

      if (!(await isBootstrapped())) {
        if (!adminPassword) return { ok: false, reason: 'needs-admin-password', field: 'adminPassword' };

        /** Checked on its own BEFORE anything is installed, rather than being inferred from a failed install. */
        try {
          await sudoRun(adminPassword, 'true');
        } catch (err) {
          const text = `${err.stderr ?? ''}${err.message ?? ''}`;
          if (/incorrect password|Sorry, try again|no password was provided/i.test(text)) {
            return { ok: false, reason: 'wrong-admin-password', field: 'adminPassword' };
          }
          return { ok: false, reason: 'bootstrap-failed', field: 'adminPassword', detail: firstLine(text) };
        }

        try {
          await install(adminPassword);
        } catch (err) {
          const text = `${err.stderr ?? ''}${err.message ?? ''}`;
          return { ok: false, reason: 'bootstrap-failed', field: 'adminPassword', detail: firstLine(`${err.stderr ?? ''}${err.message ?? ''}`) };
        }
        if (!(await isBootstrapped())) {
          return { ok: false, reason: 'bootstrap-incomplete', field: 'adminPassword' };
        }
      }

      try {
        // The PSK goes on stdin, not argv - sudo logs the command line and /proc/<pid>/cmdline is world-readable
        await runWithInputFn('sudo', ['-n', helperPath, 'join', ssid], `${psk ?? ''}\n`);
      } catch (err) {
        const text = `${err.stderr ?? ''}${err.message ?? ''}`;

        /** Exit 2 is SAVED BUT NOT JOINED, which is not a failure. */
        if (err.code === 2 || /^saved /m.test(text)) {
          /** `joined: false` and NOT a `saved` flag - /network already answers with `saved`, the LIST of known networks */
          return { ok: true, joined: false, ssid, ...(await this.status()) };
        }
        if (/password refused|Secrets were required|invalid.*password|802-11-wireless-security/i.test(text)) {
          return { ok: false, reason: 'wrong-wifi-password', field: 'password' };
        }
        if (/No network with SSID|not found/i.test(text)) {
          return { ok: false, reason: 'no-such-network', field: 'ssid' };
        }
        return { ok: false, reason: 'join-failed', field: 'password', detail: firstLine(text) };
      }

      onJoinSucceeded();
      return { ok: true, ...(await this.status()) };
    },

    /** The networks this box has been TOLD about, as opposed to the ones it can currently see. */
    async saved() {
      let stdout = '';
      try {
        ({ stdout } = await execFileFn('nmcli',
          ['-t', '-f', 'NAME,TYPE,ACTIVE', 'connection', 'show']));
      } catch {
        return [];
      }
      const networks = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        // nmcli -t escapes a colon inside a value, so an SSID containing one survives the split.
        const [name, type, active] = line.split(/(?<!\\):/);
        if (type !== '802-11-wireless') continue;
        const ssid = name.replace(/\\:/g, ':');
        if (ssid === AP_CONNECTION) continue;
        networks.push({ ssid, active: active === 'yes' });
      }
      return networks;
    },

    /** Which wireless connection is active, and whether it is the box's own AP - read WITHOUT root. */
    async activeWifi() {
      try {
        const { stdout } = await execFileFn('nmcli',
          ['-t', '-f', 'NAME,TYPE,DEVICE', 'connection', 'show', '--active']);
        for (const line of stdout.split('\n')) {
          const [name, type, device] = line.split(/(?<!\\):/);
          if (type !== '802-11-wireless' || device !== 'wlan0') continue;
          const connection = name.replace(/\\:/g, ':');
          return { connection, ap: connection === AP_CONNECTION };
        }
        return { connection: null, ap: false };
      } catch {
        /** Unknown, not "no AP". */
        return { connection: null, ap: null };
      }
    },

    /** Removes a saved network. The helper refuses the request that would strand the box. */
    async forget(ssid) {
      if (!ssid) return { ok: false, reason: 'no-ssid', field: 'ssid' };
      if (ssid === AP_CONNECTION) return { ok: false, reason: 'not-a-saved-network', field: 'ssid' };
      try {
        await execFileFn('sudo', ['-n', helperPath, 'forget', ssid]);
        return { ok: true };
      } catch (err) {
        const text = `${err.stderr ?? ''}${err.message ?? ''}`;
        if (/refusing to forget/i.test(text)) return { ok: false, reason: 'last-network', field: 'ssid' };
        if (/unknown connection/i.test(text)) return { ok: false, reason: 'no-such-network', field: 'ssid' };
        return { ok: false, reason: 'forget-failed', field: 'ssid', detail: firstLine(text) };
      }
    },

    /** Raises and lowers the box's own setup network. */
    async apUp(password) {
      try {
        /** The password goes on stdin, never as an argument */
        await runWithInputFn('sudo', ['-n', helperPath, 'ap-up'], `${password ?? ''}\n`);
        return { ok: true };
      } catch (err) {
        const text = `${err.stderr ?? ''}${err.message ?? ''}`;
        if (!(await isBootstrapped())) return { ok: false, reason: 'not-bootstrapped' };
        return { ok: false, reason: 'ap-up-failed', detail: firstLine(text) };
      }
    },

    async apDown() {
      try {
        await execFileFn('sudo', ['-n', helperPath, 'ap-down']);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: 'ap-down-failed', detail: firstLine(`${err.stderr ?? ''}${err.message ?? ''}`) };
      }
    },
  };
}

/** Enough to act on, without relaying a wall of nmcli output over the app notification. */
function firstLine(text) {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 120);
}
