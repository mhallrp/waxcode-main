import { useState } from 'react';
import { api } from '../lib/api';
import { Brand } from '../components/atoms/Brand';
import { Hint } from '../components/atoms/Hint';
import { ErrorText } from '../components/atoms/ErrorText';
import { Button } from '../components/atoms/Button';
import { TextField } from '../components/atoms/TextField';
import { css } from '../styles/css';

const styles = css('PinScreen', {
  screen: `
    /** Over everything, and opaque. */
    position: fixed;
    inset: 0;
    z-index: 120;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    padding: 24px;
    padding-top: calc(24px + env(safe-area-inset-top));
    background: var(--bg);
  `,
  field: `
    width: 150px;
  `,
  row: `
    display: flex; align-items: center; gap: 10px;
  `,
});

/** Asked for before anything else, when the owner has turned a PIN on. */
export function PinScreen({ onUnlocked }: { onUnlocked: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const result = await api.unlockPin(pin);
    setBusy(false);
    setPin('');

    if (result.ok) {
      onUnlocked();
      return;
    }
    /** The wait is told in seconds rather than shown as a countdown: the number only matters as "not now" */
    setError(result.reason === 'too-many-attempts'
      ? `Too many attempts. Try again in ${Math.ceil((result.retryInMs ?? 30_000) / 1000)}s.`
      : 'Wrong PIN.');
  }

  return (
    <div className={styles.screen}>
      <Brand />
      <Hint>Enter the connection PIN for this box.</Hint>

      <form
        className={styles.row}
        onSubmit={(event) => { event.preventDefault(); void submit(); }}
      >
        <div className={styles.field}>
          <TextField
            value={pin}
            inputMode="numeric"
            maxLength={4}
            placeholder="0000"
            aria-label="Connection PIN"
            autoFocus
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </div>
        <Button type="submit" disabled={busy || pin.length !== 4} busy={busy}>
          Unlock
        </Button>
      </form>

      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
