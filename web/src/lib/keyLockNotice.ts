import { useEffect, useSyncExternalStore } from 'react';
import { api } from './api';

/*
 * Two facts about key lock, asked of the box once and shared by everything that needs them.
 *
 * `available` is the ENGINE's answer - whether this box's xwax understands KEYLOCK at all. It is
 * not a preference and there is nothing to switch: key lock used to be a box-wide opt-in in
 * Settings, and that switch doubled as an availability check by accident. With it gone, this is
 * what stops a box running an older xwax from showing a button that does nothing.
 *
 * `acknowledged` is whether the owner has been shown, once, what key lock costs. One shared store
 * rather than one per component, for the reason the box-wide flag needed it: a deck card already
 * mounted has to stop asking the moment the notice is answered, not when its own poll comes round.
 */
let available = false;
let acknowledged = false;
let asked = false;
/* The request itself, not just its result. Both deck cards mount in the same commit, so a guard
 * that only closes when the answer ARRIVES lets every one of them fire its own request first. */
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: { available: boolean; acknowledged: boolean }) {
  available = next.available;
  acknowledged = next.acknowledged;
  asked = true;
  for (const listener of listeners) listener();
}

export async function refreshKeyLockNotice(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const state = await api.keyLockNotice().catch(() => null);
    if (state) publish({ available: state.available === true, acknowledged: state.acknowledged === true });
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** Records that the notice has been read, on the box, and lets every deck stop asking. */
export async function acknowledgeKeyLockNotice() {
  publish({ available, acknowledged: true });
  await api.acknowledgeKeyLockNotice().catch(() => {
    /* The notice showing twice is a far smaller cost than a failed press being swallowed. */
  });
}

/** Whether the notice still has to be shown before key lock is engaged. */
export const keyLockNeedsNotice = () => !acknowledged;

/*
 * Resolves once the box has answered at least once, and is a no-op after that.
 *
 * The deck asks this before deciding whether to show the notice, rather than trusting the store to
 * have been filled already. It would be - a mounted deck card reads `available` - but a decision
 * about what somebody is shown should not quietly depend on which other component happened to
 * mount first.
 */
export async function ensureKeyLockNoticeLoaded(): Promise<void> {
  if (asked) return;
  await refreshKeyLockNotice();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Whether this box's engine can do key lock at all, which is whether to offer the button. */
export function useKeyLockAvailable(): boolean {
  const value = useSyncExternalStore(subscribe, () => available, () => false);
  useEffect(() => { if (!asked) void refreshKeyLockNotice(); }, []);
  return value;
}

/** Tests only: there is one module-level store, so it has to be resettable between them. */
export function resetKeyLockNoticeForTest() {
  available = false;
  acknowledged = false;
  asked = false;
  inFlight = null;
  listeners.clear();
}
