import { useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import type { InputMode } from '../../types';
import { Label } from '../../components/atoms/Label';
import { Hint } from '../../components/atoms/Hint';
import { ErrorText } from '../../components/atoms/ErrorText';
import { SegmentedControl } from '../../components/molecules/SegmentedControl';

const MODES = [
  { value: 'phono', label: 'Phono' },
  { value: 'line', label: 'Line' },
] as const satisfies ReadonlyArray<{ value: InputMode; label: string }>;

export function InputsPane() {
  const input = useBoxData(api.inputMode);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(mode: InputMode) {
    setSaving(true);
    setError(null);
    const answer = await api.setInputMode(mode);
    setSaving(false);
    if (!answer.ok) setError(`That didn't take — ${answer.detail ?? answer.reason}.`);
    await input.refresh();
  }

  return (
    <>
      <Label>Input</Label>
      <SegmentedControl
        options={MODES}
        value={input.data?.mode ?? null}
        disabled={saving}
        onChange={(mode) => void choose(mode)}
      />
      <ErrorText>{error}</ErrorText>
      <Hint>
        Phono is for turntables that plug straight in with no preamp — most of them. Line is for decks
        with a preamp built in, or a mixer&rsquo;s line output. On Phono the box also applies the
        standard record EQ when you play real vinyl through it. Changing this restarts both decks.
      </Hint>
    </>
  );
}
