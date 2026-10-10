import type { ReactNode } from 'react';
import { ErrorText } from '../atoms/ErrorText';
import { css } from '../../styles/css';

const styles = css('Field', {
  field: `
    margin: 0 0 var(--gap);
  `,
  label: `
    display: block; margin-bottom: 6px; color: var(--ink-dim); font-size: 12px;
  `,
});

interface Props {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  /** The box names which FIELD was at fault, so the message belongs here, not at the form's foot. */
  error?: string | null;
}

/** A labelled input with its own error. One field, one message, one place to look. */
export function Field({ label, htmlFor, children, error }: Props) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={htmlFor}>{label}</label>
      {children}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
