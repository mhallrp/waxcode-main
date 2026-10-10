import { useState } from 'react';
import type { UpdateState } from '../../types';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useConfirm } from '../../lib/useConfirm';
import { startUpdate } from '../../lib/startUpdate';
import { Hint } from '../../components/atoms/Hint';
import { ActionRow } from '../../components/molecules/ActionRow';
import { css } from '../../styles/css';
import { KeyLockSection } from './KeyLockSection';

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
  session: `
    /** Deliberately loud while it is open. */
    margin-top: 14px;
    padding: 14px 16px;
    border: 1px solid var(--warning);
    border-radius: var(--radius);
    background: var(--surface2);
    & b { display: block; font: 600 13px/1.3 var(--mono); color: var(--ink); }
    & span { display: block; margin-top: 6px; color: var(--ink-dim); font-size: 12px; }
  `,
});

const DIAGNOSTICS_HINT = "Sends this box's recent activity to Waxcode, so a problem can be looked "
  + 'at without you having to describe it.';

/** The box fetches its own releases now, so this surface no longer defers to the app */
const UPDATE_HINT = 'Checks Waxcode for a newer version and installs it. The box does this itself, '
  + 'so you do not need the app.';

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

const SUPPORT_HINT = 'Lets Waxcode connect to this box to fix something that cannot be fixed by an '
  + 'update. It closes itself after 30 minutes, and you can end it any time.';

/** mm:ss - a countdown is read at a glance, and 1,784 seconds is not a glance. */
function countdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
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
  /** Polled, because the box ends the session on its own */
  const support = useBoxData(api.support, { everyMs: 1000 });
  const [opening, setOpening] = useState(false);
  const [supportFailed, setSupportFailed] = useState<string | null>(null);
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

  async function startSupport() {
    /** Asked plainly, because this is the one control here that lets somebody else in. */
    const ok = await confirm({
      title: 'Allow Waxcode to connect?',
      message: 'This opens a connection to this box so a problem can be fixed directly. It lasts 30 '
        + 'minutes unless you end it sooner.',
      confirm: 'Allow',
      cancel: 'Not Now',
    });
    if (!ok) return;

    setOpening(true);
    setSupportFailed(null);
    const answer = await api.startSupport();
    setOpening(false);

    if (!answer.ok) {
      setSupportFailed(answer.reason === 'no-binary'
        ? 'This box could not reach the internet to set the connection up. Try again when it is online.'
        : `The connection could not be opened (${answer.reason}).`);
      return;
    }

    await support.refresh();
    /** Sent for them. */
    void sendDiagnostics();
  }

  async function endSupport() {
    await api.stopSupport();
    await support.refresh();
  }

  const session = support.data;

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

      <div className="section">
        {session?.active ? (
          <ActionRow label="End Remote Support" onPress={() => void endSupport()} />
        ) : (
          <ActionRow
            label="Remote Support"
            onPress={() => void startSupport()}
            busy={opening}
            busyLabel="Connecting…"
          />
        )}
        <Hint>{supportFailed ?? SUPPORT_HINT}</Hint>

        {session?.active && (
          <div className={styles.session}>
            <b>Connected · {countdown(session.secondsRemaining)} left</b>
            <span>Waxcode can reach this box until the time runs out, or until you end it.</span>
          </div>
        )}
      </div>

      {/* A box-level feature flag, so it sits with the other things that describe what this box does
          rather than with Signal, which is about timecode quality. */}
      <div className="section">
        <KeyLockSection />
      </div>
      {dialog}
    </>
  );
}
