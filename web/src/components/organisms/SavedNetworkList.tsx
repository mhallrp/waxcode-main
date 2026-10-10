import { useState } from 'react';
import type { SavedNetwork } from '../../types';
import { Badge } from '../atoms/Badge';
import { Button } from '../atoms/Button';
import { css } from '../../styles/css';

const styles = css('SavedNetworkList', {
  row: `
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 11px 0;
    border-bottom: 1px solid var(--hairline);
    font-size: 14px;
  `,
  ssid: `
    /* flex 1 1 auto with min-width 0, or a long SSID pushes the Forget button off the row. */
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  `,
  forget: `
    flex: 0 0 auto; padding: 5px 10px; color: var(--ink-dim); font-size: 12px;
  `,
  empty: `
    padding: 11px 0; margin: 0; color: var(--ink-faint); font-size: 13px;
  `,
});

interface Props {
  networks: SavedNetwork[];
  onForget: (network: SavedNetwork) => void;
  busySsid?: string | null;
}

export function SavedNetworkList({ networks, onForget, busySsid }: Props) {
  /** Two taps, not one. */
  const [confirming, setConfirming] = useState<string | null>(null);

  if (networks.length === 0) return <p className={styles.empty}>None yet.</p>;

  return (
    <div>
      {networks.map((network) => (
        <div key={network.ssid} className={styles.row}>
          <span className={styles.ssid}>{network.ssid}</span>
          {network.active && <Badge>IN USE</Badge>}
          <Button
            variant={confirming === network.ssid ? 'danger' : 'plain'}
            className={styles.forget}
            busy={busySsid === network.ssid}
            busyLabel="…"
            onClick={() => {
              if (confirming !== network.ssid) { setConfirming(network.ssid); return; }
              setConfirming(null);
              onForget(network);
            }}
          >
            {confirming === network.ssid
              ? (network.active ? 'Forget? This drops you' : 'Really forget?')
              : 'Forget'}
          </Button>
        </div>
      ))}
    </div>
  );
}
