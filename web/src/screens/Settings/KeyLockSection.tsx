import { useState } from 'react';
import type { KeyLockFeature } from '../../types';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { Label } from '../../components/atoms/Label';
import { Hint } from '../../components/atoms/Hint';
import { ErrorText } from '../../components/atoms/ErrorText';
import { SegmentedControl } from '../../components/molecules/SegmentedControl';
import { css } from '../../styles/css';

const styles = css('KeyLockSection', {
  section: `
    /** No margin-top of its own: the pane's .section already provides the gap */
    padding-top: 22px; border-top: 1px solid var(--hairline);
  `,
  row: `
    display: flex; align-items: center; gap: 10px; margin-top: 12px;
  `,
  tag: `
    display: inline-block;
    margin-left: 8px;
    padding: 2px 7px;
    border: 1px solid var(--warning);
    border-radius: 3px;
    color: var(--warning);
    font: 600 9px/1.4 var(--mono);
    text-transform: uppercase;
    letter-spacing: 1px;
    vertical-align: middle;
  `,
});

type Mode = 'off' | 'on';

/** Key lock, shipped as an experiment rather than a feature. */
export function KeyLockSection() {
  const feature = useBoxData<KeyLockFeature>(api.keyLockFeature);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabled = feature.data?.enabled === true;

  async function apply(on: boolean) {
    setBusy(true);
    setError(null);
    const result = await api.setKeyLockFeature(on);
    setBusy(false);
    if (!result.ok) { setError('That could not be saved.'); return; }
    await feature.refresh();
  }

  return (
    <div className={styles.section}>
      <Label>Key lock<span className={styles.tag}>Experimental</span></Label>
      <Hint>
        {/* The whole warning, in one line. The measurements behind it, and why no setting avoids it,
            belong in keylock.c, not on a settings pane. */}
        Holds a track&rsquo;s key while you change tempo. Softens drum hits &mdash; kicks lose punch.
      </Hint>

      <div className={styles.row}>
        <SegmentedControl<Mode>
          options={[{ value: 'off', label: 'Off' }, { value: 'on', label: 'On' }]}
          value={enabled ? 'on' : 'off'}
          onChange={(mode) => void apply(mode === 'on')}
          disabled={busy || feature.data === null}
        />
      </div>

      {error !== null && <ErrorText>{error}</ErrorText>}
    </div>
  );
}
