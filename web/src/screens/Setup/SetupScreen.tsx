import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { Hint } from '../../components/atoms/Hint';
import { Button } from '../../components/atoms/Button';
import { JoinNetworkForm } from '../Settings/JoinNetworkForm';
import { type Handoff, useSetupHandoff } from '../../lib/useSetupHandoff';
import { css } from '../../styles/css';

const styles = css('SetupScreen', {
  screen: `
    position: fixed;
    inset: 0;
    /* Above the rotate prompt's 100 - setup must never be the thing hidden. */
    z-index: 110;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg);
    padding: calc(28px + env(safe-area-inset-top, 0px)) calc(22px + env(safe-area-inset-right, 0px))
             calc(28px + env(safe-area-inset-bottom, 0px)) calc(22px + env(safe-area-inset-left, 0px));
  `,
  inner: `
    max-width: 30rem;
    margin: 0 auto;
  `,
  title: `
    margin: 0 0 4px;
    font: 500 15px/1 var(--mono);
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: var(--ink);
  `,
  lede: `
    margin: 0 0 26px;
    color: var(--ink-dim);
    font-size: 15px;
    line-height: 1.5;
  `,
  choice: `
    display: block;
    width: 100%;
    text-align: left;
    margin-bottom: 12px;
    padding: 18px 20px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    & b { display: block; font: 500 15px/1.3 var(--mono); }
    & span { display: block; margin-top: 6px; color: var(--ink-faint); font-size: 13px; line-height: 1.5; }
  `,
  done: `
    padding: 18px 20px;
    border: 1px solid var(--cue);
    border-radius: var(--radius);
    background: var(--surface2);
    & b { display: block; color: var(--cue); font: 600 16px/1.3 var(--mono); }
    & p { margin: 10px 0 0; color: var(--ink-dim); font-size: 14px; line-height: 1.6; }
    & code { font: 500 14px/1 var(--mono); color: var(--ink); }
  `,
  back: `
    margin-top: 18px;
  `,
});

type Step = 'choose' | 'wifi' | 'joining' | 'joined';

/*
 * Where the box went, and what this page is doing about it. The same panel whichever way the join
 * ended - answered, or silent because it took the network this page was served over - because what
 * somebody needs to know is identical either way.
 *
 * The typed address stays on screen through all of it. Following the handoff is a convenience; a
 * phone that does not rejoin a network on its own leaves nothing to follow, and then the only
 * instruction that works is the one somebody can carry out themselves.
 */
function HandoffNotice(
  { title, phase, address, lanIp }:
  { title: string; phase: Handoff; address: string; lanIp: string | null },
) {
  return (
    <div className={styles.done}>
      <b>{title}</b>
      {phase === 'waiting' && (
        <>
          <p>
            This page will stop responding in a moment. That means it worked - the box has left its
            own network to join yours, and this page was being served over the one it left.
          </p>
          <p>
            If it answers with an error instead, the box could not join and is still here.
          </p>
        </>
      )}
      {phase === 'gone' && (
        <p>
          The box has left its own network, which is what should happen. If this page is still here
          when your phone rejoins your Wi-Fi, it will take you to the box by itself.
        </p>
      )}
      {phase === 'stalled' && (
        <p>
          Your phone has not rejoined a network by itself. Join your usual Wi-Fi to carry on.
        </p>
      )}
      {phase === 'back' && <p>Found the box. Taking you to it&hellip;</p>}
      {/* The instruction that works in every case, and the only one that works when setup was
          opened in a sign-in sheet - those close with the network rather than surviving it. */}
      {phase !== 'back' && (
        <p>
          Either way: once you are back on your own Wi-Fi, open <code>{address}</code>
          {lanIp ? <> &mdash; or <code>{lanIp}</code> if that name does not find it</> : null}.
        </p>
      )}
    </div>
  );
}


