import { useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import type { SavedNetwork } from '../../types';
import { Label } from '../../components/atoms/Label';
import { Hint } from '../../components/atoms/Hint';
import { ErrorText } from '../../components/atoms/ErrorText';
import { Reading } from '../../components/molecules/Reading';
import { Notice } from '../../components/organisms/Notice';
import { SavedNetworkList } from '../../components/organisms/SavedNetworkList';
import { JoinNetworkForm } from './JoinNetworkForm';
import { messageFor } from './messages';
import { ConnectionPinSection } from './ConnectionPinSection';

/** The Network pane, which is also where a box joins its first network. */
export function NetworkPane() {
  const [editing, setEditing] = useState(false);
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Paused while a form has focus, or a five-second poll overwrites what is being typed.
  const network = useBoxData(api.network, { everyMs: 5000, pause: editing });

  /** Only on the FIRST read. */
  if (!network.data) {
    return <Hint>{network.error ? `Can't reach the box — ${network.error}` : 'Reading the box…'}</Hint>;
  }

  const state = network.data;

  async function forget(saved: SavedNetwork) {
    setForgetting(saved.ssid);
    setError(null);
    const answer = await api.forgetNetwork(saved.ssid);
    setForgetting(null);
    if (!answer.ok) setError(messageFor(answer.reason, answer.detail));
    await network.refresh();
  }

  return (
    <div onFocusCapture={() => setEditing(true)} onBlurCapture={() => setEditing(false)}>
      {state.ap === 'yes' && (
        <Notice title="This box is running its own setup network">
          {state.lastReason === 'stranded'
            ? 'Because it could not get back onto the network it knows. Add one below, or it will '
              + 'keep trying that one in the background.'
            : 'Because it has no network saved. Add one below and the box will join it.'}
        </Notice>
      )}

      <Reading label="Network">{state.connection || 'Not connected'}</Reading>
      <Reading label="Address">{state.ip?.split('/')[0] || '—'}</Reading>

      {/* The setup network is OPEN, deliberately (owner's call, 2026-09-29). The page on the other
          side of it will not let anybody past until they set a password, and a box offering this
          has no network to reach anyway - it is either brand new or it has lost the one it knew.
          A box put here ON PURPOSE got there by someone walking up with a USB stick, which is
          physical access, the trust this box already rests on. */}
      {(
        <>
          <div className="section">
            <Label>Saved networks</Label>
            <SavedNetworkList
              networks={state.saved}
              busySsid={forgetting}
              onForget={(saved) => void forget(saved)}
            />
            <ErrorText>{error}</ErrorText>
          </div>

          <div className="section">
            <Label>Add a network</Label>
            <JoinNetworkForm
              network={state}
              onJoined={() => void network.refresh()}
              onRefresh={() => network.refresh()}
            />
          </div>
        </>
      )}

      {/* Outside the conditional above: the PIN is a property of the box, not of whether it happens to
          be on a network right now. */}
      <ConnectionPinSection />
    </div>
  );
}
