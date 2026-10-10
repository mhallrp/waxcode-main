/** Reading a deck's timecode signal, and saying what is wrong with it. */

export interface DeckSignal {
  deck: number;
  offline?: boolean;
  peakLeft?: number;
  peakRight?: number;
  /** The live decode threshold, in the same full-scale units as the peaks. */
  threshold?: number;
  /** xwax's own averaged reference level. */
  refLevel?: number;
  safe?: boolean;
  forwards?: boolean;
  validCounter?: number;
}

const FULL_SCALE = 2147483647;
const DEFAULT_FLOOR = 128 << 16;
const SOLID_LOCK_COUNT = 32;
const METER_MIN_DB = -96;

export type Verdict =
  | 'offline' | 'noSignal' | 'leftChannelDead' | 'rightChannelDead'
  | 'channelWeak' | 'channelsSwapped' | 'noisy' | 'good';

export const VERDICTS: Record<Verdict, { title: string; detail: string; tone: 'bad' | 'warn' | 'good' | 'idle' }> = {
  offline: {
    title: 'Deck is off',
    detail: "This deck hasn't started yet. Load a track on it, or restart it below.",
    tone: 'idle',
  },
  noSignal: {
    title: 'No signal',
    detail: "Drop the needle on a timecode record. If it's already down, check the deck is running, "
      + 'the leads are pushed in, and Inputs matches your turntable.',
    tone: 'bad',
  },
  leftChannelDead: {
    title: 'Nothing on the left',
    detail: 'Usually a loose lead or a broken cartridge wire. Check the plugs at both ends, then swap '
      + "the leads between decks — if the fault moves with them, it's the leads.",
    tone: 'bad',
  },
  rightChannelDead: {
    title: 'Nothing on the right',
    detail: 'Usually a loose lead or a broken cartridge wire. Check the plugs at both ends, then swap '
      + "the leads between decks — if the fault moves with them, it's the leads.",
    tone: 'bad',
  },
  channelWeak: {
    title: 'One side is weak',
    detail: 'One side is much quieter than the other. Check the headshell pins and the cartridge '
      + 'screws, and have a look at the stylus for wear.',
    tone: 'warn',
  },
  channelsSwapped: {
    title: 'Channels are swapped',
    detail: 'The record is reading backwards. Swap the red and white leads on this deck — or check any '
      + 'adapter in the chain, which is the usual culprit.',
    tone: 'bad',
  },
  noisy: {
    title: 'Signal is noisy',
    detail: "There's enough level, but the timecode isn't reading cleanly. Clean the record and check "
      + "the stylus for wear — that's it nearly every time.",
    tone: 'warn',
  },
  good: {
    title: 'Signal is good',
    detail: 'This deck is tracking cleanly. Nothing to do here.',
    tone: 'good',
  },
};

export const level = (peak: number | undefined) => (peak ?? 0) / FULL_SCALE;
export const floorLevel = (signal: DeckSignal) => (signal.threshold ?? DEFAULT_FLOOR) / FULL_SCALE;

/** Doubled deliberately: xwax averages ref_level over a HALF-scale quantity while the peaks are full scale */
export const referenceLevel = (signal: DeckSignal) =>
  Math.min(1, ((signal.refLevel ?? 0) * 2) / FULL_SCALE);

/** What is wrong, most actionable first. */
export function verdictFor(signal: DeckSignal): Verdict {
  if (signal.offline) return 'offline';

  const left = level(signal.peakLeft);
  const right = level(signal.peakRight);
  const loudest = Math.max(left, right);
  const quietest = Math.min(left, right);
  const floor = floorLevel(signal);

  if (loudest < floor) return 'noSignal';
  if (quietest < floor / 4) return left > right ? 'rightChannelDead' : 'leftChannelDead';
  if (quietest < floor) return 'channelWeak';
  if (signal.forwards === false && signal.safe) return 'channelsSwapped';
  if (!signal.safe || (signal.validCounter ?? 0) < SOLID_LOCK_COUNT) return 'noisy';
  return 'good';
}

/** Logarithmic, because a linear meter spends almost all its travel in the top few dB. */
export function meterFraction(value: number): number {
  const db = 20 * Math.log10(Math.max(value, 1e-9));
  return Math.min(1, Math.max(0, (db - METER_MIN_DB) / -METER_MIN_DB));
}
