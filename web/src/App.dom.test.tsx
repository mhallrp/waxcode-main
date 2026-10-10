import { test, assert, beforeEach, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { App } from './App';

/** Every EventSource the app opened, so a test can push a status down one. */
const streams: Array<{ url: string; onmessage: ((event: { data: string }) => void) | null }> = [];

/** A deck with a track on it, playing or not - the state most controls need before they do anything. */
function loadDeck(deck: number, state: 'PLAYING' | 'STOPPED') {
  const stream = streams.find((s) => s.url.includes(`/decks/${deck}/status/stream`));
  stream?.onmessage?.({
    data: JSON.stringify({
      state, remain: 180, pitch: state === 'PLAYING' ? 1 : 0, relative: false, cuePoint: 0,
      loopActive: false, loopStart: 0, loopEnd: 0, elapsed: 20, timecodeValid: true,
      unreadableSeconds: 0, keyLock: false, path: '/media/pidvs/port-4/Track.mp3',
    }),
  });
}

/*
 * Does the whole app mount and survive being used?
 *
 * The type checker proves names exist; it cannot catch a TypeError thrown halfway through a render,
 * which abandons everything after it silently. The current vanilla app grew a harness for exactly
 * this after three separate symptoms turned out to be one such throw.
 */

/** The box, answering every route with something shaped correctly but empty. */
const ROUTES: Record<string, unknown> = {
  '/version': { version: 'v0.9.1' },
  '/input-mode': { mode: 'line' },
  '/record': {
    recording: false, name: null, elapsedSeconds: 0, bytes: 0,
    freeBytes: 3e9, totalBytes: 3e9, remainingSeconds: 7000, hasRecording: false,
  },
  '/library': { devices: [] },
  '/favourites': { favourites: [] },
  '/network': {
    connection: 'Home Wi-Fi', ip: '192.168.1.87/24', ap: 'no', serial: 'abcd1234',
    name: null, networks: [], saved: [], apPassword: 'x'.repeat(10), apOpen: false,
  },
  '/decks/1/state': { passthrough: false, relative: false, keyLock: false, timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line' },
  '/decks/2/state': { passthrough: false, relative: false, keyLock: false, timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line' },
};

beforeEach(() => {
  // Explicit, because auto-cleanup only runs when vitest globals are enabled - without it each test
  // renders on top of the last one and every count is doubled.
  cleanup();

  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => ROUTES[String(url).split('?')[0]!] ?? {},
  })));

  /* Streams are captured rather than merely inert, so a test can deliver a STATUS and work with a
   * deck that actually has something on it - every transport control is disabled without one. */
  streams.length = 0;
  vi.stubGlobal('EventSource', class {
    url: string;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(url: string) { this.url = url; streams.push(this as never); }
    close() {}
  });

  // jsdom implements neither, and both are used on mount.
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

/*
 * Asserted on the ACCESSIBLE NAME, not textContent. Each pip draws its label twice - two layers
 * clipped to complementary halves, which is how the colour wipes across a swipe - so textContent
 * reads "Deck ADeck A". The second layer is aria-hidden, so the accessible name is the one copy that
 * a person actually perceives, which is the thing worth asserting anyway.
 */
/*
 * The app holds a blank screen until the box has answered /version (see App.tsx) - otherwise the
 * decks render for a beat and are then replaced by whatever setup screen applies, which the owner
 * saw as his decks flashing up and vanishing. Tests have to wait for that answer, as a browser does.
 */
async function renderApp() {
  const view = render(<App />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return view;
}

test('the app mounts and offers all three pages', async () => {
  const { container } = await renderApp();
  await screen.findAllByText('Deck A');
  const pips = [...container.querySelectorAll('header button[data-page]')];
  assert.equal(pips.length, 3);
  for (const label of ['Deck A', 'Deck B', 'A+B']) {
    assert.ok(
      await screen.findByRole('button', { name: label }),
      `no pip named ${label}`,
    );
  }
});

test('an empty deck shows no track rather than a blank card', async () => {
  await renderApp();
  // Four: one per deck card, and one per column on the A+B page.
  assert.equal((await screen.findAllByText('No track')).length, 4);
});

/*
 * Settings opening is the most load-bearing interaction here: it mounts a pane that fetches, and a
 * throw in it takes the whole sheet with it.
 *
 * It must open on SOFTWARE. GET /network runs a wifi scan on the box that takes about three seconds,
 * so defaulting to Network makes Settings feel like it is loading when it is waiting on a radio -
 * which is exactly what was reported the first time this shipped.
 */
test('settings opens on Software, not on the pane that waits for a wifi scan', async () => {
  const { container } = await renderApp();
  const settings = container.querySelector('[aria-label="Settings"]') as HTMLButtonElement;
  assert.ok(settings, 'the settings button exists');
  settings.click();

  assert.ok(await screen.findByText('Network'), 'the rail rendered');
  assert.ok(await screen.findByText('Send Diagnostics'), 'and Software is what opened');
  assert.equal(screen.queryByText('Saved networks'), null, 'the network pane must not be mounted');
});

/*
 * The rail's ORDER, not just its contents.
 *
 * Signal sits with Inputs because the two are read together - what the turntable is sending, then
 * what arrives - and Network is the long pane nobody opens twice. Asserted by position because
 * every item exists either way, so a reorder is invisible to a contains-check.
 */
test('the settings rail reads Software, Inputs, Signal, Network, Recording', async () => {
  const { container } = await renderApp();
  (container.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click();
  await screen.findByText('Send Diagnostics');

  const rail = [...container.querySelectorAll('nav button')].map((b) => b.textContent);
  assert.deepEqual(rail, ['Software', 'Inputs', 'Signal', 'Network', 'Recording']);
});

/* The box fetches its own releases now, so this row WORKS rather than explaining why it cannot. That
 * is the whole point of the change: somebody can delete the app and still update their box. */
test('Software Update can be pressed, with both versions beside it', async () => {
  const { container } = await renderApp();
  (container.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click();

  const update = await screen.findByRole('button', { name: /Software Update/ });
  assert.equal((update as HTMLButtonElement).disabled, false, 'it is actionable');
  assert.ok(await screen.findByText('App'), 'the app version pair');
  assert.ok(await screen.findByText('v0.9.1'), "and the box's own version");

  // And it no longer tells people to go and use the app.
  assert.equal(screen.queryByText(/Updates install from the iOS app/), null);
});

/* The reference is the entire point of sending a report - it is read down a phone by someone who
 * cannot describe the fault. A sentence is not enough; it gets a panel of its own. */
test('a sent diagnostic shows its reference code', async () => {
  const { container } = await renderApp();
  (container.querySelector('[aria-label="Settings"]') as HTMLButtonElement).click();
  const send = await screen.findByText('Send Diagnostics');

  (ROUTES as Record<string, unknown>)['/diagnostics'] = { ok: true, reference: 'K7Q2ZP' };
  await act(async () => { (send.closest('button') as HTMLButtonElement).click(); });

  assert.ok(await screen.findByText('K7Q2ZP'), 'the code itself');
  assert.ok(await screen.findByText(/Quote this code/), 'and what to do with it');
});

/*
 * The other half of the captive portal.
 *
 * The setup AP answers every probe with a redirect to `/#network` (http-api.js). That hash is the
 * only instruction the box can give a phone that has just joined its hotspot - and the sheet the OS
 * opens it in often has no address bar to correct. Landing on the decks means no way to reach the
 * one pane that exists to get the box off that hotspot.
 */
test('#network opens Settings on the network pane', async () => {
  window.location.hash = '#network';
  try {
    await renderApp();
    assert.ok(await screen.findByText('Saved networks'), 'the network pane is what opened');
  } finally {
    window.location.hash = '';
  }
});

test('no hash opens the decks, with no sheet over them', async () => {
  await renderApp();
  await screen.findAllByText('Deck A');
  assert.equal(screen.queryByText('Saved networks'), null);
});

test('Load Track opens the library for that deck', async () => {
  await renderApp();
  const load = (await screen.findAllByText('Load Track'))[0] as HTMLElement;
  load.click();
  // Twice on purpose: the sidebar says which sticks exist, the list says what is in the one chosen.
  assert.equal((await screen.findAllByText('No media inserted')).length, 2);
});

/*
 * The library is a full SCREEN with its own Back, not a sheet with a title and Done. A second bar
 * above its header would leave the breadcrumb sitting under a title saying the same thing.
 */
test('the library carries Back and a search, not sheet chrome', async () => {
  const { container } = await renderApp();
  ((await screen.findAllByText('Load Track'))[0] as HTMLElement).click();

  assert.ok(await screen.findByText('Back'), 'its own Back');
  assert.equal(screen.queryByText('Done'), null, 'and no sheet chrome');
  assert.ok(
    container.querySelector('input[type="search"]'),
    'the search field, which lives at the foot of the list',
  );
  assert.ok(
    container.querySelector('[aria-label="Sort"]'),
    'and sorting is a menu rather than a row of buttons',
  );
});

/*
 * What a deck with no track lets you touch.
 *
 * These were exactly backwards on the first port: the transport sat lit and green on a deck it would
 * not act on, while the two locks - which are deck SETTINGS, adjustable whether or not a record is
 * loaded - were greyed out. Only passthrough turns the locks off, because a deck playing a real
 * record through the box has nothing to lock.
 */
test('an empty deck disables the transport but leaves the locks usable', async () => {
  const { container } = await renderApp();
  await screen.findAllByText('No track');

  const cue = [...container.querySelectorAll('button')].find((b) => b.textContent === 'CUE');
  assert.ok(cue, 'the CUE button exists');
  assert.equal(cue.disabled, true, 'nothing to cue without a track');

  const position = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Position'));
  assert.ok(position, 'the Position lock exists');
  assert.equal(position.disabled, false, 'a lock is a deck setting, not a track action');
});

test('Load Track stays usable on an empty deck - it is the whole point of one', async () => {
  const { container } = await renderApp();
  const load = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Load Track');
  assert.ok(load);
  assert.equal(load.disabled, false);
});

/*
 * PASSTHROUGH - a deck passing a real record through the box rather than playing a file.
 *
 * This was missed entirely on the first port: seven separate things gate on it, and none of them
 * did. A deck in passthrough has nothing to cue, nothing to loop, nothing to load onto, nothing to
 * lock, no readouts to show and no waveform to draw - and it announces itself rather than looking
 * like an empty deck.
 */
function withPassthrough(on: boolean) {
  const state = {
    passthrough: on, relative: false, keyLock: false,
    timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line',
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = String(url).split('?')[0]!;
    return {
      ok: true,
      status: 200,
      json: async () => (path.endsWith('/state') ? state : ROUTES[path] ?? {}),
    };
  }));
}

test('a deck in passthrough says so, rather than looking empty', async () => {
  withPassthrough(true);
  await renderApp();
  assert.ok(await screen.findAllByText('Passthrough active'));
  assert.equal(screen.queryAllByText('No track').length, 0);
});

test('passthrough disables everything that acts on a track', async () => {
  withPassthrough(true);
  const { container } = await renderApp();
  await screen.findAllByText('Passthrough active');

  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text);

  assert.equal(button('CUE')?.disabled, true, 'nothing to cue');
  assert.equal(button('Load Track')?.disabled, true, 'nothing to load onto');
  assert.equal(button('1')?.disabled, true, 'nothing to loop');
  const position = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Position'));
  assert.equal(position?.disabled, true, 'nothing to lock');
});

/* And the opposite, so the gates are not just "everything off": an ordinary empty deck still lets
 * you load onto it and still lets you set its locks. */
test('an empty deck is not treated as passthrough', async () => {
  withPassthrough(false);
  const { container } = await renderApp();
  await screen.findAllByText('No track');
  const button = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text);

  assert.equal(button('Load Track')?.disabled, false);
  const position = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Position'));
  assert.equal(position?.disabled, false);
});

