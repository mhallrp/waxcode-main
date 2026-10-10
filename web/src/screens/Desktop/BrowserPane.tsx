import { LibraryScreen } from '../Library/LibraryScreen';
import { css } from '../../styles/css';

const styles = css('BrowserPane', {
  pane: `
    display: flex; flex-direction: column; min-height: 0; height: 100%;
    border-radius: var(--radius);
    background: var(--surface);
    overflow: hidden;
  `,
  status: `
    /* Only present while a dropped file is in flight, so it costs nothing the rest of the time. */
    flex: 0 0 auto;
    padding: 6px 12px;
    border-bottom: 1px solid var(--hairline);
    font: 500 10px/1.4 var(--mono); color: var(--ink-faint);
  `,
  body: `
    flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
  `,
});

interface Props {
  /** What a file dropped onto a deck is doing - shown here rather than over the deck it landed on. */
  status?: string | null;
}

/** The browser along the bottom of the desktop layout. */
export function BrowserPane({ status }: Props) {
  return (
    <div className={styles.pane}>
      {status && <div className={styles.status}>{status}</div>}
      <div className={styles.body}>
        {/* deck is still required by LibraryScreen for its own load path, which dragToLoad turns
            off - so it is never used here. 1 rather than a lie about there being no deck. */}
        <LibraryScreen deck={1} dragToLoad onLoaded={() => {}} />
      </div>
    </div>
  );
}
