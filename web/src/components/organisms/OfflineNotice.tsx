import { css } from '../../styles/css';

const styles = css('OfflineNotice', {
  screen: `
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 24px;
    background: var(--bg);
    text-align: center;
  `,
  title: `
    font: 500 17px/1.3 var(--mono);
    color: var(--ink);
  `,
  body: `
    margin: 0;
    max-width: 38ch;
    color: var(--ink-faint);
    font-size: 13px;
    line-height: 1.5;
  `,
  /** No retry button. */
  note: `
    margin: 0;
    color: var(--ink-dim);
    font: 500 12px/1 var(--mono);
    letter-spacing: 0.5px;
  `,
});

/** Shown over everything when the box stops answering. */
export function OfflineNotice() {
  return (
    <div className={styles.screen} role="alert">
      <b className={styles.title}>Can't reach the box</b>
      <p className={styles.body}>
        It may be switched off, or this phone may be on a different network. Nothing has been lost -
        the decks keep playing whatever they were playing.
      </p>
      <p className={styles.note}>Reconnecting&hellip;</p>
    </div>
  );
}