/*
 * Play/pause is OPTIMISTIC. A control whose result the client can work out should show it the moment
 * it is pressed, not a round trip later - the icon flipping a second after the tap reads as a deck
 * that did not hear you.
 */
test('the play icon flips on the press, not on the reply', async () => {
  const state = {
    passthrough: false, relative: false, keyLock: false,
    timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line',
  };
  // A reply that never arrives, so anything that changes must have changed optimistically.
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    if (init?.method === 'POST') return new Promise(() => {}) as never;
    return { ok: true, status: 200, json: async () => (path.endsWith('/state') ? state : ROUTES[path] ?? {}) };
  }));

  const { container } = await renderApp();
  await screen.findAllByText('No track');

  // A deck with nothing on it has its transport disabled, so there would be nothing to press.
  act(() => loadDeck(1, 'STOPPED'));
  const play = [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Play');
  assert.ok(play, 'starts showing Play');
  assert.equal(play.disabled, false, 'and is usable with a track loaded');
  play.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    [...container.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Pause'),
    'and shows Pause immediately, with no reply from the box',
  );
});

/*
 * CUEP has to respond on the press, both halves of it.
 *
 * It jumps to the cue point AND starts playing, and the client knows both the instant it is tapped.
 * Waiting for a status costs up to a full second, which is what made it feel unresponsive against
 * the app on a network that is not remotely slow.
 */
