import { css } from '../../styles/css';

const styles = css('Breadcrumbs', {
  crumbs: `
    /** flex: 1 is what pushes everything AFTER the trail - the favourite star and the sort menu - to the right-hand edge of the bar. */
    display: flex;
    align-items: center;
    flex-wrap: nowrap;
    gap: 2px;
    flex: 1;
    min-width: 0;
    overflow: hidden;
  `,
  item: `
    display: flex; align-items: center; gap: 2px;
  `,
  sep: `
    color: var(--ink-faint);
  `,
  crumb: `
    /* Shrinkable and ellipsised, so a long folder name gives way rather than pushing the icons off. */
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 0;
    background: transparent;
    padding: 4px 2px;
    color: var(--ink-dim);
    font: 500 13px/1 var(--mono);
  `,
  current: `
    color: var(--ink);
  `,
});

interface Props {
  /** Device name first, then each folder segment. */
  trail: string[];
  onJump: (depth: number) => void;
}

export function Breadcrumbs({ trail, onJump }: Props) {
  return (
    <nav className={styles.crumbs}>
      {trail.map((text, depth) => (
        <span key={`${text}-${depth}`} className={styles.item}>
          {depth > 0 && <span className={styles.sep} aria-hidden="true">&rsaquo;</span>}
          <button
            type="button"
            className={depth === trail.length - 1 ? `${styles.crumb} ${styles.current}` : styles.crumb}
            onClick={() => onJump(depth)}
          >
            {text}
          </button>
        </span>
      ))}
    </nav>
  );
}
