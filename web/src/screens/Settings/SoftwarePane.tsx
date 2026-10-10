import { useState } from 'react';
import type { UpdateState } from '../../types';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { startUpdate } from '../../lib/startUpdate';
import { Hint } from '../../components/atoms/Hint';
import { ActionRow } from '../../components/molecules/ActionRow';
import { css } from '../../styles/css';

const styles = css('SoftwarePane', {
  versionRow: `
    display: flex; gap: 28px; margin-bottom: 22px;
  `,
  version: `
    display: flex; flex-direction: column; gap: 3px;
  `,
  label: `
    font-style: normal;
    font: 500 10px/1.3 var(--mono);
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--ink-faint);
  `,
  value: `
    font: 500 15px/1 var(--mono); color: var(--ink-dim);
  `,
  reference: `
    /** The code is the whole point of sending a report */
    margin-top: 14px;
    padding: 14px 16px;
    border: 1px solid var(--cue);
    border-radius: var(--radius);
    background: var(--surface2);
    & b {
      display: block;
      font: 600 26px/1.1 var(--mono);
      letter-spacing: 3px;
      color: var(--cue);
    }
    & span { display: block; margin-top: 6px; color: var(--ink-dim); font-size: 12px; }
  `,
});

const DIAGNOSTICS_HINT = "Sends this box's recent activity to Waxcode so a problem can be looked at.";

const UPDATE_HINT = 'Checks for a newer version and installs it.';

/** Why the box will not install right now, in the owner's words rather than the server's list. */
function whyNot(state: UpdateState | null): string | null {
  if (!state) return null;
  if (state.ok === false && state.reason === 'unreachable') {
    return 'This box could not reach Waxcode. Try again when it is online.';
  }
  if (state.ok === false && state.reason === 'box-unreachable') {
    return 'Lost contact with the box. It may already be restarting - give it a minute and reload.';
  }
  if (state.ok === false && state.reason === 'no-identity') {
    return 'This box has not finished setting itself up yet.';
  }
  if (state.ok === false && state.reason === 'unauthorized') {
    return 'Waxcode refused this box. Send diagnostics and quote the code.';
  }
  /** The reasons are listed rather than summarised: "a deck has a track loaded" is something you can act on */
  if (!state.safe && state.reasons.length > 0) {
    return `Not now - ${state.reasons.join(', ')}. Updating restarts the decks.`;
  }
  return null;
}

function Version({ label, children }: { label: string; children: string }) {
  return (
    <span className={styles.version}>
      <i className={styles.label}>{label}</i>
      <b className={styles.value}>{children}</b>
    </span>
  );
}

export function SoftwarePane() {
  const version = useBoxData(api.version);
  const [sending, setSending] = useState(false);
  const [confirm, dialog] = useConfirm();
  /** Checked on demand, not polled: it is a call out to the internet */
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  /** Two outcomes with different shapes: a reference to read out, or a sentence saying why there isn't one. */
  const [result, setResult] = useState<{ reference: string } | { failed: string } | null>(null);

  async function sendDiagnostics() {
    setSending(true);
    setResult(null);
    const answer = await api.sendDiagnostics();
    setSending(false);
    if (answer.ok) {
      setResult({ reference: answer.reference });
      return;
    }
    // Which failure it was matters: a box with nowhere to send was set up incompletely
    setResult({
      failed: answer.reason === 'no-endpoint'
        ? 'This box has nowhere to send diagnostics to yet. Nothing was sent.'
        : `Collected, but couldn't reach Waxcode (${answer.detail ?? answer.reason}). `
          + 'Try again when the box is online.',
    });
  }

  async function checkAndInstall() {
    setChecking(true);
    const state = await api.update();
    setUpdate(state);

    if (!state.ok || !state.newer || !state.safe) { setChecking(false); return; }

    /** Asked before installing, because it stops the decks and recompiles the audio engine. */
    const ok = await confirm({
      title: `Install ${state.latest}?`,
      message: 'The box will restart and the decks will stop for a few minutes. Anything loaded will '
        + 'be cleared.',
      confirm: 'Install',
      cancel: 'Not Now',
    });
    if (!ok) { setChecking(false); return; }

    /** The same path the banner takes, so both land on the update screen and neither invents its own idea of what installing looks like. */
    const started = await startUpdate();
    setChecking(false);

    /** Only a FAILED start is reported here - a successful one raises the update screen over everything, and this pane is gone. */
    if (!started.ok) setUpdate({ ...state, ok: false, reason: started.reason ?? 'box-unreachable' });
  }

  return (
    <>
      <div className={styles.versionRow}>
        {/* The page IS the app here, so it has no version of its own to report. */}
        <Version label="App">Web</Version>
        <Version label="Box">{version.data?.version ?? '—'}</Version>
      </div>

      <ActionRow
        label={update?.newer && update.safe ? `Install ${update.latest}` : 'Software Update'}
        onPress={() => void checkAndInstall()}
        busy={checking}
        busyLabel={update?.applying ? 'Installing…' : 'Checking…'}
      />
      <Hint>{whyNot(update) ?? UPDATE_HINT}</Hint>

      {update?.applying && (
        <div className={styles.reference}>
          <b>{update.applying}</b>
          <span>Installing. The box will restart on its own - give it a few minutes.</span>
        </div>
      )}
      {update?.ok && !update.newer && (
        <Hint>{`Already on ${update.running ?? 'the latest version'}.`}</Hint>
      )}

      {/* Its own group, set apart from the update above it: one changes the box, this only
          describes it, and run together they read as two halves of the same control. */}
      <div className="section">
        <ActionRow
          label="Send Diagnostics"
          onPress={() => void sendDiagnostics()}
          busy={sending}
          busyLabel="Collecting…"
        />
        <Hint>{result && 'failed' in result ? result.failed : DIAGNOSTICS_HINT}</Hint>

        {result && 'reference' in result && (
          <div className={styles.reference}>
            <b>{result.reference}</b>
            <span>Sent. Quote this code when you report the problem.</span>
          </div>
        )}
      </div>


      {dialog}
    </>
  );
}