test('CUEP shows the jump and the play immediately, with no reply from the box', async () => {
  const state = {
    passthrough: false, relative: false, keyLock: false,
    timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line',
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).split('?')[0]!;
    if (init?.method === 'POST') return new Promise(() => {}) as never; // never answers
    return { ok: true, status: 200, json: async () => (path.endsWith('/state') ? state : ROUTES[path] ?? {}) };
  }));

  const { container } = await renderApp();
  await screen.findAllByText('No track');
  act(() => loadDeck(1, 'STOPPED'));

  const cuep = [...container.querySelectorAll('button')].find((b) => b.textContent === 'CUEP');
  assert.ok(cuep, 'the CUEP button exists');
  assert.equal(cuep.disabled, false);

  cuep.click();
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(
    [...container.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Pause'),
    'shows as playing straight away',
  );
});

/*
 * The rotate prompt must NEVER appear over setup, and the fragment cannot be trusted to prevent it:
 * Apple's Captive Network Assistant drops it, so the app loaded with no idea it was being set up
 * and covered the only page that mattered with "rotate to landscape". Reported three times before
 * the cause was found (2026-09-29).
 */
test('a client on the setup network gets setup, with no rotate prompt, even with no #setup', async () => {
  assert.equal(window.location.hash, '', 'no fragment, as the captive browser leaves it');
  (ROUTES as Record<string, unknown>)['/version'] = {
    version: 'v0.9.1', onSetupNetwork: true,
  };
  try {
    await renderApp();
    assert.ok(await screen.findByText('Connect to Wi-Fi'), 'setup, because the BOX said so');
    assert.equal(screen.queryByText(/rotate/i), null, 'and never the rotate prompt');
  } finally {
    (ROUTES as Record<string, unknown>)['/version'] = { version: 'v0.9.1' };
  }
});

test('a client on the normal network is left alone', async () => {
  await renderApp();
  await screen.findAllByText('Deck A');
  assert.equal(screen.queryByText('Connect to Wi-Fi'), null, 'no setup screen on the LAN');
});


