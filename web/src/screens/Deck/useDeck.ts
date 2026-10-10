import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { useBoxData } from '../../lib/useBoxData';
import { useDeckStatus } from '../../lib/useDeckStatus';
import { usePlayhead } from '../../lib/usePlayhead';
import { useWaveform } from '../../lib/useWaveform';
import { useBeatGrid } from '../../lib/useBeatGrid';
import { useScrub } from '../../lib/useScrub';
import { setDeckPlaying } from '../../lib/deckPlaying';
import type { DeckNumber, DeckStatus } from '../../types';
import { createBpmSpeedTracker } from '../../lib/bpmSpeed';
import type { BeatGrid } from '../../lib/useBeatGrid';
import { tokens } from '../../styles/tokens';
import { nearestBeat, waveformPlayhead } from '../../lib/waveform';
import { usePending } from '../../lib/usePending';
import { useLoadedTrack } from '../../lib/useLoadedTrack';

/** Which loop button should read as active. */
function loopBeats(loop: LoopRange | null, grid: BeatGrid | null): number | null {
  if (!loop || !grid?.bpm) return null;
  const beats = (loop.end - loop.start) / (60 / grid.bpm);
  const match = [1, 2, 4, 8].find((length) => Math.abs(beats - length) < length * tokens.loopLengthMatchTolerance);
  return match ?? null;
}

/** Where a loop runs from and to, in track seconds. */
interface LoopRange { start: number; end: number; }

/** Near enough to be the same loop. */
const SAME_LOOP_SECONDS = 0.01;

function sameLoop(a: LoopRange | null, b: LoopRange | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a.start - b.start) < SAME_LOOP_SECONDS
    && Math.abs(a.end - b.end) < SAME_LOOP_SECONDS;
}

