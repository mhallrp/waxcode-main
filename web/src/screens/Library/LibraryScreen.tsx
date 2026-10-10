import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { recallFolder, rememberFolder } from '../../lib/lastFolder';
import { useBoxData } from '../../lib/useBoxData';
import { refreshLibrary, useLibrary } from '../../lib/useLibrary';
import { useConfirm } from '../../lib/useConfirm';
import { RowMenu } from '../../components/molecules/RowMenu';
import {
  applyTrackOrder, childrenOf, fileNameOf, searchTracks, sortTracks, type SortField,
} from '../../lib/library';
import type { DeckNumber, Track } from '../../types';
import { Icon } from '../../components/atoms/Icon';
import { ListRow } from '../../components/molecules/ListRow';
import { SearchField } from '../../components/molecules/SearchField';
import { DeviceSidebar } from '../../components/organisms/DeviceSidebar';
import { LibraryHead } from './LibraryHead';
import { clock, bpm as formatBpm } from '../../lib/format';
import { BOX_TRACK, LIST_ROW } from '../../lib/trackDrag';
import { css } from '../../styles/css';
import { loadOverPlayingWarning } from '../../lib/confirmLoad';

/** How long the box holds its rescan back after a write, so a batch of files causes one scan rather than one each. */
const RESCAN_SETTLE_MS = 1200;

const styles = css('LibraryScreen', {
  screen: `
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    padding: 10px calc(14px + env(safe-area-inset-right, 0px))
             calc(12px + env(safe-area-inset-bottom, 0px)) calc(14px + env(safe-area-inset-left, 0px));
  `,
  body: `
    flex: 1; min-height: 0; display: flex;
  `,
  divider: `
    width: 1px; flex: 0 0 auto; background: var(--hairline);
  `,
  main: `
    /* position: relative so the search field and the scan banner can float over the list's foot. */
    position: relative; flex: 1; min-width: 0; display: flex; flex-direction: column; padding-left: 12px;
  `,
  writing: `
    /** Not a spinner. */
    flex: 0 0 auto;
    padding: 8px 12px;
    border-bottom: 1px solid var(--hairline);
    background: var(--surface2);
    color: var(--warning);
    font: 500 11px/1.4 var(--mono);
  `,
  list: `
    /* Room at the foot for the floating search, so the last row is never hidden underneath it. */
    flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-bottom: 60px;
  `,
  scanning: `
    /* Small, coloured, floating over the bottom of the list. */
    position: absolute;
    left: 12px;
    right: 16px;
    bottom: 62px;
    padding: 8px 12px;
    border-radius: 8px;
    background: #2563EB;
    color: #FFFFFF;
    font-size: 13px;
    text-align: center;
    pointer-events: none;
  `,
});

interface Props {
  deck: DeckNumber;
  onLoaded: () => void;
  /** Absent when the library is a permanent pane rather than a screen covering the decks. */
  onBack?: () => void;
  /** Desktop: a track is DRAGGED onto the deck it should play on, so a tap does nothing. */
  dragToLoad?: boolean;
}

