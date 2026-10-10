import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../atoms/Button';
import { css } from '../../styles/css';

const GAP = 10;
const EDGE = 12;

const styles = css('ConfirmDialog', {
  backdrop: `
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgb(0 0 0 / 55%);
    z-index: 50;
  `,
  /* Anchored: no dark overlay, because dimming the whole screen is what makes a popup read as
     modal. It still covers everything, so a click anywhere outside dismisses it. */
  looseBackdrop: `
    position: fixed;
    inset: 0;
    z-index: 50;
  `,
  panel: `
    width: min(420px, 100%);
    padding: 20px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
  `,
  popover: `
    position: fixed;
    width: min(290px, calc(100vw - 24px));
    padding: 14px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 10px 30px rgb(0 0 0 / 45%);
  `,
  title: `
    display: block; font: 500 16px/1.3 var(--mono);
  `,
  titleAlone: `
    display: block; font: 500 16px/1.3 var(--mono); margin-bottom: 18px;
  `,
  popoverTitle: `
    display: block; font: 500 14px/1.3 var(--mono);
  `,
  popoverTitleAlone: `
    display: block; font: 500 14px/1.3 var(--mono); margin-bottom: 12px;
  `,
  message: `
    margin: 10px 0 18px; color: var(--ink-dim); font-size: 13px; line-height: 1.5;
  `,
  popoverMessage: `
    margin: 6px 0 12px; color: var(--ink-dim); font-size: 12.5px; line-height: 1.45;
  `,
  actions: `
    display: flex; justify-content: flex-end; gap: var(--gap-sm);
  `,
});

export interface ConfirmOptions {
  title: string;
  /** Optional: a title that already says it needs no second sentence under it. */
  message?: string;
  confirm: string;
  /** null for no cancel button: dismissing by clicking outside is the way back. */
  cancel?: string | null;
  /** Red confirm. Only for something that actually loses data. */
  destructive?: boolean;
  /** Draws a small popover beside this element instead of a centred modal. */
  anchor?: HTMLElement | null;
}

interface Props extends ConfirmOptions {
  onResolve: (ok: boolean) => void;
}

/** Below the anchor, right-aligned to it, pulled back inside the viewport on every edge. */
function placeBeside(anchor: HTMLElement, panel: HTMLElement) {
  const a = anchor.getBoundingClientRect();
  const { offsetWidth: w, offsetHeight: h } = panel;

  let top = a.bottom + GAP;
  if (top + h > window.innerHeight - EDGE) {
    const above = a.top - GAP - h;
    top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - EDGE - h);
  }
  const left = Math.min(Math.max(EDGE, a.right - w), window.innerWidth - EDGE - w);
  return { top, left };
}

export function ConfirmDialog({
  title, message, confirm, cancel = 'Cancel', destructive, anchor, onResolve,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);

  // Before paint, so it never appears in the wrong place first.
  useLayoutEffect(() => {
    if (!anchor || !panelRef.current) return;
    setPlace(placeBeside(anchor, panelRef.current));
  }, [anchor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onResolve(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResolve]);

  // Dismissing is always the safe answer, so an outside click resolves false for every variant.
  const onBackdrop = (event: React.MouseEvent) => {
    if (event.target === event.currentTarget) onResolve(false);
  };

  const buttons = (
    <div className={styles.actions}>
      {cancel !== null && <Button onClick={() => onResolve(false)}>{cancel}</Button>}
      <Button variant={destructive ? 'danger' : 'plain'} onClick={() => onResolve(true)}>
        {confirm}
      </Button>
    </div>
  );

  /*
   * Rendered into body, never where it was called from. `position: fixed` resolves against the
   * nearest TRANSFORMED ancestor rather than the viewport, and the deck pages live inside a
   * translated swipe track - so a dialog raised from deck B covered deck B's page, which by then
   * is off-screen to the left. It opened where nobody could see it (a real box, 2026-10-18).
   *
   * Body is never transformed, so from here inset:0 means the actual screen, the backdrop really
   * does cover everything under it, and an anchored popover's viewport coordinates land true.
   */
  const intoBody = (node: React.ReactNode) =>
    (typeof document === 'undefined' ? node : createPortal(node, document.body));

  if (anchor) {
    return intoBody(
      <div className={styles.looseBackdrop} onClick={onBackdrop}>
        <div
          ref={panelRef}
          className={styles.popover}
          role="dialog"
          aria-label={title}
          // Hidden until placed, or the first paint is at 0,0.
          style={place ? { top: place.top, left: place.left } : { visibility: 'hidden' }}
        >
          <b className={message ? styles.popoverTitle : styles.popoverTitleAlone}>{title}</b>
          {message && <p className={styles.popoverMessage}>{message}</p>}
          {buttons}
        </div>
      </div>,
    );
  }

  return intoBody(
    <div className={styles.backdrop} role="dialog" aria-modal="true" aria-label={title} onClick={onBackdrop}>
      <div className={styles.panel}>
        <b className={message ? styles.title : styles.titleAlone}>{title}</b>
        {message && <p className={styles.message}>{message}</p>}
        {buttons}
      </div>
    </div>,
  );
}
