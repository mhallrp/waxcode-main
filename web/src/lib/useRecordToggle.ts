import { api } from './api';
import { useBoxData } from './useBoxData';
import { useConfirm } from './useConfirm';
import type { RecordState } from '../types';

/** The record button's behaviour, shared so the deck and desktop layouts cannot drift apart. */
export function useRecordToggle() {
  const [confirm, dialog] = useConfirm();
  const record = useBoxData<RecordState>(api.record, { everyMs: 1000 });

  async function toggle(anchor?: HTMLElement | null) {
    const state = record.data;

    if (state?.recording) {
      /* A small popover beside the button, with no cancel: carrying on recording is what happens
       * if you click anywhere else, and a button saying so read as "keep the recording". Not
       * styled destructive either - the take so far is kept. */
      const ok = await confirm({
        title: 'Stop recording?',
        confirm: 'Stop Recording',
        cancel: null,
        anchor,
      });
      if (!ok) return;
    } else if (state?.hasRecording) {
      // Named, because "a recording" is far easier to dismiss than one you recognise. This one
      // does lose data, so it keeps its explicit buttons and its centred dialog.
      const ok = await confirm({
        title: 'Replace the existing recording?',
        message: `${state.name ?? 'The current recording'} will be deleted. Copy it to a USB stick `
          + 'first from Settings if you want to keep it.',
        confirm: 'Replace and Record',
        destructive: true,
      });
      if (!ok) return;
    }

    await api.recordCommand(record.data?.recording ? 'stop' : 'start');
    await record.refresh();
  }

  // `confirm` is handed back as well so a screen needing its own confirmation shares this
  // one dialog host, rather than mounting a second that could render at the same time.
  return { record, toggle, dialog, confirm };
}
