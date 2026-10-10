import type { SelectHTMLAttributes } from 'react';
import { css } from '../../styles/css';

const styles = css('Select', {
  select: `
    display: block;
    width: 100%;
    padding: 11px 12px;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--ink);
    /* 16px for the same reason as TextField: anything smaller makes iOS Safari zoom the page. */
    font: 400 16px/1.2 var(--sans);
    -webkit-appearance: none;
    appearance: none;
    &:focus { outline: none; border-color: var(--accent); }
  `,
});

interface Option { value: string; label: string; }

interface Props extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'className'> {
  options: ReadonlyArray<Option>;
  /** Shown first, with an empty value, for "nothing chosen yet". */
  placeholder?: string;
}

export function Select({ options, placeholder, ...rest }: Props) {
  return (
    <select {...rest} className={styles.select}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}