/** One deck's live state and the things you can do to it. */
export function useDeck(deck: DeckNumber, active: boolean) {
  const { status: live } = useDeckStatus(deck, active);

  /** True while this deck is deliberately being restarted - see setTimecodeSide. */
  const [restarting, setRestarting] = useState(false);

  /** The last status that had a track on it, so the restart can be covered with what was there a moment ago rather than with nothing. */
  const held = useRef<DeckStatus | null>(null);
  if (live && live.state !== 'EMPTY') held.current = live;

  /** While restarting, the deck keeps showing what it had. */
  const status = restarting ? (held.current ?? live) : live;
  const settings = useBoxData(useCallback(() => api.deck(deck).state(), [deck]), { everyMs: 5000 });

  /* Published for the library, which is rendered beside the decks and cannot see this by props. */
  useEffect(() => {
    setDeckPlaying(deck, status?.state === 'PLAYING');
  }, [deck, status?.state]);

  const control = api.deck(deck);

  /** Optimistic play state. */
  const [pendingPlay, setPendingPlay] = useState<{ value: boolean; at: number } | null>(null);
  const playing = pendingPlay?.value ?? status?.state === 'PLAYING';

  useEffect(() => {
    if (!pendingPlay) return;
    const agreed = (status?.state === 'PLAYING') === pendingPlay.value;
    if (agreed || Date.now() - pendingPlay.at > 1200) setPendingPlay(null);
  }, [pendingPlay, status]);

  const path = status?.path ?? null;

  /** The library's entry for what is loaded. */
  const track = useLoadedTrack(path);

  /** A track's length is a FIXED property of that track, so it is captured ONCE and held. */
  const [measured, setMeasured] = useState<number | null>(null);
  const measuredFor = useRef<string | null>(null);

  useEffect(() => {
    if (path !== measuredFor.current) {
      measuredFor.current = path;
      setMeasured(null);
    }
    if (!path || !status) return;
    // Taken once, and only from a status that actually carries a position.
    if (measured === null && status.elapsed !== null && status.remain > 0) {
      setMeasured(status.elapsed + status.remain);
    }
  }, [status, measured, path]);

  const duration = track?.duration ?? measured;
  const { peaks, decoded } = useWaveform(path, duration);
  const { grid, nudge: nudgeGrid } = useBeatGrid(path);

  /** The box's own prediction of where the playhead is. */
  const { position: reported, anchorTo } = usePlayhead(status, duration);

  /** The deck's live speed, for the BPM readout */
  const bpmTracker = useRef(createBpmSpeedTracker());
  const [platterSpeed, setPlatterSpeed] = useState<number | null>(null);

  /** The track's own tempo before the platter is applied: tag first, analysed grid as a fallback */
  const baseBPM = track?.bpm ?? grid?.bpm ?? null;

  useEffect(() => {
    if (!live) return;
    bpmTracker.current.observe({
      elapsed: live.elapsed,
      /** The BOX's clock, never arrival time. */
      boxTime: typeof live.sentAt === 'number' ? live.sentAt / 1000 : null,
      pitch: live.pitch,
      timecodeValid: live.timecodeValid,
      baseBPM,
    });
    setPlatterSpeed(bpmTracker.current.displaySpeed);
  }, [live, baseBPM]);

  /* A new track starts from its own tempo, not the last one's platter speed. */
  useEffect(() => {
    bpmTracker.current.reset();
    setPlatterSpeed(null);
  }, [path]);

  /** What the BPM readout should say. */
  const displayBpm = baseBPM === null
    ? null
    : (platterSpeed !== null && platterSpeed !== 0 ? baseBPM * Math.abs(platterSpeed) : baseBPM);

  /** True while the deck is deliberately being restarted under us - see setTimecodeSide. */
  const settled = status && !restarting;

  const reportedPositionLock = settled ? status.relative !== true : !(settings.data?.relative ?? false);
  /** NULL means UNKNOWN, not off. */
  const reportedKeyLock = settled && status.keyLock !== null
    ? status.keyLock === true
    : (settings.data?.keyLock ?? false);
  const reportedPassthrough = settings.data?.passthrough ?? false;
  const reportedTimecodeSide = settings.data?.timecodeSide ?? null;

  const [positionLock, showPositionLock, revertPositionLock] = usePending(reportedPositionLock);
  const [keyLock, showKeyLock, revertKeyLock] = usePending(reportedKeyLock);
  const [passthrough, showPassthrough, revertPassthrough] = usePending(reportedPassthrough);
  const [timecodeSide, showTimecodeSide, revertTimecodeSide] = usePending(reportedTimecodeSide);

  /** The loop, as one optimistic RANGE rather than two derived answers. */
  const reportedLoop: LoopRange | null = status?.loopActive
    ? { start: status.loopStart, end: status.loopEnd }
    : null;
  const [loop, showLoop, revertLoop] = usePending(reportedLoop, 1200, sameLoop);

  // A deck passing a real record through has nothing to loop, so nothing lights and nothing shades.
  const activeLoop = reportedPassthrough ? null : loop;
  const activeLoopBeats = loopBeats(activeLoop, grid);

  const { scrubPosition, handOverTo, handlers: scrubHandlers } = useScrub({
    bucketCount: peaks?.length ?? 0,
    duration,
    position: reported,
    playing: pendingPlay?.value ?? status?.state === 'PLAYING',
    status,
    onSeek: (seconds) => control.seek(seconds),
  });

  /** Where the playhead IS: the finger first, then a released drag still waiting on the box, then the box's own prediction. */
  const raw = scrubPosition ?? reported;

  /** Floored at the run-in's bar line and capped at the track's length */
  const waveformPosition = waveformPlayhead(raw, grid, duration);

  /** Everything else. */
  const position = duration === null
    ? Math.max(0, raw)
    : Math.min(Math.max(0, raw), duration);

  /** What the controls SHOW, which is not the same as what the box has confirmed. */
  return {
    status,
    track,
    settings: settings.data,
    duration,
    position,
    waveformPosition,
    playing,
    peaks,
    decoded,
    grid,
    /* The BPM to SHOW - the track's tempo scaled by the platter. See bpmSpeed.ts. */
    displayBpm,
    scrubHandlers,

    playPause: async () => {
      const wasPlaying = playing;
      setPendingPlay({ value: !wasPlaying, at: Date.now() });
      /** Pin where it is NOW as well as the icon. */
      anchorTo(position, wasPlaying ? 0 : 1);
      const answer = await (wasPlaying ? control.pause() : control.play());
      // A command the box refused must not leave the button showing a state it never reached.
      if (!answer.ok) setPendingPlay(null);
    },

    /** CUE is two things, depending on whether the deck is running. */
    cue: async () => {
      if (playing) {
        /** GOTO_CUE jumps to the cue point and PAUSES - the box's own word for it. */
        setPendingPlay({ value: false, at: Date.now() });
        anchorTo(status?.cuePoint ?? 0, 0);
        const answer = await control.cue();
        if (!answer.ok) setPendingPlay(null);
        return;
      }
      // The client picks the snapped position, so the marker can be drawn before the box agrees.
      const target = nearestBeat(position, grid);
      anchorTo(target, 0);
      if ((await control.setCue(target)).ok) await control.seek(target);
    },

    /** Jump to the cue point and play, shown at once. */
    cuePlay: async () => {
      setPendingPlay({ value: true, at: Date.now() });
      anchorTo(status?.cuePoint ?? 0, 1);
      const answer = await control.cuePlay();
      if (!answer.ok) setPendingPlay(null);
    },

    positionLock,
    keyLock,
    passthrough,
    timecodeSide,

    /** Each shows the new value on the press, then confirms. */
    setPositionLock: async (on: boolean) => {
      showPositionLock(on);
      if (!(await control.setPositionLock(on)).ok) revertPositionLock();
      await settings.refresh();
    },
    setKeyLock: async (on: boolean) => {
      showKeyLock(on);
      if (!(await control.setKeyLock(on)).ok) revertKeyLock();
      await settings.refresh();
    },
    setTimecodeSide: async (side: string) => {
      showTimecodeSide(side);
      /** Held across the whole round trip, which is what makes the restart invisible. */
      setRestarting(true);
      try {
        if (!(await control.setTimecodeSide(side)).ok) revertTimecodeSide();
        await settings.refresh();
      } finally {
        setRestarting(false);
      }
    },
    setPassthrough: async (on: boolean) => {
      showPassthrough(on);
      if (!(await control.setPassthrough(on)).ok) revertPassthrough();
      await settings.refresh();
    },

    /** A position set from anywhere OTHER than the waveform itself - the overview, mostly. */
    seek: (seconds: number) => {
      handOverTo(seconds);
      return control.seek(seconds);
    },

    /** Set, resize or clear a loop of `beats` beats. */
    activeLoopBeats,
    loop: activeLoop,
    /** Moving the grid is a per-TRACK correction the box stores, so it survives a reload and follows the stick between ports - see grid-offset.js. */
    nudgeGrid,

    toggleLoop: async (beats: number) => {
      if (!grid?.bpm) return;
      const beat = 60 / grid.bpm;

      // Against what is SHOWN, so pressing the lit button twice in quick succession still toggles.
      if (activeLoopBeats === beats) {
        showLoop(null);
        if (!(await control.clearLoop()).ok) revertLoop();
        return;
      }

      /** The DRAWN position, not status.elapsed. */
      const start = activeLoop ? activeLoop.start : nearestBeat(position, grid);
      const end = start + beats * beat;

      // Shaded on the waveform and lit on the button, both from this, both on the press.
      showLoop({ start, end });

      /** Shrinking below where playback currently sits would leave the deck playing on past the new loop, unlooped */
      const needsRelocate = Boolean(activeLoop) && !(position >= start && position < end);

      if (!(await control.setLoop(start, end)).ok) {
        revertLoop();
        return;
      }
      if (needsRelocate) await control.relocate(start);
    },
  };
}
