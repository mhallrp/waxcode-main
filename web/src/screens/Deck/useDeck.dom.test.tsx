import { test, assert, vi, beforeEach } from 'vitest';
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { useDeck } from './useDeck';
import { resetKeyLockNoticeForTest } from '../../lib/keyLockNotice';
import { isDeckPlaying } from '../../lib/deckPlaying';
import { resetResumesForTest } from '../../lib/useResume';

/**
 * There must be exactly ONE answer to "where is the playhead".
 *
 * When the scrub owned its own held position, everything else asked the DECK instead and got the
 * box's stale value - so CUE snapped to the nearest beat of where the track used to be, and a loop
 * started from there too. Three separate symptoms, one cause.
 */

const POSTS: Array<{ path: string; body: unknown }> = [];
/** What /library answers with. Mutable, so a test can run with a track the library does not carry. */
const LIBRARY: { value: unknown } = { value: { devices: [] } };
/** What /key-lock answers with: what the engine can do, and whether the notice is spent. */
const KEY_LOCK: { value: { available: boolean; acknowledged: boolean } } = {
  value: { available: true, acknowledged: true },
};
const streams: Array<{ url: string; onmessage: ((event: { data: string }) => void) | null }> = [];

const emit = (match: string, data: unknown) =>
  streams.find((s) => s.url.includes(match))?.onmessage?.({ data: JSON.stringify(data) });

/** A status with a track on it. */
function sendStatus(elapsed = 20) {
  emit('/decks/1/status/stream', {
    state: 'STOPPED', remain: 100 - elapsed, pitch: 0, relative: false, cuePoint: 0,
    loopActive: false, loopStart: 0, loopEnd: 0, elapsed,
    timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/x.mp3',
  });
}

/**
 * The waveform, which can only be sent AFTER the status has flushed.
 *
 * The stream is opened by an effect keyed on the loaded path, so until the status update has been
 * committed there is no stream to emit into - and emitting into nothing silently leaves the deck
 * with no peaks, which is how a scrub gets quietly refused for lack of a scale.
 */
function sendWaveform() {
  // 2500 buckets = 100s at the box's own 0.04s per bucket, so seconds-per-pixel is realistic.
  const count = 2500;
  const bytes = new Uint8Array(2 + count * 5);
  new DataView(bytes.buffer).setUint16(0, count, true);
  emit('/analysis/waveform/stream', {
    done: true,
    b64: btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join('')),
  });
}

beforeEach(() => {
  cleanup();
  resetKeyLockNoticeForTest();
  resetResumesForTest();
  POSTS.length = 0;
  KEY_LOCK.value = { available: true, acknowledged: true };
  LIBRARY.value = { devices: [] };
  streams.length = 0;
  vi.stubGlobal('EventSource', class {
    url: string;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(url: string) { this.url = url; streams.push(this as never); }
    close() {}
  });
  vi.stubGlobal('requestAnimationFrame', () => 0);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      POSTS.push({ path: String(url), body: init.body ? JSON.parse(String(init.body)) : null });
    }
    return {
      ok: true,
      status: 200,
      json: async () => {
        if (String(url).endsWith('/state')) {
          return { passthrough: false, relative: false, keyLock: false, timecodeSide: 'serato_2a', sensitivity: 0, inputMode: 'line' };
        }
        if (String(url).includes('/library')) return LIBRARY.value;
        /* Already acknowledged, so key lock behaves like any other control here. The first press
           and its one-time notice get a test of their own below. */
        if (String(url).includes('/key-lock')) return KEY_LOCK.value;
        // A loop means nothing without a grid, so toggleLoop refuses outright when there is none.
        if (String(url).includes('/analysis/beatgrid')) return { bpm: 120, firstBeatSeconds: 0 };
        return {};
      },
    };
  }));
});

test('the deck reports one position, and a scrub moves it', () => {
  const view = renderHook(() => useDeck(1, true));
  assert.equal(view.result.current.position, 0);
  assert.ok(view.result.current.scrubHandlers, 'and it owns the scrub, so nothing else can disagree');
});

