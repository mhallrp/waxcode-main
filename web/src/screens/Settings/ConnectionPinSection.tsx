import { useState } from 'react';
import type { PinStatus } from '../../types';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { Label } from '../../components/atoms/Label';
import { Hint } from '../../components/atoms/Hint';
import { ErrorText } from '../../components/atoms/ErrorText';
import { Button } from '../../components/atoms/Button';
import { TextField } from '../../components/atoms/TextField';
import { SegmentedControl } from '../../components/molecules/SegmentedControl';
import { css } from '../../styles/css';

const styles = css('ConnectionPinSection', {
  section: `
    margin-top: 26px; padding-top: 22px; border-top: 1px solid var(--hairline);
  `,
  row: `
    display: flex; align-items: center; gap: 10px; margin-top: 12px;
  `,
  pin: `
    /** Four digits needs nowhere near the width of an SSID. */
    flex: 0 0 auto; width: 104px;
  `,
});

type Mode = 'off' | 'on';

/** The connection PIN, which is OFF unless somebody turns it on. */
export function ConnectionPinSection() {
  const status = useBoxData<PinStatus>(api.pinStatus);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const enabled = status.data?.enabled === true;

  async function apply(next: { enabled?: boolean; pin?: string }) {
    setBusy(true);
    setError(null);
    setSaved(false);
    const result = await api.setPin(next);
    setBusy(false);

    if (next.enabled === false) setPin('');

    if (!result.ok) {
      setError(result.reason === 'pin-must-be-four-digits'
        ? 'A PIN is four digits.'
        : 'That could not be saved.');
      return;
    }
    setPin('');
    setSaved(true);
    await status.refresh();
  }

  return (
    <div className={styles.section}>
      <Label>Connection PIN</Label>
      <Hint>
        {enabled
          ? 'Anyone opening this box in a browser has to enter the PIN first.'
          : 'Off. Anyone on this WiFi can control the decks. Turn it on if the network is shared.'}
      </Hint>

      <div className={styles.row}>
        <SegmentedControl<Mode>
          options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
          value={enabled ? 'on' : 'off'}
          onChange={(mode) => void apply({ enabled: mode === 'on' })}
          disabled={busy || status.data === null}
        />
      </div>

      <div className={styles.row}>
        <div className={styles.pin}>
        <TextField
          value={pin}
          inputMode="numeric"
          maxLength={4}
          placeholder="0000"
          aria-label="New PIN"
          /** Unavailable while the gate is off: a PIN that nothing checks is not a setting, and offering to change one would imply it did something. */
          disabled={!enabled || busy}
          /** Digits only, as they are typed. */
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        </div>
        <Button
          onClick={() => void apply({ pin })}
          disabled={!enabled || busy || pin.length !== 4}
          busy={busy}
        >
          Set PIN
        </Button>
      </div>

      <Hint>
        {enabled
          /** Said plainly because it is the one surprise here: a new PIN signs other devices out, which is usually the reason for changing it. */
          ? 'The PIN starts as 0000. Changing it signs out every other device.'
          : 'Turn it on to set a PIN.'}
      </Hint>

      {saved && <Hint>Saved.</Hint>}
      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
