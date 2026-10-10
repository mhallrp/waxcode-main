import { useState } from 'react';
import { Rail, type RailItem } from '../../components/organisms/Rail';
import { SoftwarePane } from './SoftwarePane';
import { InputsPane } from './InputsPane';
import { NetworkPane } from './NetworkPane';
import { SignalPane } from './SignalPane';
import { RecordingPane } from './RecordingPane';
import {
  SoftwareIcon, InputsIcon, SignalIcon, NetworkIcon, RecordingIcon,
} from './RailIcons';
import { css } from '../../styles/css';

const styles = css('SettingsScreen', {
  body: `
    /* min-height: 0 so the detail column scrolls instead of stretching the sheet. */
    display: flex; height: 100%; min-height: 0;
  `,
  detail: `
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    /* Contained, so reaching the end of this list does not start scrolling the page behind it. */
    overscroll-behavior: contain;
    padding: 22px calc(40px + env(safe-area-inset-right, 0px))
             calc(34px + env(safe-area-inset-bottom, 0px)) 24px;
    /* Spacing between groups within a pane. Global rather than per-pane: every pane wants the same. */
    & .section { margin-top: var(--gap-lg); }
  `,
});

export type PaneId = 'software' | 'inputs' | 'network' | 'signal' | 'recording';

const ITEMS = [
  { id: 'software', label: 'Software', icon: SoftwareIcon },
  { id: 'inputs', label: 'Inputs', icon: InputsIcon },
  { id: 'signal', label: 'Signal', icon: SignalIcon },
  { id: 'network', label: 'Network', icon: NetworkIcon },
  { id: 'recording', label: 'Recording', icon: RecordingIcon },
] as const satisfies ReadonlyArray<RailItem<PaneId>>;

/** Only the mounted pane runs. */
function Pane({ id }: { id: PaneId }) {
  switch (id) {
    case 'software': return <SoftwarePane />;
    case 'inputs': return <InputsPane />;
    case 'network': return <NetworkPane />;
    case 'signal': return <SignalPane />;
    case 'recording': return <RecordingPane />;
  }
}

export function SettingsScreen({ initialPane }: { initialPane?: PaneId }) {
  /** Software, not Network. */
  const [active, setActive] = useState<PaneId>(initialPane ?? 'software');

  return (
    <div className={styles.body}>
      <Rail items={ITEMS} active={active} onSelect={setActive} />
      <main className={styles.detail}>
        <Pane id={active} />
      </main>
    </div>
  );
}
