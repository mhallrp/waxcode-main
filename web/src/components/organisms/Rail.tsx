import type { ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Rail', {
  rail: `
    /** The left of the screen's two columns, corner to corner: up past the header to the top edge, and down to the bottom. */
    width: calc(226px + env(safe-area-inset-left, 0px));
    margin-top: calc(-60px - env(safe-area-inset-top, 0px));
    flex: 0 0 auto;
    display: flex;
    flex-direction: column;
    padding: calc(70px + env(safe-area-inset-top, 0px)) 0 calc(12px + env(safe-area-inset-bottom, 0px));
    background: var(--surface);
  `,
  divider: `
    /** A line, not a shadow: the two columns differ by one step of surface, which on its own reads as a rendering artefact rather than an edge. */
    width: 1px;
    background: var(--hairline);
    flex: 0 0 auto;
    margin-top: calc(-60px - env(safe-area-inset-top, 0px));
  `,
  item: `
    position: relative;
    display: flex;
    align-items: center;
    gap: 11px;
    text-align: left;
    padding: 12px 18px 12px calc(34px + env(safe-area-inset-left, 0px));
    border: 0;
    background: transparent;
    color: var(--ink-dim);
    font: 500 15px/1 var(--mono);
    & svg { flex: 0 0 auto; width: 20px; }
  `,
  active: `
    background: var(--surface2); color: var(--ink);
    /* A bar, not a fill alone: at these surface values the fill difference is subtle on its own. */
    &::before {
      content: "";
      position: absolute;
      left: calc(16px + env(safe-area-inset-left, 0px));
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--ink);
    }
  `,
});

export interface RailItem<T extends string> {
  id: T;
  label: string;
  /** Drawn to the left of the label. The rail is read at a glance, and five words are not. */
  icon: ReactNode;
}

interface Props<T extends string> {
  items: ReadonlyArray<RailItem<T>>;
  active: T;
  onSelect: (id: T) => void;
}

/** The settings sidebar. Knows nothing about what any pane contains. */
export function Rail<T extends string>({ items, active, onSelect }: Props<T>) {
  return (
    <>
      <nav className={styles.rail}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={item.id === active}
            className={item.id === active ? `${styles.item} ${styles.active}` : styles.item}
            onClick={() => onSelect(item.id)}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      <div className={styles.divider} />
    </>
  );
}
