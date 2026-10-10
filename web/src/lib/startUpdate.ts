import { api } from './api';
import { type UpdateWatch, startWatching } from './updateProgress';

/** Begins an update and hands the watching to the update screen. */
export async function startUpdate(): Promise<{ ok: true; watch: UpdateWatch } | { ok: false; reason?: string }> {
  const started = await api.applyUpdate();
  if (!('applying' in started) || !started.applying) {
    return { ok: false, reason: 'reason' in started ? started.reason : undefined };
  }

  const watch = startWatching(started.applying);
  /** An event rather than a prop chain: the banner and Settings sit in different trees, and both need to reach the one screen App owns. */
  window.dispatchEvent(new CustomEvent('waxcode:update-started', { detail: watch }));
  return { ok: true, watch };
}
