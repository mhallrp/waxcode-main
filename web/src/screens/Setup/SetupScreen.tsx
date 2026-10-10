import { useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { Hint } from '../../components/atoms/Hint';
import { Button } from '../../components/atoms/Button';
import { JoinNetworkForm } from '../Settings/JoinNetworkForm';
import { setupSsid } from '../../lib/setup-ssid';
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

type Step = 'choose' | 'wifi' | 'joining' | 'joined' | 'local';


/** The box's own setup, on its own screen. */
/** `required` means the box is sitting on its OWN network, so this is first-time setup and there is nowhere else to be. */
export function SetupScreen({ onSkip, required = false }: { onSkip: () => void; required?: boolean }) {
  const [step, setStep] = useState<Step>('choose');
  const [joined, setJoined] = useState<string | null>(null);
  const network = useBoxData(api.network, { pause: step === 'wifi' });

  return (
    <div className={styles.screen}>
      <div className={styles.inner}>
        <h1 className={styles.title}>Set up Waxcode</h1>

        {step === 'choose' && (
          <>
            <p className={styles.lede}>
              This box is broadcasting its own network because it has not joined one yet.
            </p>
            <button type="button" className={styles.choice} onClick={() => setStep('wifi')}>
              <b>Connect to Wi-Fi</b>
              <span>
                Recommended. Lets the box be reached from your normal network, and keeps your
                  phone online while you use it.
              </span>
            </button>
            {/* Only on the box's own AP: on a real network the box has already left its own. */}
            {required && (
            <button type="button" className={styles.choice} onClick={() => setStep('local')}>
              <b>Use without Wi-Fi</b>
              <span>
                Keep using the box&rsquo;s own network. Everything works, and nothing else is
                  needed.
              </span>
            </button>
            )}
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
                <div className={styles.done}>
                  <b>Joining {joined}&hellip;</b>
                  <p>
                    This page will go blank in a moment. That means it worked - the box has left its
                    own network to join yours, and this page was being served over the one it left.
                  </p>
                  <p>
                    Rejoin your usual Wi-Fi, then open <code>waxcodedvs.local</code>. If this page
                    comes BACK with an error instead, the box could not join and is still here.
                  </p>
                </div>
              )}
              <JoinNetworkForm
                network={network.data}
                onJoining={(ssid) => { setJoined(ssid); setStep('joining'); }}
                onJoinFailed={() => setStep('wifi')}
                onJoined={() => setStep('joined')}
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
          <div className={styles.done}>
            <b>Connected{joined ? ` to ${joined}` : ''}</b>
            <p>
              This setup network is closing now. Rejoin your own Wi-Fi, then open{' '}
              <code>waxcodedvs.local</code> in Safari.
            </p>
            <p>
              Give it a minute to appear on your network first.
            </p>
          </div>
        )}

        {step === 'local' && (
          <>
            <div className={styles.done}>
              <b>Using the box&rsquo;s own network</b>
              <p>
                Nothing else to do. Whenever you want to use it, join{' '}
                <code>{setupSsid(network.data?.serial ?? null)}</code> and open{' '}
                <code>waxcodedvs.local</code>.
              </p>
              <p>
                The screen will dim on its own while you play. Settings &rsaquo; Display &amp;
                  Brightness &rsaquo; Auto-Lock &rsaquo; Never is the way round it.
              </p>
            </div>
            <div className={styles.back}>
              <Button variant="quiet" onClick={onSkip}>Go to the decks</Button>
            </div>
            <div className={styles.back}>
              <Button variant="quiet" onClick={() => setStep('choose')}>Actually, connect to Wi-Fi</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
