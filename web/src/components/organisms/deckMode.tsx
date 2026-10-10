/** The two per-deck choices: which timecode side the record is, and whether the deck is digital or passing a real record through. */

export const SIDES = [
  { value: 'serato_2a', label: 'Serato A' },
  { value: 'serato_2b', label: 'Serato B' },
] as const;

export const MODES = [
  { value: 'digital', label: 'Digital' },
  { value: 'passthrough', label: 'Passthrough' },
] as const;

/** Level bars for digital, a plugged lead for a real record going through the box. */
function ModeIcon({ passthrough }: { passthrough: boolean }) {
  return passthrough ? (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.8" aria-hidden="true">
      <path d="M7 3v4M11 3v4" /><rect x="5" y="7" width="8" height="5" rx="1.6" />
      <path d="M9 12v3a4 4 0 004 4h2a3 3 0 013 3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true">
      <rect x="2" y="10" width="1.8" height="4" rx=".9" />
      <rect x="5.6" y="7" width="1.8" height="10" rx=".9" />
      <rect x="9.2" y="3.5" width="1.8" height="17" rx=".9" />
      <rect x="12.8" y="7" width="1.8" height="10" rx=".9" />
      <rect x="16.4" y="5" width="1.8" height="14" rx=".9" />
      <rect x="20" y="9.5" width="1.8" height="5" rx=".9" />
    </svg>
  );
}

export { ModeIcon };
