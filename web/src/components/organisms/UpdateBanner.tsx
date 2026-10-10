import { useCallback, useState } from 'react';
import type { UpdateNotice } from '../../types';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { startUpdate } from '../../lib/startUpdate';
import { css } from '../../styles/css';

const styles = css('UpdateBanner', {
  bar: `
    /** FLOATS over the content rather than taking a row of its own. */
    position: fixed;
    top: calc(env(safe-area-inset-top) + 8px);
    left: 50%;
    transform: translateX(-50%);
    z-index: 8;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(560px, calc(100vw - 32px));
    padding: 9px 10px 9px 14px;
    border-radius: 999px;
    border: 1px solid var(--cue);
    background: var(--surface2);
    /* Reads as a thing on top of the page rather than part of it, which is the whole point now. */
    box-shadow: 0 6px 24px rgb(0 0 0 / 45%);
    font: 500 13px/1.3 var(--sans, inherit);
    color: var(--ink);
  `,
  text: `
    flex: 1; min-width: 0;
  `,
  version: `
    font-family: var(--mono); color: var(--cue);
  `,
  button: `
    flex: 0 0 auto;
    padding: 7px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--cue);
    background: transparent;
    color: var(--ink);
    font: 600 12px/1 var(--sans, inherit);
    &:disabled { opacity: 0.5; }
  `,
  later: `
    flex: 0 0 auto;
    padding: 7px 10px;
    border: 0;
    background: transparent;
    color: var(--ink-dim);
    font: 500 12px/1 var(--sans, inherit);
  `,
});

/** "An update is waiting" - and nothing more than that. */
export function UpdateBanner() {
  /** Polled slowly. */
  const notice = useBoxData<UpdateNotice>(api.updateNotice, { everyMs: 60_000 });
  const [confirm, dialog] = useConfirm();
  const [busy, setBusy] = useState(false);

  const state = notice.data;

  /** Hidden while the box has not actually checked yet, rather than guessed at */
  const show = Boolean(state?.waiting && state.version);

  const later = useCallback(async () => {
    if (!state?.version) return;
    setBusy(true);
    await api.dismissUpdate(state.version);
    await notice.refresh();
    setBusy(false);
  }, [state?.version, notice]);

  async function install() {
    if (!state?.version) return;
    const ok = await confirm({
      title: `Install ${state.version}?`,
      message: 'The box will restart and the decks will stop for a few minutes. Anything loaded will '
        + 'be cleared, so do this between sets rather than during one.',
      confirm: 'Install',
      cancel: 'Not Now',
    });
    if (!ok) return;

    setBusy(true);
    const started = await startUpdate();
    setBusy(false);

    /** Nothing else to do on success: startUpdate raises the update screen over everything */
    if (!started.ok) await notice.refresh();
  }

  if (!show) return dialog;

  return (
    <>
      <div className={styles.bar}>
        <span className={styles.text}>
          <span className={styles.version}>{state?.version}</span> is available
          {state?.running ? <> — this box is on <span className={styles.version}>{state.running}</span></> : null}
        </span>
        <button type="button" className={styles.later} onClick={() => void later()} disabled={busy}>
          Later
        </button>
        <button type="button" className={styles.button} onClick={() => void install()} disabled={busy}>
          Install
        </button>
      </div>
      {dialog}
    </>
  );
}
