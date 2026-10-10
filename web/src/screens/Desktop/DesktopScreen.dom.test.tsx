import { test, assert, beforeEach, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../../App';

/*
 * The desktop layout, which exists because a laptop was being shown one deck at a time.
 *
 * The thing worth guarding is not how it looks - it is that BOTH layouts keep working and neither
 * leaks into the other. A phone must never get the browser pane, and a laptop must never get the
 * pager it cannot swipe.
 */

const ROUTES: Record<string, unknown> = {
  '/version': { version: 'v0.10.2' },
  '/input-mode': { mode: 'line' },
  '/record': {
    recording: false, name: null, elapsedSeconds: 0, bytes: 0,
    freeBytes: 3e9, totalBytes: 3e9, remainingSeconds: 7000, hasRecording: false,
  },
  '/library': {
    devices: [{
      id: 'port-3', name: 'USB SanDisk', root: '/media/pidvs/port-3', scanning: false,
      volumeId: 'DB48-7047', fsType: 'vfat', error: null, playlists: [],
      tracks: [{ path: '/media/pidvs/port-3/Nicolette.mp3', title: 'Nicolette', artist: 'Octave One', bpm: 126, duration: 253 }],
    }],
  },
  '/favourites': { favourites: [] },
  '/uploads': { tracks: [], usedBytes: 0, availableBytes: 1e9, maxFileBytes: 5e8 },
  '/order': { names: [] },
  '/network': {
    connection: 'Home Wi-Fi', ip: '192.168.1.87/24', ap: 'no', serial: 'abcd1234',
    name: null, networks: [], saved: [], apPassword: 'x'.repeat(10), apOpen: false,
  },
  '/decks/1/state': { passthrough: false, relative: false, keyLock: false, timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line' },
  '/decks/2/state': { passthrough: false, relative: false, keyLock: false, timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line' },
};

/** Answers whichever media queries are named, so a test can be a laptop or an iPad deliberately. */
function stubMedia(answer: (query: string) => boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: answer(query),
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ROUTES[String(url).split('?')[0]!] ?? {},
  })));
  vi.stubGlobal('EventSource', class {
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(public url: string) {}
    close() {}
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

test('a laptop gets both decks at once, with the browser and no pager', async () => {
  stubMedia(() => true);
  const { container } = render(<App />);

  // Both decks on screen together is the whole point of the layout.
  assert.equal((await screen.findAllByText('No track')).length, 2);

  // The pager is for swiping between pages that no longer exist here.
  assert.equal(container.querySelectorAll('header button[data-page]').length, 0);

  // And the browser is permanent rather than something that covers the decks.
  /* The box's own sticks, and nothing else. Browsing the laptop from in here was tried and removed:
     every version needed a picker or a Shortcut, and dragging from Finder does it with no setup. */
  assert.ok((await screen.findAllByRole('button', { name: /USB SanDisk/ })).length > 0, 'the stick is listed');
  assert.equal(screen.queryByRole('button', { name: /This Laptop/ }), null);
  /* No deck picker: the drag says which deck, so choosing one from a menu first is a step that
     should not exist. */
  assert.equal(screen.queryByRole('button', { name: 'DECK A' }), null);
  assert.equal(screen.queryByRole('button', { name: 'DECK B' }), null);
  /* Nothing for sending from the laptop: a file is dragged in from Finder onto the deck it should
     play on, which needs no control of its own and nothing set up. */
  assert.equal(screen.queryByRole('button', { name: /SEND FROM LAPTOP/i }), null);
});

test('a phone keeps the pager and never shows the browser pane', async () => {
  stubMedia(() => false);
  const { container } = render(<App />);

  await screen.findAllByText('Deck A');
  assert.equal(container.querySelectorAll('header button[data-page]').length, 3);
});

/*
 * An iPad in landscape is 1024 points wide and reports itself as a Mac (iPadOS 13+), so neither
 * width nor the user agent can answer this on its own. The pointer is what actually decides, and
 * getting it wrong gives a touch device a layout built for a cursor.
 */
test('a wide touch screen stays on the phone layout', async () => {
  stubMedia((query) => query.includes('min-width') && !query.includes('pointer: fine'));
  const { container } = render(<App />);

  await screen.findAllByText('Deck A');
  assert.equal(container.querySelectorAll('header button[data-page]').length, 3, 'still the phone layout');
});

/* The library is a permanent pane on desktop, so the modal one must not ALSO be reachable - two
 * libraries on screen is two sets of breadcrumbs disagreeing about where you are. */
test('the desktop layout has one library, not two', async () => {
  stubMedia(() => true);
  render(<App />);
  await screen.findAllByText('No track');
  assert.equal(screen.queryByRole('button', { name: /Back/ }), null);
});

/* The Load Track button opened the browser. On desktop the browser never closes, so the button had
 * nothing left to do and the room it took belongs to the waveform. */
test('the desktop deck has no Load Track button', async () => {
  stubMedia(() => true);
  render(<App />);
  await screen.findAllByText('No track');
  assert.equal(screen.queryByRole('button', { name: /Load Track/i }), null);
});

test('the phone deck keeps Load Track, which is its only way into the library', async () => {
  stubMedia(() => false);
  render(<App />);
  assert.equal((await screen.findAllByRole('button', { name: /Load Track/i })).length, 2);
});


/*
 * Loading is a DRAG, not a tap. Both decks are on screen, so the drag already says which one - and
 * the deck picker it replaces was a step that said the same thing one interaction earlier.
 */
test('a track row is dragged onto a deck rather than tapped', async () => {
  stubMedia(() => true);
  render(<App />);

  const row = await screen.findByRole('button', { name: /Nicolette/ });
  assert.equal(row.getAttribute('draggable'), 'true', 'the row is draggable');

  // What it hands the deck: the path, under our own type rather than text/plain - dragging a
  // sentence must never look like dragging a track.
  const data = new Map<string, string>();
  const dataTransfer = {
    setData: (type: string, value: string) => data.set(type, value),
    types: [] as string[],
    effectAllowed: '',
  };
  row.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer }));

  assert.equal(data.get('application/x-waxcode-track'), '/media/pidvs/port-3/Nicolette.mp3');
  assert.equal(data.has('text/plain'), false, 'nothing a stray text drag could imitate');
});


/* The desktop bar has no pager, which left its left-hand side empty. The mark fills it and is the
 * only place the box says its own name - worth something with two on a bench. */
test('the desktop bar carries the logo where the pager is not', async () => {
  stubMedia(() => true);
  render(<App />);
  assert.ok(await screen.findByText('Waxcode'));
});

test('the phone bar does not, because the pager is already there', async () => {
  stubMedia(() => false);
  render(<App />);
  await screen.findAllByText('Deck A');
  assert.equal(screen.queryByText('Waxcode'), null);
});
