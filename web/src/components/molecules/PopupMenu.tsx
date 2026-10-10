import { useEffect, useRef, useState, type ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('PopupMenu', {
  wrap: `
    position: relative;
  `,
  trigger: `
    /** Padding, not a bigger glyph: the app grows the tappable area and leaves the icon its own size. */
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--accent);
    font: 17px/1 var(--sans);
  `,
  iconTrigger: `
    display: inline-grid;
    place-items: center;
    padding: 10px;
    border: 0;
    background: transparent;
    color: var(--ink);
  `,
  chevron: `
    /** Grey on purpose. */
    color: var(--ink-dim);
  `,
  popup: `
    /** Left-aligned under its trigger, then pulled back on screen if that would overrun the edge - see the effect below. */
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 20;
    min-width: 150px;
    padding: 4px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
  `,
  item: `
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 8px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--ink);
    font: 400 14px/1 var(--sans);
    text-align: left;
  `,
  tick: `
    /* Fixed width whether ticked or not, so the labels do not shift as the choice changes. */
    width: 13px; color: var(--accent);
  `,
});

interface Option<T extends string> { value: T; label: string; }

interface Props<T extends string> {
  label: ReactNode;
  ariaLabel?: string;
  /** How the trigger reads. */
  variant?: 'text' | 'icon';
  /** Lets the caller colour the trigger, which is how the mode icon shows which mode it is in. */
  triggerClassName?: string;
  options: ReadonlyArray<Option<T>>;
  value: T | null;
  onChange: (value: T) => void;
}

/** How close to the edge of the CONTENT a menu may sit before it is pulled back. */
const EDGE_MARGIN = 8;

/** The right-hand limit: the viewport less the device's own inset. */
function contentRight(): number {
  const inset = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--safe-right'),
  );
  return window.innerWidth - (Number.isFinite(inset) ? inset : 0) - EDGE_MARGIN;
}

/** A small menu of mutually exclusive choices, with a tick beside the current one. */
export function PopupMenu<T extends string>({
  label, ariaLabel, variant = 'text', triggerClassName, options, value, onChange,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  /** How far the menu has to be pulled left to stay on screen. 0 for anything with room. */
  const [pullLeft, setPullLeft] = useState(0);

  // Closing on an outside press is what makes this dismissible without a backdrop element.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, [open]);

  /** Measured on open rather than guessed from CSS, because whether it fits depends on where the TRIGGER is */
  useEffect(() => {
    if (!open) { setPullLeft(0); return; }
    const element = popup.current;
    if (!element) return;
    const overflow = element.getBoundingClientRect().right - contentRight();
    setPullLeft(overflow > 0 ? overflow : 0);
  }, [open]);

  return (
    <div className={styles.wrap} ref={wrap}>
      <button
        type="button"
        className={[variant === 'icon' ? styles.iconTrigger : styles.trigger, triggerClassName]
          .filter(Boolean).join(' ')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {variant === 'text' && (
          <svg className={styles.chevron} viewBox="0 0 24 24" width="11" height="11" fill="none"
            stroke="currentColor" strokeWidth="2.4" aria-hidden="true">
            <path d="M5 9l7 7 7-7" />
          </svg>
        )}
      </button>
      {open && (
        <div
          ref={popup}
          className={styles.popup}
          role="menu"
          style={pullLeft ? { transform: `translateX(-${pullLeft}px)` } : undefined}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={option.value === value}
              className={styles.item}
              onClick={() => { onChange(option.value); setOpen(false); }}
            >
              <span className={styles.tick} aria-hidden="true">
                {option.value === value ? '✓' : ''}
              </span>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
