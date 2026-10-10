import { spawn } from 'node:child_process';
import { prioritizedSpawn } from './process-priority.js';

/** Runs keyfinder-cli (libkeyfinder, via ffmpeg decoding) and returns the detected key in Camelot notation (eg. */
export function computeKey(path, { spawnFn = spawn, priority, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cliArgs = ['-n', 'camelot', path];
    const proc = prioritizedSpawn(spawnFn, 'keyfinder-cli', cliArgs, priority, { signal });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    proc.once('error', (err) => reject(err));
    proc.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`keyfinder-cli exited ${code} analysing ${path}: ${stderr.trim()}`));
        return;
      }
      const key = stdout.trim();
      resolve(key.length > 0 ? key : null);
    });
  });
}
