import type { DragEventHandler, MouseEventHandler, ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('ListRow', {
  row: `
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 10px 14px;
    border: 0;
    border-bottom: 1px solid var(--hairline);
    background: transparent;
    color: var(--ink);
    text-align: left;
  `,
  active: `
    /* A selected row is a rounded plate, not a full-bleed band - it sits inside the sidebar's padding. */
    background: var(--surface2); border-radius: var(--radius);
  `,
  icon: `
    flex: 0 0 auto; display: flex; color: var(--ink-dim);
  `,
  text: `
    /* min-width: 0 so a long title ellipsises instead of pushing the chevron off the row. */
    flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;
  `,
  title: `
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font: 500 15px/1.3 var(--mono);
    color: var(--ink);
  `,
  sub: `
    color: var(--ink-faint); font: 12px/1.4 var(--mono);
  `,
  chevron: `
    flex: 0 0 auto; color: var(--ink-faint); font-size: 17px;
  `,
  sidebarRow: `
    /* Sidebar rows: a rounded plate with no hairline, and a bolder name. */
    padding: 8px; margin-bottom: 2px; border-bottom: 0; border-radius: var(--radius); color: var(--ink-dim);
    & $title { font: 600 14px/1.3 var(--mono); }
    & $sub { font: 11px/1.4 var(--sans); }
  `,
  /** The desktop list: one line per track instead of two. */
  denseRow: `
    padding: 4px 12px;
    gap: 10px;
    & $text { flex-direction: row; align-items: baseline; gap: 10px; }
    & $title { font: 500 13px/1.6 var(--mono); flex: 0 1 auto; }
    & $sub { font: 11px/1.6 var(--mono); flex: 1 1 auto; min-width: 0;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `,
});

interface Props {
  title: string;
  sub?: string;
  icon?: ReactNode;
  /** A chevron marks a row that goes somewhere, rather than one that does something. */
  chevron?: boolean;
  active?: boolean;
  /** Sidebar rows are rounded plates rather than hairline-separated bands. */
  sidebar?: boolean;
  /** One line rather than two - the desktop list, where vertical room is how much you can see. */
  dense?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
  /** Dragged onto a deck to load it - the desktop way in. */
  draggable?: boolean;
  onDragStart?: DragEventHandler<HTMLElement>;
  onDragEnd?: DragEventHandler<HTMLElement>;
  /** A row can also RECEIVE a row, to be rearranged - see the library's My Order. */
  onDragOver?: DragEventHandler<HTMLElement>;
  onDrop?: DragEventHandler<HTMLElement>;
  /** Right-click, which opens a menu on the row - see the library's delete. */
  onContextMenu?: MouseEventHandler<HTMLElement>;
}

export function ListRow({
  title, sub, icon, chevron, active, sidebar, dense, onClick, trailing, draggable, onDragStart,
  onDragEnd, onDragOver, onDrop, onContextMenu,
}: Props) {
  /** A draggable row stays a button even without onClick: it is still the thing you reach for, and a div would lose focus, hover and the pointer. */
  const Tag = onClick || draggable ? 'button' : 'div';
  return (
    <Tag
      {...(onClick || draggable ? { type: 'button' as const } : {})}
      {...(onClick ? { onClick } : {})}
      {...(draggable ? { draggable: true, onDragStart, onDragEnd } : {})}
      {...(onDragOver || onDrop ? { onDragOver, onDrop } : {})}
      {...(onContextMenu ? { onContextMenu } : {})}
      className={[styles.row, sidebar && styles.sidebarRow, dense && styles.denseRow, active && styles.active]
        .filter(Boolean).join(' ')}
    >
      {icon && <span className={styles.icon}>{icon}</span>}
      <span className={styles.text}>
        <span className={styles.title}>{title}</span>
        {sub && <small className={styles.sub}>{sub}</small>}
      </span>
      {trailing}
      {chevron && <span className={styles.chevron} aria-hidden="true">&rsaquo;</span>}
    </Tag>
  );
}
