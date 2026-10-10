/** GENERATED from the app by tools/generate-design-tokens.mjs - do not edit. */

export const tokens = {
  "bands": {
    "lowColor": [
      0.85,
      0.18,
      0.18
    ],
    "midColor": [
      0.25,
      0.75,
      0.35
    ],
    "highColor": [
      0.25,
      0.55,
      0.95
    ]
  },
  "barGapFraction": 0.3,
  "minBarWidth": 1,
  "nonBassCeiling": 50,
  "nonBassCeilingRatio": 0.2,
  "bucketWidthPixels": 2,
  "stoppedConvergenceStep": 0.004,
  "playingConvergenceStep": 0.015,
  "jumpGraceSeconds": 0.2,
  "loopLengthMatchTolerance": 0.1,
  "cueColor": "rgb(255,153,0)"
} as const;

/** Every colour, also as a module, for the rare case a value is needed in TS rather than CSS. */
export const colors = {
  "background": "#0C0B10",
  "surface": "#17141C",
  "surface2": "#201C27",
  "hairline": "#322E3A",
  "ink": "#F1EEE9",
  "inkDim": "#938E9C",
  "inkFaint": "#625D6B",
  "deckA": "#3AD9C4",
  "deckADim": "#1F5A52",
  "deckB": "#F3924D",
  "deckBDim": "#6B4626",
  "cue": "#4FD97E",
  "recording": "#E5484D",
  "warning": "#E5484D"
} as const;

export type ColorName = keyof typeof colors;