export function LibraryScreen({ deck, onLoaded, onBack, dragToLoad }: Props) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  /** Null is the resting state: the folder as arranged, with nothing imposed on it. */
  const [sort, setSort] = useState<SortField | null>(null);
  const [ascending, setAscending] = useState(true);
  const [loading, setLoading] = useState<string | null>(null);

  /** Already loaded, and usually already on screen: the shell fetches this at startup and remembers it across launches */
  const devices = useLibrary() ?? [];
  const favourites = useBoxData(api.favourites, { everyMs: 10000 });

  /** Land back where this deck was last left, once - and only if that stick is still attached. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || devices.length === 0) return;
    restored.current = true;
    const saved = recallFolder(deck);
    if (saved && devices.some((one) => one.id === saved.deviceId)) {
      setDeviceId(saved.deviceId);
      setPath(saved.path);
    }
  }, [devices, deck]);


  const device = devices.find((d) => d.id === deviceId) ?? devices[0] ?? null;
  /** Recorded as it changes rather than on the way out: this screen can go away without a tidy exit - a track is loaded, or Back is pressed */
  useEffect(() => {
    if (!restored.current || !device) return;
    rememberFolder(deck, { deviceId: device.id, path });
  }, [deck, device, path]);
  const favouriteList = favourites.data?.favourites ?? [];

  const folderPath = path.join('/');
  const isFavourite = Boolean(
    device && favouriteList.some((f) => f.volumeId === device.volumeId && f.path === folderPath),
  );

  const { folders, tracks } = useMemo(
    () => (device ? childrenOf(device, path) : { folders: [], tracks: [] }),
    [device, path],
  );

  /** The sort menu's direction moved the tracks and left the folders alone, so "Z to A" reordered half the list. */
  const orderedFolders = useMemo(
    () => (ascending ? folders : [...folders].reverse()),
    [folders, ascending],
  );

  const hits = useMemo(
    () => (device && query.trim() ? searchTracks(device, path, query) : null),
    [device, path, query],
  );

  /** The order somebody arranged for THIS folder, as bare filenames, kept on the stick. */
  const folderKey = path.join('/');
  const [order, setOrder] = useState<string[]>([]);
  useEffect(() => {
    let current = true;
    setOrder([]);
    if (!device) return undefined;
    api.trackOrder(device.id, folderKey)
      /** Defensive about the SHAPE, not just the request: a box too old to know this route answers something else entirely */
      .then((answer) => { if (current) setOrder(Array.isArray(answer?.names) ? answer.names : []); })
      .catch(() => { /* a stick with no order, or one that cannot be read - both mean none */ });
    return () => { current = false; };
  }, [device, folderKey]);

  /** An arrangement is NOT a sort, and listing it among them was a modelling mistake. */
  const shown = useMemo(() => {
    if (hits) return hits;
    return sort === null ? applyTrackOrder(tracks, order) : sortTracks(tracks, sort, ascending);
  }, [hits, tracks, sort, ascending, order]);

  const [orderError, setOrderError] = useState<string | null>(null);

  /** Which row is being dragged. */
  const draggingRow = useRef<string | null>(null);
  /** The row last moved against. */
  const lastOver = useRef<string | null>(null);

  /** Search results come from a query, not from an arrangement - rearranging them would be rearranging something nobody put in that order. */
  const arranging = Boolean(dragToLoad && !hits);

  /** Moves a row to where another one is, in the list ON SCREEN, as the pointer passes over it. */
  const previewMove = useCallback((fromPath: string, overPath: string) => {
    if (fromPath === overPath || lastOver.current === overPath) return;
    const from = shown.findIndex((t) => t.path === fromPath);
    const to = shown.findIndex((t) => t.path === overPath);
    if (from === -1 || to === -1 || from === to) return;
    lastOver.current = overPath;

    const names = shown.map(fileNameOf);
    names.splice(to, 0, ...names.splice(from, 1));
    setOrder(names);
    setSort(null);
    setOrderError(null);
  }, [shown]);

  /** Files dropped onto the LIST, from the desktop, go onto the stick in the folder on screen. */
  const [writing, setWriting] = useState<string | null>(null);
  const addFiles = useCallback(async (files: File[]) => {
    if (!device || files.length === 0) return;
    setOrderError(null);

    for (const [index, file] of files.entries()) {
      const counted = files.length > 1 ? ` (${index + 1} of ${files.length})` : '';
      setWriting(`Copying ${file.name}${counted} - do not remove the stick`);
      const answer = await api.addStickTrack(device.id, folderKey, file, (fraction) => {
        setWriting(`Copying ${file.name}${counted} - ${Math.round(fraction * 100)}% - do not remove the stick`);
      });
      if (!answer.ok) {
        setWriting(null);
        setOrderError(`${file.name}: ${answer.detail ?? 'could not be copied to the stick'}`);
        return;
      }
    }
    setWriting(null);

    /** KEEP THE ORDER THEY ARRIVED IN. */
    if (device) {
      const already = shown.map(fileNameOf);
      const dropped = files.map((file) => file.name).filter((name) => !already.includes(name));
      const next = [...already, ...dropped];
      setOrder(next);
      setSort(null);
      void api.setTrackOrder(device.id, folderKey, next);
    }

    /** ASK FOR THE LIBRARY AGAIN. */
    refreshLibrary(RESCAN_SETTLE_MS + 400);
  }, [device, folderKey, shown]);

  const newFolder = useCallback(async (name: string) => {
    if (!device || !name.trim()) return;
    setOrderError(null);
    const answer = await api.makeStickFolder(device.id, folderKey, name.trim());
    if (!answer.ok) { setOrderError(answer.detail ?? 'That stick would not take a new folder.'); return; }
    refreshLibrary(RESCAN_SETTLE_MS + 400);
  }, [device, folderKey]);

  /** The right-click menu, and what it offers. */
  const [menu, setMenu] = useState<{ x: number; y: number; track: Track } | null>(null);
  // Shared: deleting a track, and loading over a deck that is playing.
  const [confirm, confirmDialog] = useConfirm();

  const deleteTrack = useCallback(async (track: Track) => {
    if (!device) return;
    const name = track.title || fileNameOf(track);
    /** NAMED, and said plainly. */
    const ok = await confirm({
      title: 'Delete from the stick?',
      message: `${name} will be removed from ${device.name}. This cannot be undone.`,
      confirm: 'Delete',
      destructive: true,
    });
    if (!ok) return;

    setOrderError(null);
    const relative = track.path.startsWith(`${device.root}/`)
      ? track.path.slice(device.root.length + 1)
      : null;
    if (!relative) { setOrderError('That track is not on this stick.'); return; }

    const answer = await api.deleteStickTrack(device.id, relative);
    if (!answer.ok) { setOrderError(answer.detail ?? 'That track could not be deleted.'); return; }
    refreshLibrary(RESCAN_SETTLE_MS + 400);
  }, [device, confirm]);

  /** Stores whatever the rows ended up as. */
  const commitOrder = useCallback(async () => {
    if (!device || order.length === 0) return;
    const answer = await api.setTrackOrder(device.id, folderKey, order);
    if (!answer.ok) setOrderError('That stick would not take the order - it may be write-protected or full.');
  }, [device, folderKey, order]);

  const load = useCallback(async (track: Track) => {
    // Asked before anything is sent: a deck that is playing is feeding a live output.
    const warning = loadOverPlayingWarning(deck);
    if (warning && !(await confirm(warning))) return;

    setLoading(track.path);
    await api.deck(deck).load(track.path);
    setLoading(null);
    onLoaded();
  }, [deck, onLoaded, confirm]);

  async function toggleFavourite() {
    if (!device || path.length === 0) return;
    // Awaited, and the box answers with the list AFTER the write - so one tap is one change.
    const answer = await api.setFavourite(device.volumeId, folderPath, !isFavourite);
    if (answer.ok) await favourites.refresh();
  }

  return (
    <div className={styles.screen}>
      <LibraryHead
        trail={[device?.name ?? 'Library', ...path]}
        onJump={(depth) => setPath(path.slice(0, depth))}
        onBack={onBack}
        showFavourite={path.length > 0}
        isFavourite={isFavourite}
        onFavourite={() => void toggleFavourite()}
        sort={sort}
        onSort={setSort}
        ascending={ascending}
        onAscending={setAscending}
      />

      <div className={styles.body}>
      <DeviceSidebar
        devices={devices}
        favourites={favouriteList}
        activeDeviceId={device?.id ?? null}
        activePath={folderPath}
        onDevice={(id) => { setDeviceId(id); setPath([]); setQuery(''); }}
        onFavourite={(favourite) => { setPath(favourite.path.split('/').filter(Boolean)); setQuery(''); }}
      />

      <div className={styles.divider} />

      <main
        className={styles.main}
        /** Files from the desktop land in the folder ON SCREEN. */
        onDragOver={dragToLoad ? (event) => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        } : undefined}
        onDrop={dragToLoad ? (event) => {
          if (event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          void addFiles(Array.from(event.dataTransfer.files));
        } : undefined}
      >
        {/* The one moment the stick is genuinely at risk, so it says so rather than spinning. */}
        {writing && <div className={styles.writing}>{writing}</div>}

        <div className={styles.list}>
          {!device && <ListRow title="No media inserted" sub="Plug a USB stick into the box." />}

          {/* Folders only when not searching: a hit's folder is not where you are standing. */}
          {!hits && orderedFolders.map((name) => (
            <ListRow
              key={name}
              dense={dragToLoad}
              chevron
              icon={<Icon name="folder" />}
              title={name}
              onClick={() => setPath([...path, name])}
            />
          ))}

          {shown.map((track) => (
            <ListRow
              key={track.path}
              /** One line on desktop. */
              dense={dragToLoad}
              title={track.title || track.path.split('/').pop() || 'Track'}
              sub={[track.artist, track.bpm ? `${formatBpm(track.bpm)} BPM` : null, track.duration ? clock(track.duration) : null]
                .filter(Boolean).join('  ·  ')}
              active={loading === track.path}
              /** Nothing on a tap in the desktop pane: the drag is what says which deck */
              onClick={dragToLoad ? undefined : () => void load(track)}
              draggable={dragToLoad}
              onDragStart={(event) => {
                event.dataTransfer.setData(BOX_TRACK, track.path);
                /** Its own type as well, so a row dropped on ANOTHER ROW rearranges rather than being read as a track arriving from somewhere else. */
                if (arranging) {
                  event.dataTransfer.setData(LIST_ROW, track.path);
                  draggingRow.current = track.path;
                  lastOver.current = null;
                }
                event.dataTransfer.effectAllowed = 'copy';
              }}
              /** Only while My Order is showing. */
              /** The rows move AS the pointer crosses them, not on the drop */
              onDragOver={arranging ? (event) => {
                if (!event.dataTransfer.types.includes(LIST_ROW)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (draggingRow.current) previewMove(draggingRow.current, track.path);
              } : undefined}
              onDrop={arranging ? (event) => {
                if (!event.dataTransfer.types.includes(LIST_ROW)) return;
                // Already in place - the preview did the moving. This only makes it stick.
                event.preventDefault();
                void commitOrder();
              } : undefined}
              /** Also on dragEnd: a drag released outside any row never drops, and the rows have already moved by then */
              /** Right-click opens the menu where the pointer is. */
              onContextMenu={dragToLoad ? (event) => {
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, track });
              } : undefined}
              onDragEnd={arranging ? () => {
                draggingRow.current = null;
                lastOver.current = null;
                void commitOrder();
              } : undefined}
            />
          ))}

          {orderError && <ListRow title={orderError} />}

          {/* Last, under the folders it sits among, because it makes one of them. */}
          {dragToLoad && device && !hits && (
            <ListRow
              dense={dragToLoad}
              /* A plus, not a folder: this row MAKES one, it is not one. */
              icon={<Icon name="plus" />}
              title="New folder…"
              onClick={() => {
                const name = window.prompt('Name for the new folder');
                if (name) void newFolder(name);
              }}
            />
          )}

          {device && !hits && folders.length === 0 && shown.length === 0 && (
            <ListRow title="Empty folder" />
          )}
          {hits?.length === 0 && <ListRow title="Nothing matches" sub="Search covers this folder only." />}
        </div>

        {/* Overlaid at the foot of the list, as the app's own banner is. The sidebar row carries the
            same count, but you cannot see it from inside a folder - which is exactly when a
            still-filling list needs explaining. */}
        {device?.scanning && (
          <div className={styles.scanning}>Scanning… {device.tracks.length} tracks found so far</div>
        )}

        <SearchField value={query} onChange={setQuery} />
      </main>
      </div>

      {confirmDialog}
      {menu && (
        <RowMenu
          at={menu}
          onClose={() => setMenu(null)}
          items={[{
            label: 'Delete from stick',
            destructive: true,
            onSelect: () => { void deleteTrack(menu.track); },
          }]}
        />
      )}
    </div>
  );
}