/*
 * The reported fault: scrub somewhere, press CUE, and the cue lands where the box still thinks the
 * deck is rather than where the waveform is showing. CUE snaps to the nearest BEAT of the position,
 * so with no grid it should use the position exactly.
 */
test('CUE drops its cue at the position on screen, not the box\'s', async () => {
  const view = renderHook(() => useDeck(1, true));

  // Move the playhead the way an optimistic transport action does, then cue against it.
  act(() => { view.result.current.status; });
  await act(async () => { await view.result.current.cue(); });

  const setCue = POSTS.find((p) => p.path.includes('/cue/set'));
  assert.ok(setCue, 'a stopped deck DROPS a cue rather than recalling one');
  // Position is 0 with no status, so this pins the wiring rather than a number: it must send the
  // deck's own position, not read status.elapsed.
  assert.deepEqual(setCue.body, { seconds: 0 });
});

test('a loop starts from the deck position too', async () => {
  const view = renderHook(() => useDeck(1, true));
  // No grid, so nothing should be sent at all rather than a loop of NaN length.
  await act(async () => { await view.result.current.toggleLoop(4); });
  assert.equal(POSTS.filter((p) => p.path.includes('/loop')).length, 0, 'no grid, no loop');
});

/*
 * THE TEST THAT MATTERS. Drag the waveform, and everything that asks the deck where the playhead is
 * must get the DRAGGED position - not the box's. This is what CUE, the countdown and a loop's start
 * all read, and when they read the box instead you get the cue landing in the wrong place.
 */
test('a scrub moves the deck position, so CUE lands where the waveform is', async () => {
  const view = renderHook(() => useDeck(1, true));
  await act(async () => { sendStatus(20); });
  await act(async () => { sendWaveform(); });
  assert.equal(view.result.current.position, 20, 'starts where the box says');
  assert.ok((view.result.current.peaks?.length ?? 0) > 0, 'and has a waveform to measure against');

  const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
  const event = (clientX: number, timeStamp = 0) =>
    ({ pointerId: 1, clientX, timeStamp, currentTarget: target, stopPropagation() {} }) as never;

  act(() => view.result.current.scrubHandlers.onPointerDown(event(500)));
  act(() => view.result.current.scrubHandlers.onPointerMove(event(400, 13000)));

  const dragged = view.result.current.position;
  assert.ok(dragged > 20, `the deck itself reports the dragged position, not 20 (got ${dragged})`);

  // And CUE uses it. No grid here, so the snap is a no-op and the exact position is sent.
  await act(async () => { await view.result.current.cue(); });
  const setCue = POSTS.find((p) => p.path.includes('/cue/set'));
  assert.ok(setCue, 'a stopped deck drops a cue');
  assert.ok(
    Math.abs((setCue.body as { seconds: number }).seconds - dragged) < 0.01,
    'the cue lands where the waveform is showing',
  );
});

/*
 * CUE on a RUNNING deck jumps to the cue point and PAUSES - GOTO_CUE's own documented behaviour.
 *
 * Anchoring it at full speed made the playhead run on from the cue point until a status snapped it
 * back, which is what "it keeps playing for a moment then settles" looked like.
 */
test('CUE on a playing deck stops it, rather than running on from the cue point', async () => {
  const view = renderHook(() => useDeck(1, true));
  await act(async () => { sendStatus(20); });
  await act(async () => { sendWaveform(); });

  // Start it, so CUE takes its recall branch rather than dropping a new cue.
  await act(async () => { await view.result.current.playPause(); });
  assert.equal(view.result.current.playing, true);

  await act(async () => { await view.result.current.cue(); });

  assert.equal(view.result.current.playing, false, 'cue pauses, so the icon goes back to Play');
  assert.ok(POSTS.some((p) => p.path.endsWith('/cue')), 'and it recalled rather than setting one');
});

