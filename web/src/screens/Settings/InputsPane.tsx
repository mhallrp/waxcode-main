import { useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import type { InputMode } from '../../types';
import { Label } from '../../components/atoms/Label';
import { Hint } from '../../components/atoms/Hint';
import { ErrorText } from '../../components/atoms/ErrorText';
import { SegmentedControl } from '../../components/molecules/SegmentedControl';
import { css } from '../../styles/css';

const styles = css('InputsPane', {
  output: `
    margin-top: 28px;
  `,
  row: `
    display: flex; align-items: center; gap: 14px;
  `,
  slider: `
    flex: 1; min-width: 0; height: 28px; margin: 0;
    accent-color: var(--cue);
    /* A finger, not a mouse: the native track is too thin to find on a phone. */
    &::-webkit-slider-runnable-track { height: 3px; border-radius: 2px; background: var(--hairline); }
    &::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 22px; height: 22px; margin-top: -10px; border-radius: 50%;
      background: var(--cue); border: none;
    }
    &:disabled { opacity: 0.4; }
  `,
  reading: `
    /* Tabular, so the number does not shuffle the slider sideways as it changes. */
    min-width: 62px; text-align: right;
    font: 500 14px/1 var(--mono); font-variant-numeric: tabular-nums;
    color: var(--ink);
  `,
});

const MODES = [
  { value: 'phono', label: 'Phono' },
  { value: 'line', label: 'Line' },
] as const satisfies ReadonlyArray<{ value: InputMode; label: string }>;

export function InputsPane() {
  const input = useBoxData(api.inputMode);
  const trim = useBoxData(api.outputTrim);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Held locally while the finger is down: the slider has to track the drag at 60fps, and the box
     is only told where it landed. */
  const [draggingDb, setDraggingDb] = useState<number | null>(null);

  async function choose(mode: InputMode) {
    setSaving(true);
    setError(null);
    const answer = await api.setInputMode(mode);
    setSaving(false);
    if (!answer.ok) setError(`That didn't take — ${answer.detail ?? answer.reason}.`);
    await input.refresh();
  }

  async function commitTrim(db: number) {
    setDraggingDb(null);
    await api.setOutputTrim(db);
    await trim.refresh();
  }

  const trimDb = draggingDb ?? trim.data?.db ?? 0;

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
        Phono for turntables with no preamp, Line for decks that have one. Changing this restarts
        both decks.
      </Hint>

      {/* Offered only when the engine has the command - an older xwax would show a slider that
          moves and changes nothing. Same test key lock uses. */}
      {trim.data?.available !== false && (
        <div className={styles.output}>
          <Label>Output trim</Label>
          <div className={styles.row}>
            <input
              className={styles.slider}
              type="range"
              min={trim.data?.min ?? -20}
              max={trim.data?.max ?? 0}
              step={0.5}
              value={trimDb}
              aria-label="Output trim in decibels"
              disabled={!trim.data}
              onChange={(event) => setDraggingDb(Number(event.target.value))}
              onPointerUp={() => { if (draggingDb !== null) void commitTrim(draggingDb); }}
              onKeyUp={() => { if (draggingDb !== null) void commitTrim(draggingDb); }}
            />
            <span className={styles.reading}>{trimDb === 0 ? '0.0 dB' : `${trimDb.toFixed(1)} dB`}</span>
          </div>
          <Hint>
            Brings the box&rsquo;s own tracks down to sit level with the vinyl. Down only &mdash;
            digital already leaves near full scale.
          </Hint>
        </div>
      )}
    </>
  );
}
