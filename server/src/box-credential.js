import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createBoxIdentity } from './box-identity.js';

/** The box's credential for talking to the update server, and nothing else. */
const CONFIG = 'public-cert.json';

export const DATA_DIR = join(process.env.HOME ?? '/home/waxcode', 'data');

/** Defaults live here so a config written before a field existed still works. */
const withDefaults = (config) => ({
  endpoint: 'https://www.waxcode.co', environment: 'production', ...config,
});

export function readConfig(dataDir = DATA_DIR) {
  try {
    const config = JSON.parse(readFileSync(join(dataDir, CONFIG), 'utf8'));
    if (!config.id || !config.token) return null;
    return withDefaults(config);
  } catch {
    return null;
  }
}

/** Registers this box, once, so it can fetch updates. */
async function register(dataDir, log) {
  const serial = createBoxIdentity().serial();
  if (!serial) return null;

  try {
    const res = await fetch(`${withDefaults({}).endpoint}/api/box/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serial }),
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);

    const { id, token, name } = await res.json();
    if (!id || !token) throw new Error('incomplete answer');

    /** `name` is kept only because the server still returns it and an older box has it on disk. */
    const config = { id, token, ...(name ? { name } : {}) };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, CONFIG), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    log('[box] registered for updates');
    return withDefaults(config);
  } catch (err) {
    log(`[box] could not register for updates (${err.message})`);
    return null;
  }
}

/** Makes sure this box has a credential, registering if it has never had one. */
export async function ensureRegistered({ dataDir = DATA_DIR, log = console.log } = {}) {
  const existing = readConfig(dataDir);
  if (existing) return existing;
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  return register(dataDir, log);
}
