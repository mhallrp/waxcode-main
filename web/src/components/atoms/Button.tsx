import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { css } from '../../styles/css';

const styles = css('Button', {
  button: `
    /** A flex box rather than a plain block so a label centres the same whether it is one line or two */
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    min-height: var(--row);
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: transparent;
    color: var(--ink);
    font: 500 15px/1.25 var(--mono);
    padding: 11px 14px;
    text-align: center;
    text-decoration: none;
    &:disabled { color: var(--ink-faint); cursor: default; }
  `,
  row: `
    /* A full-width row with a label on the left - the app's usual "go somewhere" affordance. */
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 16px 18px;
  `,
  quiet: `
    /* Sits inside another control, so it carries no border of its own. */
    border: 0;
    padding: 6px 8px;
    color: var(--ink-faint);
    font-size: 11px;
    letter-spacing: 0.5px;
  `,
  danger: `
    color: var(--warning); border-color: var(--warning);
  `,
  linkOff: `
    color: var(--ink-faint);
    pointer-events: none;
  `,
});

type Variant = 'plain' | 'row' | 'quiet' | 'danger';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: Variant;
  /** Replaces the label while something is in flight, and disables the button. */
  busy?: boolean;
  busyLabel?: string;
  /** Renders an ANCHOR instead, styled identically. */
  href?: string;
}

export function Button({
  children, variant = 'plain', busy = false, busyLabel, className, disabled, href, ...rest
}: Props) {
  // A caller's className is appended, not replaced: positioning belongs to whoever placed the button, while how it looks stays here.
  const modifier = variant === 'plain' ? null : styles[variant];
  const classes = [styles.button, modifier, className,
    href !== undefined && disabled ? styles.linkOff : null].filter(Boolean).join(' ');
  const label = busy && busyLabel ? busyLabel : children;

  // An anchor has no disabled state of its own, so a disabled one is made unclickable and dimmed.
  if (href !== undefined) {
    return <a className={classes} href={disabled ? undefined : href} download>{label}</a>;
  }
  return (
    <button type="button" {...rest} className={classes} disabled={disabled || busy}>
      {label}
    </button>
  );
}