/**
 * The reported fault: a track loaded onto a deck that was ALREADY PLAYING drew its overview but left
 * the focused window blank.
 *
 * `elapsed + remain` is not a length during a load. remain comes from xwax's track->length, which
 * GROWS as it decodes, and a playing deck has statuses streaming throughout - so the first tick where
 * remain creeps above zero is caught, and the length is a few seconds instead of a few minutes. The
 * overview survived that (it downsamples across the full width whatever the length says), while the
 * focused window computed bucket indices far past the end of the array and drew nothing.
 */
test('the length comes from the library, not from a track->length still growing', async () => {
  LIBRARY.value = { devices: [{ id: 'd', name: 'Stick', tracks: [{ path: '/x.mp3', title: 'X', duration: 305.763 }] }] };

  const view = renderHook(() => useDeck(1, true));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  // A status mid-import: 3 seconds decoded so far, on a deck 20 seconds in.
  await act(async () => {
    emit('/decks/1/status/stream', {
      state: 'PLAYING', remain: 3, pitch: 1, relative: false, cuePoint: 0,
      loopActive: false, loopStart: 0, loopEnd: 0, elapsed: 20,
      timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/x.mp3',
    });
  });

  assert.equal(
    view.result.current.duration, 305.763,
    'the file\'s own length, not the 23s that elapsed + remain implies mid-decode',
  );
});

/* Without a library entry there is nothing better, so the status is still used. */
test('a path the library does not carry still measures itself off the status', async () => {
  const view = renderHook(() => useDeck(1, true));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  await act(async () => { sendStatus(20); });
  assert.equal(view.result.current.duration, 100, 'elapsed 20 + remain 80');
});

/*
 * Reported: a visible delay between tapping a loop button and it lighting. The button read from
 * STATUS, so it waited for the box to send back a pair of timestamps - up to a second on a control
 * somebody is using in time with music.
 */
test('a loop lights on the tap, not when the box reports it back', async () => {
  const view = renderHook(() => useDeck(1, true));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  // A grid is needed before a loop means anything, and it arrives with the track.
  await act(async () => { sendStatus(20); });
  await act(async () => { await Promise.resolve(); });

  assert.equal(view.result.current.activeLoopBeats, null, 'nothing looping to begin with');

  await act(async () => { await view.result.current.toggleLoop(4); });

  assert.equal(
    view.result.current.activeLoopBeats, 4,
    'lit immediately, with no STATUS saying so yet',
  );

  /* The waveform's shaded region reads the same range, so it cannot lag the button - it was still
   * reading STATUS directly after the button was fixed (owner-reported, 2026-09-30). */
  const loop = view.result.current.loop;
  assert.ok(loop, 'and the waveform has a range to shade, on the same press');
  assert.ok(
    Math.abs((loop.end - loop.start) - 4 * (60 / 120)) < 0.001,
    `four beats at 120bpm is 2s, got ${loop.end - loop.start}`,
  );
});

/* The same for the locks, which waited on a POST and then a second fetch of /state. */
test('the locks move on the tap, before the box has confirmed', async () => {
  const view = renderHook(() => useDeck(1, true));
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });

  const before = view.result.current.keyLock;
  await act(async () => { await view.result.current.setKeyLock(!before); });
  assert.equal(view.result.current.keyLock, !before, 'the button followed the finger');
});

/*
 * The one-time notice.
 *
 * Key lock stopped being an opt-in in Settings on 2026-10-11 and became an ordinary deck control,
 * so this press is the only place left that can say what it costs - it softens transients, and
 * kicks lose some punch. Once, though: a warning on every press is noise, and noise gets ignored.
 */
let latestDeck: ReturnType<typeof useDeck> | null = null;

