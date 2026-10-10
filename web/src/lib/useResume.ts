import { useSyncExternalStore } from 'react';

/**
 * A count of how many times this page has come back from the background.
 *
 * iOS suspends a home-screen app the moment it leaves the foreground - a screen lock is enough -
 * and reclaims what it was holding. Connections do not survive that, and the cruel part is that an
 * EventSource killed while suspended very often never fires `onerror`: it comes back looking open
 * and stays silent for ever. Nothing in here could tell, so the last status received stayed on
 * screen and went on being treated as live (a box in the field, 2026-10-22).
 *
 * The older the phone the harder iOS reclaims, which is backwards for this project: a box built to
 * be cheap is most likely to be driven by a phone somebody already had.
 *
 * So anything holding a stream or a poll rebuilds it when this changes, rather than trusting that
 * it survived. One pair of listeners for the whole app, not one per hook.
 */

let resumes = 0;
const listeners = new Set<() => void>();
let listening = false;

function announce(): void {
  resumes += 1;
  for (const listener of listeners) listener();
}

function onVisibilityChange(): void {
  // Going away is not an event anything here needs; coming back is.
  if (document.visibilityState === 'visible') announce();
}

function onPageShow(event: PageTransitionEvent): void {
  // Only a restore from the back/forward cache - a first load is not a resume.
  if (event.persisted) announce();
}

function listen(listener: () => void): () => void {
  listeners.add(listener);
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
  }
  return () => listeners.delete(listener);
}

export function useResume(): number {
  return useSyncExternalStore(listen, () => resumes, () => 0);
}

/** Tests only - module state outlives a render, so it has to be put back between them. */
export function resetResumesForTest(): void {
  resumes = 0;
}
