import { useEffect, useId, useRef, useState } from 'react';
import { api } from '../../lib/api';
import type { NetworkState } from '../../types';
import { Button } from '../../components/atoms/Button';
import { Hint } from '../../components/atoms/Hint';
import { Select } from '../../components/atoms/Select';
import { TextField } from '../../components/atoms/TextField';
import { Field } from '../../components/molecules/Field';
import { RevealField } from '../../components/molecules/RevealField';
import { messageFor } from './messages';
import { css } from '../../styles/css';

const styles = css('JoinNetworkForm', {
  pickerActions: `
    /* The two quiet controls under the picker, on one line rather than stacked. */
    display: flex;
    align-items: center;
    gap: var(--gap-sm);
  `,
});

interface Props {
  network: NetworkState;
  onJoined: () => void;
  /** Refetches the network state. */
  onRefresh?: () => Promise<unknown>;
  /** Fired the moment a join STARTS, not when it finishes. */
  onJoining?: (ssid: string) => void;
  /** And this when the box answered after all, which only happens when the join FAILED. */
  onJoinFailed?: () => void;
}

/** Errors keyed by the field the box blamed, so each lands under the input it is about. */
type FieldErrors = Partial<Record<'ssid' | 'password' | 'adminPassword', string>>;

export function JoinNetworkForm({ network, onJoined, onJoining, onJoinFailed, onRefresh }: Props) {
  const [ssid, setSsid] = useState('');
  const [typing, setTyping] = useState(false);
  const [psk, setPsk] = useState('');
  const [adminPassword, setAdminPassword] = useState('');
  const [boxName, setBoxName] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [note, setNote] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const pickerId = useId();

  /** Ask the box to look again. */
  async function rescan() {
    if (!mounted.current) return;
    setRescanning(true);
    setNote(null);
    const answer = await api.rescanNetworks();
    const seconds = (answer.ok && typeof answer.seconds === 'number') ? answer.seconds : 20;

    await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
    // Failures are expected here - the box may not be back yet - so it simply tries again.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const fresh = await onRefresh?.().catch(() => null);
      if (fresh) break;
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
    }
    // Up to ~32s has passed: the sheet may be closed and this component gone.
    if (mounted.current) setRescanning(false);
  }

  /** A scan run while the box is hosting its own network comes back with exactly that and nothing else */
  const onlyItself = network.networks.length <= 1
    && network.networks.every((seen) => seen.ssid.startsWith('Waxcode Setup'));

  // Only a box that has never been granted permission to change its own networks needs its own password.
  const needsAdmin = network.bootstrapped === 'no';

  async function join() {
    setErrors({});
    setNote(null);
    if (!ssid) {
      setErrors({ ssid: messageFor('no-ssid') });
      return;
    }

    setJoining(true);
    onJoining?.(ssid);
    // The whole form or none of it: a box wearing a name from an attempt that did not work is worse than one with no name
    const answer = await api.joinNetwork({
      ssid,
      psk,
      ...(needsAdmin ? { adminPassword, boxName: boxName.trim() || undefined } : {}),
    });
    setJoining(false);

    if (answer.ok) {
      setPsk('');
      setAdminPassword('');

      /** SAVED is a different outcome from JOINED, and saying so matters. */
      if ('joined' in answer && answer.joined === false) {
        setNote(`Saved ${ssid}. The box could not see it just now, so it will join as soon as that `
          + 'network appears - switch the hotspot on and give it a moment.');
        return;
      }

      // Named, not just "connected": on the setup network this page is the last thing that still works
      setNote(`Connected to ${ssid}. If you reached this page over the box’s own setup network, `
        + 'rejoin your usual WiFi to carry on.');
      onJoined();
      return;
    }

    /** Getting an answer at all means the box is still here, which means it did NOT join */
    onJoinFailed?.();
    const field = answer.field as keyof FieldErrors | undefined;
    const message = messageFor(answer.reason, answer.detail);
    if (field) setErrors({ [field]: message });
    else setNote(message);
  }

  return (
    <>
      {onlyItself && !typing && (
        <Hint>
          This box can only see its own network while it is broadcasting one - it has a single
          radio, and it is busy. Type your network&rsquo;s name below.
        </Hint>
      )}

      {typing || onlyItself ? (
        <Field label="Network name" htmlFor={pickerId} error={errors.ssid}>
          <TextField id={pickerId} value={ssid} onChange={(e) => setSsid(e.target.value)} />
          <div className={styles.pickerActions}>
            {!onlyItself && (
              <Button variant="quiet" onClick={() => setTyping(false)}>Choose from the list instead</Button>
            )}
            {/* Offered here too, and this is where it matters most: the list showing nothing but the
                box itself is exactly when somebody has just switched a hotspot on. */}
            {onRefresh && (
              <Button
                variant="quiet"
                busy={rescanning}
                busyLabel="Looking…"
                onClick={() => void rescan()}
              >
                Look again
              </Button>
            )}
          </div>
        </Field>
      ) : (
        <Field label="Network" htmlFor={pickerId} error={errors.ssid}>
          <Select
            id={pickerId}
            value={ssid}
            placeholder="Choose…"
            onChange={(e) => setSsid(e.target.value)}
            options={network.networks.map((seen) => ({
              value: seen.ssid,
              label: seen.secure ? seen.ssid : `${seen.ssid} (open)`,
            }))}
          />
          <div className={styles.pickerActions}>
            <Button variant="quiet" onClick={() => setTyping(true)}>Type it instead</Button>
            {onRefresh && (
              <Button
                variant="quiet"
                busy={rescanning}
                busyLabel="Looking…"
                onClick={() => void rescan()}
              >
                Look again
              </Button>
            )}
          </div>
        </Field>
      )}

      <RevealField label="Password" value={psk} onChange={setPsk} error={errors.password} />

      {needsAdmin && (
        <>
          <Field label="Whose box is this?">
            <TextField value={boxName} onChange={(e) => setBoxName(e.target.value)} />
          </Field>
          <RevealField
            label="Box password"
            value={adminPassword}
            onChange={setAdminPassword}
            error={errors.adminPassword}
          />
        </>
      )}

      <Button onClick={() => void join()} busy={joining} busyLabel="Connecting…">Connect</Button>
      {note && <Hint>{note}</Hint>}
    </>
  );
}
