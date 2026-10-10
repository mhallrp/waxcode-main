import { useId, useState } from 'react';
import { Button } from '../atoms/Button';
import { TextField } from '../atoms/TextField';
import { Field } from './Field';
import { css } from '../../styles/css';

const styles = css('RevealField', {
  wrap: `
    /* The toggle sits INSIDE the field's border, so the pair reads as one control. */
    position: relative;
    & input { padding-right: 62px; }
  `,
  toggle: `
    position: absolute;
    top: 50%;
    right: 6px;
    transform: translateY(-50%);
  `,
});

interface Props {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  placeholder?: string;
}

/** A password field you can read back. Typing one blind on a phone is how they get entered wrong. */
export function RevealField({ label, value, onChange, error, placeholder }: Props) {
  const [shown, setShown] = useState(false);
  const id = useId();

  return (
    <Field label={label} htmlFor={id} error={error}>
      <div className={styles.wrap}>
        <TextField
          id={id}
          type={shown ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button variant="quiet" className={styles.toggle} onClick={() => setShown((s) => !s)}>
          {shown ? 'Hide' : 'Show'}
        </Button>
      </div>
    </Field>
  );
}