/*
 * The box's own setup, on its own screen. There is no way past it and nothing to opt out of: the
 * one thing it asks for is the one thing a box cannot do for itself.
 *
 * Normally reached in the sign-in sheet the phone opens by itself - the captive portal sends it to
 * the AP's IP, deliberately never to the box's name, so nothing here leaves an entry in a resolver
 * that stops being true once the box moves. Typing the box's address reaches the same screen, since
 * the BOX decides whether setup is showing, not the URL.
 *
 * It took a `required` flag and an `onSkip` until 2026-10-11. Both existed only for the
 * "Use without Wi-Fi" branch, and went with it.
 */
export function SetupScreen() {
  const [step, setStep] = useState<Step>('choose');
  const [joined, setJoined] = useState<string | null>(null);
  /** The box's address on the network it just joined, if it managed to say before leaving. */
  const [lanIp, setLanIp] = useState<string | null>(null);
  const network = useBoxData(api.network, { pause: step === 'wifi' });
  /* The box's own name, because this screen is the one place the address has to be exactly right -
   * it is said while the page is about to go dead, with no chance to correct it. Boxes already in
   * the field answer to a different name than a card flashed today, and they run this same release.
   * The fallback is only for a box too old to report it. */
  const address = network.data?.address ?? 'waxcodedvs.local';
  /** Only once a join is under way: before that there is no handoff to follow. */
  const { phase: handoff, target } = useSetupHandoff(address, lanIp, step === 'joining' || step === 'joined');

  useEffect(() => {
    if (handoff !== 'back' || !target) return;
    /* A reload only when the target is where this page already is. assign() to the same URL would
     * not reload at all if the two differed only by fragment, which is why this is not collapsed. */
    if (target === `${window.location.origin}/`) window.location.reload();
    else window.location.assign(target);
  }, [handoff, target]);

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Set up Waxcode</h1>

        {step === 'choose' && (
          <>
            <p className={styles.lede}>
              This box is broadcasting its own network because it has not joined one yet.
            </p>
            {/* ONE thing to do. "Use without Wi-Fi" sat here as an equal choice and read as the
                easier one - and a box that never joins a network gets no updates, cannot be
                reached from a laptop, and leaves its owner on a hotspot for every set. Staying on
                the box's own network still works; it is just not offered as a first move.
                Something subtler can come back later (owner's call, 2026-10-11). */}
            <button type="button" className={styles.choice} onClick={() => setStep('wifi')}>
              <b>Connect to Wi-Fi</b>
              <span>
                Lets the box be reached from your normal network, and keeps your phone online
                  while you use it.
              </span>
            </button>
          </>
        )}

        {(step === 'wifi' || step === 'joining') && (
          network.data ? (
            <>
              <p className={styles.lede}>Pick your network. The box will join it and restart its connection.</p>
              {/* The same form Settings uses - one implementation, so a fix reaches both. */}
              {/* Said BEFORE the join, because a successful one takes this page down with the
                  setup network and there is no "after" in which to say it. */}
              {step === 'joining' && (
                <HandoffNotice title={`Joining ${joined}\u2026`} phase={handoff} address={address} lanIp={lanIp} />
              )}
              <JoinNetworkForm
                network={network.data}
                onJoining={(ssid) => { setJoined(ssid); setStep('joining'); }}
                onJoinFailed={() => setStep('wifi')}
                onJoined={(ip) => { setLanIp(ip); setStep('joined'); }}
                /** Offered HERE above all: setting up is exactly when somebody switches a hotspot on after the box has already looked */
                onRefresh={() => network.refresh()}
              />
              <div className={styles.back}>
                <Button variant="quiet" onClick={() => setStep('choose')}>Back</Button>
              </div>
            </>
          ) : <Hint>Looking for networks&hellip;</Hint>
        )}

        {step === 'joined' && (
          <HandoffNotice
            title={`Connected${joined ? ` to ${joined}` : ''}`}
            phase={handoff}
            address={address}
            lanIp={lanIp}
          />
        )}

      </div>
    </div>
  );
}
