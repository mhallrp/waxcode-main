import type { InputHTMLAttributes } from 'react';
import { css } from '../../styles/css';

const styles = css('TextField', {
  input: `
    display: block;
    width: 100%;
    padding: 11px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    /** 16px is not a taste decision: iOS Safari zooms the page in on focus for anything smaller */
    font: 400 16px/1.2 var(--sans);
    -webkit-appearance: none;
    appearance: none;
    &:focus { outline: none; border-color: var(--accent); }
  `,
});

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>;

export function TextField(props: Props) {
  // autoCapitalize/spellCheck off by default: almost every field here is an SSID or a password
  return <input autoCapitalize="none" spellCheck={false} autoComplete="off" {...props} className={styles.input} />;
}