/** Renders the dialog the way DeckPanel does, so the press can actually be answered. */
function DeckHarness() {
  const state = useDeck(1, true);
  latestDeck = state;
  return <>{state.keyLockDialog}</>;
}

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test('the first key lock press explains itself, and goes through when accepted', async () => {
  KEY_LOCK.value = { available: true, acknowledged: false };
  render(<DeckHarness />);
  await settle();

  const pressed = latestDeck!.setKeyLock(true);
  await settle();

  /* One line, and nothing under it. The notice used to run to two sentences about drum punch;
     somebody reaching for a control reads the first few words or none (owner, 2026-10-19). */
  assert.ok(screen.getByText(/Experimental feature, may degrade audio quality/i), 'it says what it is');
  assert.notMatch(document.body.textContent ?? '', /kicks lose a little punch/i, 'and no more than that');
  assert.equal(POSTS.filter((p) => p.path.includes('keylock')).length, 0, 'nothing sent yet');

  await act(async () => { screen.getByText('Turn it on').click(); await pressed; });

  assert.equal(POSTS.filter((p) => p.path.includes('/decks/1/keylock')).length, 1, 'now it is sent');
  assert.ok(POSTS.some((p) => p.path.includes('/key-lock')), 'and the notice is spent, on the box');
});

/* Declining must leave the deck exactly as it was. The old switch defaulted to off for a reason -
 * somebody who reads this and thinks better of it has not asked for anything. */
test('declining the notice leaves key lock alone', async () => {
  KEY_LOCK.value = { available: true, acknowledged: false };
  render(<DeckHarness />);
  await settle();

  const pressed = latestDeck!.setKeyLock(true);
  await settle();
  await act(async () => { screen.getByText('Not now').click(); await pressed; });

  assert.equal(POSTS.filter((p) => p.path.includes('/decks/1/keylock')).length, 0, 'nothing sent');
  assert.equal(latestDeck!.keyLock, false, 'and the button did not move');
});

/* Second press, same session: no dialog, straight through. */
test('once acknowledged the notice never appears again', async () => {
  KEY_LOCK.value = { available: true, acknowledged: true };
  render(<DeckHarness />);
  await settle();

  await act(async () => { await latestDeck!.setKeyLock(true); });

  assert.equal(screen.queryByText(/Experimental feature, may degrade audio quality/i), null, 'no dialog');
  assert.equal(POSTS.filter((p) => p.path.includes('/decks/1/keylock')).length, 1);
});

/*
 * Field report, 2026-10-22 (v0.16.0): deck A "got stuck on 1 track", the turntable did nothing, and
 * loading a track asked "Deck 1 is playing" over a deck that was standing still. The box had
 * stopped reporting on that deck; nothing here could tell, so the last status it ever got stayed
 * on screen and went on being treated as the truth.
 */
test('a deck the box has stopped reporting on is not claimed to be playing', () => {
  let now = 0;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.useFakeTimers();

  try {
    renderHook(() => useDeck(1, true));
    act(() => {
      emit('/decks/1/status/stream', {
        state: 'PLAYING', remain: 80, pitch: 1, relative: false, cuePoint: 0,
        loopActive: false, loopStart: 0, loopEnd: 0, elapsed: 20,
        timecodeValid: true, unreadableSeconds: 0, keyLock: false, path: '/x.mp3',
      });
    });
    assert.equal(isDeckPlaying(1), true, 'a deck that just said PLAYING is playing');

    const opened = streams.length;
    // Four seconds without a word. The box sends one of these every 50ms.
    act(() => { now += 4000; vi.advanceTimersByTime(4000); });

    assert.equal(isDeckPlaying(1), false, 'silence is not evidence that it is still playing');
    assert.ok(streams.length > opened, 'and the stream is rebuilt rather than waited on');
  } finally {
    vi.useRealTimers();
    clock.mockRestore();
  }
});

/*
 * An iOS home-screen app is suspended the moment it leaves the foreground - a screen lock does it -
 * and a stream killed while it was away often never fires onerror, so it comes back looking open
 * and stays silent. The three-second watchdog would catch it eventually; this catches it at once,
 * which on an older phone is several times a set.
 */
test('coming back from the background rebuilds the status stream', () => {
  renderHook(() => useDeck(1, true));
  const opened = streams.filter((s) => s.url.includes('/decks/1/status/stream')).length;

  act(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  const now = streams.filter((s) => s.url.includes('/decks/1/status/stream')).length;
  assert.ok(now > opened, 'the stream was trusted to have survived being suspended');
});
