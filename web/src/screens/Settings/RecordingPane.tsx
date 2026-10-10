import { useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { clock } from '../../lib/format';
import { Hint } from '../../components/atoms/Hint';
import { Button } from '../../components/atoms/Button';
import { Reading } from '../../components/molecules/Reading';
import { RecordMeter } from '../../components/organisms/RecordMeter';
import { useRecordLevel } from '../../lib/useRecordLevel';
import { useLibrary } from '../../lib/useLibrary';
import { useCoarsePointer } from '../../lib/useCoarsePointer';
import { css } from '../../styles/css';

const styles = css('RecordingPane', {
  actions: `
    display: flex; gap: var(--gap-sm); margin-top: var(--gap);
    & > * { flex: 1; }
  `,
  progress: `
    margin-top: var(--gap-sm);
  `,
  track: `
    height: 6px; border-radius: 3px; background: var(--bg); overflow: hidden;
  `,
  fill: `
    height: 100%; background: var(--accent); transition: width 200ms linear;
  `,
  caption: `
    display: block; margin-top: 6px; color: var(--ink-faint); font-size: 11px;
  `,
});

const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

const gigabytes = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** What the kernel calls a filesystem, and what a person does. */
const FILESYSTEMS: Record<string, string> = {
  vfat: 'FAT32',
  exfat: 'exFAT',
  ntfs3: 'NTFS (slow to write)',
  ntfs: 'NTFS (slow to write)',
  hfsplus: 'Mac OS Extended (slow to write)',
};

export function RecordingPane() {
  const [confirm, dialog] = useConfirm();
  const [busy, setBusy] = useState<'export' | 'purge' | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Faster while rolling, so the elapsed time does not visibly lag.
  const record = useBoxData(api.record, { everyMs: 1000 });
  const state = record.data;

  /** Only while this pane is open. */
  const level = useRecordLevel(true);

  /** Shown here on purpose, and temporarily: a copy to a stick that takes HOURS rather than seconds is almost always the FILESYSTEM */
  const devices = useLibrary() ?? [];

  /** Download is offered on a POINTER device only. */
  const onPhone = useCoarsePointer();

  async function run(command: 'export' | 'purge') {
    if (command === 'purge') {
      const ok = await confirm({
        title: 'Delete the recording?',
        message: `${state?.name ?? 'The current recording'} will be gone for good. Copy it to a USB `
          + 'stick first if you want to keep it.',
        confirm: 'Delete',
        destructive: true,
      });
      if (!ok) return;
    }

    setBusy(command);
    setNote(null);
    const answer = await api.recordCommand(command);
    setBusy(null);
    setNote(answer.ok
      ? (command === 'export' ? 'Copied to the USB stick.' : 'Deleted.')
      : `That didn't work — ${answer.detail ?? answer.reason}.`);
    await record.refresh();
  }

  return (
    <>
      <Reading label="Status">
        {state?.recording ? `Recording ${clock(state.elapsedSeconds)}` : state?.hasRecording ? 'Stopped' : 'Nothing recorded'}
      </Reading>
      <Reading label="Space left">
        {state ? `${gigabytes(state.freeBytes)} · about ${Math.floor(state.remainingSeconds / 3600)}h` : '—'}
      </Reading>
      {state?.name && <Reading label="File">{state.name}</Reading>}

      {devices.map((device) => (
        <Reading key={device.id} label="USB stick">
          {device.name}
          {device.fsType ? ` · ${FILESYSTEMS[device.fsType] ?? device.fsType}` : ''}
        </Reading>
      ))}

      <RecordMeter level={level} />

      <div className={styles.actions}>
        {/* href, so the BROWSER owns the transfer: it survives this screen closing, resumes on a
            dropped connection, and never holds the file in the page. */}
        {!onPhone && (
          <Button href="/record/download" disabled={!state?.hasRecording || state.recording}>
            Download
          </Button>
        )}
        <Button
          disabled={!state?.hasRecording || state.recording}
          busy={busy === 'export'}
          busyLabel="Copying…"
          onClick={() => void run('export')}
        >
          Copy to USB
        </Button>
        <Button
          variant="danger"
          disabled={!state?.hasRecording || state.recording}
          busy={busy === 'purge'}
          busyLabel="Deleting…"
          onClick={() => void run('purge')}
        >
          Delete
        </Button>
      </div>

      {state?.exporting && (
        /** Driven by the status poll rather than a stream of its own: a copy long enough to need a bar is tens of seconds */
        <div className={styles.progress}>
          <div className={styles.track}>
            <div
              className={styles.fill}
              style={{ width: `${(state.exporting.copied / Math.max(1, state.exporting.total)) * 100}%` }}
            />
          </div>
          <span className={styles.caption}>
            {`Copying to the USB stick — ${megabytes(state.exporting.copied)} of `
              + `${megabytes(state.exporting.total)}. Leave the stick in until it finishes.`}
          </span>
        </div>
      )}

      <Hint>
        {note ?? (onPhone
          ? 'Start and stop recording with the record button on the deck screen. To get a mix onto '
            + 'a computer instead, open this screen in a browser on the same network.'
          : 'Start and stop recording with the record button on the deck screen. Download saves '
            + 'the mix straight to this computer - no stick needed.')}
      </Hint>
      {dialog}
    </>
  );
}
