/** The five settings icons, at the one size the rail draws them. */

const STROKE = {
  viewBox: '0 0 24 24', width: 15, height: 15,
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true,
} as const;

export const SoftwareIcon = (
  <svg {...STROKE}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.6 1.6 0 0 0 15 19.4a1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.09A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.6 1.6 0 0 0 4.6 15a1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.09A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.6 1.6 0 0 0 9 4.6h.09A1.6 1.6 0 0 0 10 3.13V3a2 2 0 1 1 4 0v.09a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.6 1.6 0 0 0 19.4 9v.09a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.09a1.6 1.6 0 0 0-1.51 1z" />
  </svg>
);

export const InputsIcon = (
  <svg {...STROKE}>
    <path d="M10 3v4M14 3v4" /><rect x="8" y="7" width="8" height="5" rx="1.6" /><path d="M12 12v9" />
  </svg>
);

export const SignalIcon = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <rect x="2" y="10" width="1.7" height="4" rx=".8" />
    <rect x="5.4" y="7" width="1.7" height="10" rx=".8" />
    <rect x="8.8" y="4" width="1.7" height="16" rx=".8" />
    <rect x="12.2" y="8" width="1.7" height="8" rx=".8" />
    <circle cx="18" cy="14" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M20.5 16.5L23 19" stroke="currentColor" strokeWidth="1.8" fill="none" />
  </svg>
);

export const NetworkIcon = (
  <svg {...STROKE} strokeLinecap="round">
    <path d="M2.5 8.5a13 13 0 0 1 19 0" /><path d="M5.8 12.2a8.6 8.6 0 0 1 12.4 0" />
    <path d="M9.1 15.9a4.2 4.2 0 0 1 5.8 0" />
    <circle cx="12" cy="19.5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);

export const RecordingIcon = (
  <svg {...STROKE}>
    <circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
  </svg>
);
