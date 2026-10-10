import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  type Stage, type UpdateWatch, fractionOf, stageOf, stopWatching,
} from '../lib/updateProgress';
import { Brand } from '../components/atoms/Brand';
import { Hint } from '../components/atoms/Hint';
import { Button } from '../components/atoms/Button';
import { css } from '../styles/css';

const styles = css('UpdateScreen', {
  screen: `
    /** Above everything, including the setup screens. */
    position: fixed;
    inset: 0;
    z-index: 130;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    padding-top: calc(24px + env(safe-area-inset-top));
    background: var(--bg);
    text-align: center;
  `,
  title: `
    margin: 0; font: 500 17px/1.3 var(--mono); color: var(--ink);
  `,
  track: `
    width: min(320px, 78vw);
    height: 4px;
    margin-top: 6px;
    border-radius: 2px;
    background: var(--surface2);
    overflow: hidden;
  `,
  bar: `
    height: 100%;
    background: var(--cue);
    /** Slow, because the steps underneath are coarse - three stages, not a real byte count. */
    transition: width 900ms linear;
  `,
  body: `
    margin: 0; max-width: 40ch; color: var(--ink-faint); font-size: 13px; line-height: 1.5;
  `,
});

const SAY: Record<Stage, { title: string; body: string }> = {
  preparing: {
    title: 'Installing…',
    body: 'Downloading and building. This takes a minute or so, and the decks will stop while it finishes.',
  },
  restarting: {
    title: 'Restarting…',
    body: 'The box is coming back up. This page will refresh by itself.',
  },
  done: { title: 'Up to date', body: 'Reloading…' },
  stalled: {
    title: 'This is taking longer than it should',
    body: 'The box may still be working, or the update may have failed. It is safe to leave this '
      + 'screen - nothing is lost, and the box keeps whatever version it is running.',
  },
};

/** Shown for the whole of an update, from either the banner or Settings. */
export function UpdateScreen({ watch, onLeave }: { watch: UpdateWatch; onLeave: () => void }) {
  const [reported, setReported] = useState<string | null | undefined>(undefined);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    let stopped = false;

    /** Deliberately NOT reloading on the first successful answer. */
    const poll = async () => {
      const version = await api.version().catch(() => null);
      if (stopped) return;
      setReported(version?.version ?? null);
      setNow(Date.now());
    };

    void poll();
    const timer = setInterval(() => { void poll(); }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  const stage: Stage = reported === undefined ? 'preparing' : stageOf(watch, reported, now);

  useEffect(() => {
    if (stage !== 'done') return;
    /** The box is up on the new version. */
    stopWatching();
    const timer = setTimeout(() => window.location.reload(), 700);
    return () => clearTimeout(timer);
  }, [stage]);

  const say = SAY[stage];

  return (
    <div className={styles.screen} role="status" aria-live="polite">
      <Brand />
      <p className={styles.title}>{say.title}</p>

      <div className={styles.track}>
        <div className={styles.bar} style={{ width: `${Math.round(fractionOf(stage, watch, now) * 100)}%` }} />
      </div>

      <p className={styles.body}>{say.body}</p>
      <Hint>{watch.target}</Hint>

      {stage !== 'done' && (
        <Button
          variant="quiet"
          onClick={() => { stopWatching(); onLeave(); }}
        >
          {/* Not "Cancel": the update cannot be stopped once accepted, and saying so would be a lie. */}
          Leave this screen
        </Button>
      )}
    </div>
  );
}
