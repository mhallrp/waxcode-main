/*
 * Generates the browser UI's design tokens FROM the iOS app's own source, so the two surfaces
 * cannot drift apart.
 *
 * The palette and the waveform constants used to be hand-copied into the browser UI by hand.
 * Both were correct on the day; neither would survive a change in the app, and the failure would be
 * silent - a slightly different red, or a compression curve that no longer matches, with nothing to
 * say so. The colours are the obvious half; the RENDERING constants are the half that matters more,
 * because drift there changes the picture rather than the paint.
 *
 * Run from the waxcode repo:
 *   node tools/generate-design-tokens.mjs            # write the token files
 *   node tools/generate-design-tokens.mjs --check    # fail if they are out of date
 *
 * The iOS repo is a sibling checkout and is NOT on the box, so this runs here and the generated
 * files are committed - the box only ever serves the output.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/* The React app, a sibling checkout. It is the browser UI now - server/web/ holds nothing but its
 * build output, which this generator must not write into. Same tokens as the iOS app, different
 * module shape, so the two surfaces cannot drift from each other, which is why this exists. */
const appDir = join(here, '..', '..', 'web', 'src', 'styles');
const iosArg = process.argv.find((a) => a.startsWith('--ios='));
const iosRoot = resolve(iosArg ? iosArg.slice('--ios='.length) : join(here, '..', '..', 'ios'));
const check = process.argv.includes('--check');

const SOURCES = {
  colors: 'PiDVS/DesignSystem/WaxColor.swift',
  waveform: 'PiDVS/Views/Overview/Components/DeckSlot/Shared/WaveformRendering.swift',
  focused: 'PiDVS/Views/Overview/Components/DeckSlot/Shared/FocusedWaveformCanvas.swift',
  deckLogic: 'PiDVS/Views/Overview/Components/DeckSlot/Card/DeckSlotCardLogic.swift',
};

function read(key) {
  const path = join(iosRoot, SOURCES[key]);
  if (!existsSync(path)) {
    console.error(`Cannot find ${path}`);
    console.error('Pass the iOS checkout with --ios=/path/to/ios if it is not a sibling of this repo.');
    process.exit(2);
  }
  return readFileSync(path, 'utf8');
}

/**
 * `static let name = Color(hex: 0xRRGGBB)` -> { name: '#RRGGBB' }, then aliases.
 *
 * The aliases are not cosmetic. The app deliberately names one value twice where the two names mean
 * different things to a reader (`warning = recording`), and matching only the literal form silently
 * dropped every one of them - which is the exact drift this generator exists to prevent. Found by
 * the browser UI needing a --warning that was never generated.
 */
function parseColors(source) {
  const out = {};
  for (const [, name, hex] of source.matchAll(/static let (\w+) = Color\(hex: 0x([0-9A-Fa-f]{6})\)/g)) {
    out[name] = `#${hex.toUpperCase()}`;
  }
  // A second pass, because an alias may be declared above the colour it points at.
  for (const [, name, target] of source.matchAll(/static let (\w+) = (\w+)$/gm)) {
    if (out[target] && !out[name]) out[name] = out[target];
  }
  return out;
}

/** `static let name[: CGFloat] = 1.23` -> { name: 1.23 } */
function parseNumbers(source, names) {
  const out = {};
  for (const name of names) {
    const match = source.match(new RegExp(`static let ${name}(?:\\s*:\\s*\\w+)?\\s*=\\s*(-?[\\d.]+)`));
    if (!match) {
      console.error(`Could not find ${name} - the app moved or renamed it, so this generator is stale.`);
      process.exit(2);
    }
    out[name] = Number(match[1]);
  }
  return out;
}

/** `static let name = (r: 0.85, g: 0.18, b: 0.18)` -> { name: [0.85, 0.18, 0.18] } */
function parseRgbTuples(source, names) {
  const out = {};
  for (const name of names) {
    const match = source.match(new RegExp(`static let ${name} = \\(r: ([\\d.]+), g: ([\\d.]+), b: ([\\d.]+)\\)`));
    if (!match) {
      console.error(`Could not find the ${name} tuple - this generator is stale.`);
      process.exit(2);
    }
    out[name] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  return out;
}

const colorSource = read('colors');
const waveSource = read('waveform');

const colors = parseColors(colorSource);
const bands = parseRgbTuples(waveSource, ['lowColor', 'midColor', 'highColor']);
const waveNumbers = parseNumbers(waveSource, ['barGapFraction', 'minBarWidth', 'nonBassCeiling', 'nonBassCeilingRatio']);
const focused = parseNumbers(read('focused'), ['bucketWidthPixels']);
const deckLogic = parseNumbers(read('deckLogic'), [
  'stoppedConvergenceStep', 'playingConvergenceStep', 'jumpGraceSeconds', 'loopLengthMatchTolerance',
]);

const cueMatch = waveSource.match(/cueColor = Color\(red: ([\d.]+), green: ([\d.]+), blue: ([\d.]+)\)/);
const cueRgb = cueMatch
  ? [Number(cueMatch[1]), Number(cueMatch[2]), Number(cueMatch[3])].map((v) => Math.round(v * 255))
  : null;
if (!cueRgb) {
  console.error('Could not find cueColor - this generator is stale.');
  process.exit(2);
}

const BANNER = `/* GENERATED from the iOS app by tools/generate-design-tokens.mjs - do not edit.
   Re-run that script after changing PiDVS/DesignSystem or the waveform constants. */`;

/** camelCase -> kebab-case, so inkDim reads as --ink-dim and deckADim as --deck-a-dim. */
const kebab = (name) => name
  .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
  .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
  .toLowerCase();

const css = `${BANNER}

:root {
${Object.entries(colors).map(([name, hex]) => `  --${kebab(name)}: ${hex};`).join('\n')}

  /* Kept as a name this stylesheet already uses; --warning is the generated one. */
  --alert: ${colors.warning};

  /* The cue marker drawn on a waveform - WaveformRendering.cueColor. */
  --cue-marker: rgb(${cueRgb.join(',')});
}
`;

const JS_BANNER = `/*
 * GENERATED from the iOS app by tools/generate-design-tokens.mjs - do not edit.
 * Re-run that script after changing PiDVS/DesignSystem or the waveform constants.
 */`;

/* The same values as a real ES module, typed. `as const` so a token name is checked at compile time
 * rather than failing silently as undefined - the drift this generator exists to prevent, caught one
 * step earlier. */
const ts = `${JS_BANNER}

export const tokens = ${JSON.stringify({
  bands,
  ...waveNumbers,
  ...focused,
  ...deckLogic,
  cueColor: `rgb(${cueRgb.join(',')})`,
}, null, 2)} as const;

/** Every colour, also as a module, for the rare case a value is needed in TS rather than CSS. */
export const colors = ${JSON.stringify(colors, null, 2)} as const;

export type ColorName = keyof typeof colors;
`;

// Only when the sibling checkout is actually there, so this stays usable on its own.
const targets = existsSync(appDir)
  ? [[join(appDir, 'tokens.css'), css], [join(appDir, 'tokens.ts'), ts]]
  : [];

let stale = false;
for (const [path, contents] of targets) {
  const current = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (current === contents) continue;
  stale = true;
  if (check) console.error(`out of date: ${path}`);
  else writeFileSync(path, contents);
}

if (check) {
  if (stale) {
    console.error('Design tokens are out of date - run: node tools/generate-design-tokens.mjs');
    process.exit(1);
  }
  console.log('design tokens up to date');
} else {
  console.log(stale ? 'design tokens written' : 'design tokens already up to date');
}
