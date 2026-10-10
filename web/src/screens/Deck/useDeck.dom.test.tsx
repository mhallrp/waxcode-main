import { test, assert, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDeck } from './useDeck';

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
  POSTS.length = 0;
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
