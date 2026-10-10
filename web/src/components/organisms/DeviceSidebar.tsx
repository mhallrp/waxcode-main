import type { Device, Favourite } from '../../types';
import { Icon } from '../atoms/Icon';
import { Label } from '../atoms/Label';
import { ListRow } from '../molecules/ListRow';
import { css } from '../../styles/css';

const styles = css('DeviceSidebar', {
  sidebar: `
    /** The shaded panel bleeds to the physical left edge; only its CONTENT respects the safe area. */
    width: calc(220px + 14px + env(safe-area-inset-left, 0px));
    margin: 0 0 0 calc(-14px - env(safe-area-inset-left, 0px));
    flex: 0 0 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 10px 10px 22px calc(24px + env(safe-area-inset-left, 0px));
    background: var(--surface);
    border-radius: 0 var(--radius) var(--radius) 0;
  `,
  label: `
    display: block; margin: 4px 0 6px; padding: 0 8px;
    &:not(:first-child) { margin-top: 20px; }
  `,
});

interface Props {
  devices: Device[];
  favourites: Favourite[];
  activeDeviceId: string | null;
  activePath: string;
  onDevice: (id: string) => void;
  onFavourite: (favourite: Favourite) => void;
}

/** Favourite crates, then the sticks themselves. Knows nothing about what is inside either. */
export function DeviceSidebar(props: Props) {
  const { devices, favourites, activeDeviceId, activePath } = props;
  const device = devices.find((d) => d.id === activeDeviceId);
  const mine = device ? favourites.filter((f) => f.volumeId === device.volumeId) : [];

  return (
    <aside className={styles.sidebar}>
      {mine.length > 0 && (
        <>
          <span className={styles.label}><Label>Favourites</Label></span>
          {mine.map((favourite) => {
            const segments = favourite.path.split('/').filter(Boolean);
            return (
              <ListRow
                sidebar
                key={favourite.path}
                icon={<Icon name="star" />}
                title={segments[segments.length - 1] ?? device?.name ?? 'Folder'}
                sub={segments.slice(0, -1).join(' / ') || 'Folder'}
                active={activePath === favourite.path}
                onClick={() => props.onFavourite(favourite)}
              />
            );
          })}
        </>
      )}

      <span className={styles.label}><Label>Devices</Label></span>
      {devices.length === 0 && <ListRow sidebar title="No media inserted" sub="Plug a USB stick into the box." />}
      {devices.map((d) => (
        <ListRow
          sidebar
          key={d.id}
          icon={<Icon name="drive" />}
          title={d.name || d.id}
          sub={d.scanning ? `Scanning… ${d.tracks.length} found so far` : `${d.tracks.length} tracks`}
          active={d.id === activeDeviceId}
          onClick={() => props.onDevice(d.id)}
        />
      ))}
    </aside>
  );
}
