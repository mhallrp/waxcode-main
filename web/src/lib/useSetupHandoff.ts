import { useEffect, useState } from 'react';
import { api } from './api';

/*
 * The handoff from the box's own network to the owner's, watched so the page can follow it instead
 * of asking somebody to reload at the right moment.
 *
 * The ORDER is the design here, not the polling. The box is perfectly reachable while the phone is
 * still sitting on its AP, so "wait until the box answers" fires at once and reloads onto a network
 * that is about to disappear. The box going AWAY is the proof the join worked; only then is it
 * worth watching for it to come back.
 */

/** waiting: the AP is still up. gone: it dropped, which is the good sign. back: reachable again. */
export type Handoff = 'waiting' | 'gone' | 'back' | 'stalled';

const EVERY_MS = 2000;
/** Two, as everywhere else in this app: one dropped request is not a network change. */
const MISSES_BEFORE_GONE = 2;
/** Long enough for a slow rejoin. Past it, a phone that is not coming back needs telling. */
const STALLED_AFTER_MS = 90_000;

/**
 * True when this page was loaded from the box's own name, so its URL already points at the box on
 * either network - only the address behind it changes.
 */
export function loadedFromBoxName(address: string): boolean {
  return address.toLowerCase() === window.location.hostname.toLowerCase();
}

/** Where the browser should go once the box is found again, and nothing until then. */
export interface Found { phase: Handoff; target: string | null }

export function useSetupHandoff(address: string, lanIp: string | null, active: boolean): Found {
  const [phase, setPhase] = useState<Handoff>('waiting');
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return undefined;

    /* Loaded from the box's name, /version can be READ when it comes back, so the box itself says
     * whether the phone is off its setup network. Loaded from the IP, it cannot: the box sends no
     * CORS headers, and reachability is the only signal there is. By then the AP is known to be
     * gone, which is what makes reachability enough. */
    const byName = loadedFromBoxName(address);

    let stopped = false;
    let misses = 0;
    let goneAt = 0;

    const beat = async () => {
      if (stopped) return;

      if (goneAt === 0) {
        try {
          await api.version();
          misses = 0;
        } catch {
          misses += 1;
          if (misses >= MISSES_BEFORE_GONE) {
            goneAt = Date.now();
            setPhase('gone');
          }
        }
        return;
      }

      /* The NAME first, because it is the address worth having: it survives the box changing
       * address, and it is what somebody would type again tomorrow. */
      try {
        if (byName) {
          /* A box too old to report onSetupNetwork leaves it undefined, which reads as "not the
           * setup network" - correct, because by now it is answering over something else. */
          const version = await api.version();
          if (version.onSetupNetwork === true) return;
        } else {
          /* Opaque on purpose: nothing in the reply is read, and no-cors is what makes that legal. */
          await fetch(`http://${address}/version`, { mode: 'no-cors', cache: 'no-store' });
        }
        stopped = true;
        setTarget(`http://${address}/`);
        setPhase('back');
        return;
      } catch {
        // Not by name. Which may mean the box is not back - or that the name is poisoned.
      }

      /*
       * The IP, which is the whole reason the join reply is worth reading.
       *
       * A phone that resolved this name while on the setup network can be holding 10.42.0.1 for
       * it, and that address stops existing the moment the box leaves. Then the name fails for a
       * box that is sitting there answering perfectly - which is exactly what happened on real
       * hardware, 2026-10-11. The IP involves no resolver and cannot go stale this way.
       */
      if (lanIp) {
        try {
          await fetch(`http://${lanIp}/version`, { mode: 'no-cors', cache: 'no-store' });
          stopped = true;
          setTarget(`http://${lanIp}/`);
          setPhase('back');
          return;
        } catch {
          // Not there either.
        }
      }

      // Still nowhere: the phone has not rejoined a network yet.
      if (Date.now() - goneAt > STALLED_AFTER_MS) setPhase('stalled');
    };

    void beat();
    const timer = setInterval(() => { void beat(); }, EVERY_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [address, lanIp, active]);

  return { phase, target };
}
