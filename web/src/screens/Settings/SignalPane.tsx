import { useSignal } from '../../lib/useSignal';
import { VERDICTS, floorLevel, level, referenceLevel, verdictFor } from '../../lib/signal';
import { Hint } from '../../components/atoms/Hint';
import { LevelMeter } from '../../components/organisms/LevelMeter';
import { css } from '../../styles/css';

const styles = css('SignalPane', {
  decks: `
    /** Side by side, because a working deck next to a failing one is the fastest way to see which end is at fault. */
    display: flex; align-items: flex-start; gap: var(--gap); margin-top: 16px;
  `,
  deck: `
    flex: 1;
    min-width: 0;
    padding: 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    &[data-deck='1'] { --accent: var(--deck-a); }
    &[data-deck='2'] { --accent: var(--deck-b); }
  `,
  name: `
    display: block; margin-bottom: 12px; color: var(--ink-faint); font: 500 10px/1 var(--mono); letter-spacing: 1.2px;
  `,
  verdict: `
    /* Room for the longest message, so the meters do not move as the verdict changes. */
    min-height: 64px; margin-bottom: 12px;
    & b { display: block; font: 500 15px/1.3 var(--mono); }
    & p { margin: 4px 0 0; color: var(--ink-faint); font-size: 12px; line-height: 1.4; }
    &[data-tone='bad'] b { color: var(--recording); }
    &[data-tone='warn'] b { color: var(--deck-b); }
    &[data-tone='good'] b { color: var(--cue); }
    &[data-tone='idle'] b { color: var(--ink-dim); }
  `,
});

/** Live at the box's 10Hz while this pane is open, and closed the moment it is not. */
export function SignalPane() {
  const decks = useSignal(true);

  return (
    <>
      <Hint>
        Put the needle down on a timecode record and let it play. The box sets its own threshold a
        thousand times a second, so there&rsquo;s nothing to calibrate by hand.
      </Hint>

      <div className={styles.decks}>
        {decks.map((signal) => {
          const verdict = VERDICTS[verdictFor(signal)];
          const floor = floorLevel(signal);
          return (
            <section key={signal.deck} className={styles.deck} data-deck={signal.deck}>
              <span className={styles.name}>Deck {signal.deck === 1 ? 'A' : 'B'}</span>
              {/* Fixed height, so the meters below do not jump as the verdict changes length. */}
              <div className={styles.verdict} data-tone={verdict.tone}>
                <b>{verdict.title}</b>
                <p>{verdict.detail}</p>
              </div>
              <LevelMeter label="Left" level={level(signal.peakLeft)} floor={floor} reference={referenceLevel(signal)} />
              <LevelMeter label="Right" level={level(signal.peakRight)} floor={floor} reference={referenceLevel(signal)} />
            </section>
          );
        })}
        {decks.length === 0 && <Hint>Waiting for the box…</Hint>}
      </div>
    </>
  );
}
