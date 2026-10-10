import { css } from '../../styles/css';

const styles = css('SegmentedControl', {
  group: `
    display: flex;
    border: 1px solid var(--hairline);
    border-radius: var(--radius);
    overflow: hidden;
  `,
  option: `
    flex: 1;
    padding: 11px 14px;
    border: 0;
    border-right: 1px solid var(--hairline);
    background: transparent;
    color: var(--ink-dim);
    font: 500 15px/1 var(--mono);
    &:last-child { border-right: 0; }
    &:disabled { color: var(--ink-faint); cursor: default; }
  `,
  active: `
    background: var(--surface); color: var(--ink);
  `,
});

interface Props<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T | null;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** A small set of mutually exclusive choices, all visible at once. */
export function SegmentedControl<T extends string>({ options, value, onChange, disabled }: Props<T>) {
  return (
    <div className={styles.group} role="radiogroup">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          disabled={disabled}
          className={option.value === value ? `${styles.option} ${styles.active}` : styles.option}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
