import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeckInputMode, LINE, PHONO } from '../src/deck-input-mode.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'pidvs-mode-'));

test('defaults to line when nothing has been set, so an existing box is unchanged', () => {
  assert.equal(createDeckInputMode({ dataDir: tempDir() }).get(), LINE);
});

test('phono writes the flag systemd will pass to xwax; line writes an empty value', () => {
  const dataDir = tempDir();
  const modes = createDeckInputMode({ dataDir });

  modes.set(PHONO);
  assert.match(readFileSync(join(dataDir, 'deck1.env'), 'utf8'), /^PIDVS_PHONO_IN=--phono$/m);

  // Empty rather than absent: xwax@.service references it unbraced so an empty value vanishes,
  // where a missing variable would be an undefined-variable error at unit start.
  modes.set(LINE);
  assert.match(readFileSync(join(dataDir, 'deck1.env'), 'utf8'), /^PIDVS_PHONO_IN=$/m);
});

test('one setting reaches every deck, because the systemd units read a file each', () => {
  const dataDir = tempDir();
  createDeckInputMode({ dataDir, deckCount: 2 }).set(PHONO);

  assert.match(readFileSync(join(dataDir, 'deck1.env'), 'utf8'), /^PIDVS_PHONO_IN=--phono$/m);
  assert.match(readFileSync(join(dataDir, 'deck2.env'), 'utf8'), /^PIDVS_PHONO_IN=--phono$/m);
});

test('a mode survives a restart', () => {
  const dataDir = tempDir();
  createDeckInputMode({ dataDir }).set(PHONO);

  assert.equal(createDeckInputMode({ dataDir }).get(), PHONO);
});

test('anything unrecognised is stored as line rather than written through', () => {
  const dataDir = tempDir();
  const modes = createDeckInputMode({ dataDir });
  assert.equal(modes.set('nonsense'), LINE);
  assert.equal(modes.get(), LINE);
});

test('a hand-edited or corrupt env file reads as line rather than throwing', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'deck1.env'), 'PIDVS_SOMETHING_ELSE=1\n');
  assert.equal(createDeckInputMode({ dataDir }).get(), LINE);
});

test('decks left disagreeing by an older per-deck build resolve to one answer, not two', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'deck1.env'), 'PIDVS_PHONO_IN=--phono\n');
  writeFileSync(join(dataDir, 'deck2.env'), 'PIDVS_PHONO_IN=\n');

  // Deck 1 is canonical - reporting a box that is in two states at once would be worse.
  assert.equal(createDeckInputMode({ dataDir }).get(), PHONO);
});

test('setting the mode rewrites every deck, clearing any earlier disagreement', () => {
  const dataDir = tempDir();
  writeFileSync(join(dataDir, 'deck1.env'), 'PIDVS_PHONO_IN=--phono\n');
  writeFileSync(join(dataDir, 'deck2.env'), 'PIDVS_PHONO_IN=\n');

  createDeckInputMode({ dataDir, deckCount: 2 }).set(LINE);

  assert.match(readFileSync(join(dataDir, 'deck1.env'), 'utf8'), /^PIDVS_PHONO_IN=$/m);
  assert.match(readFileSync(join(dataDir, 'deck2.env'), 'utf8'), /^PIDVS_PHONO_IN=$/m);
});

test('a deck left behind by the per-deck version is brought into line at startup', () => {
  const dataDir = tempDir();
  // What an upgraded box actually looks like: deck 1 set to phono, deck 2 never written.
  writeFileSync(join(dataDir, 'deck1.env'), 'PIDVS_PHONO_IN=--phono\n');

  createDeckInputMode({ dataDir, deckCount: 2 });

  // Without this, the box reports phono while deck 2's xwax starts without the flag.
  assert.match(readFileSync(join(dataDir, 'deck2.env'), 'utf8'), /^PIDVS_PHONO_IN=--phono$/m);
});

test('reconciling leaves an already-consistent box untouched', () => {
  const dataDir = tempDir();
  createDeckInputMode({ dataDir, deckCount: 2 }).set(PHONO);
  const before = readFileSync(join(dataDir, 'deck2.env'), 'utf8');

  createDeckInputMode({ dataDir, deckCount: 2 });

  assert.equal(readFileSync(join(dataDir, 'deck2.env'), 'utf8'), before);
});

test('phono changes the input only - a digital track is never attenuated', () => {
  const dataDir = tempDir();
  createDeckInputMode({ dataDir }).set(PHONO);

  const contents = readFileSync(join(dataDir, 'deck1.env'), 'utf8');
  assert.match(contents, /^PIDVS_PHONO_IN=--phono$/m, 'the timecoder still needs the lower threshold');
  // --phono-out spent 46dB inside a 16-bit path, leaving a digital track at ~47dB SNR against the
  // ~93dB it has at line level - and a preamp-less turntable forces this mode, so it hit exactly
  // the DJs this box is for. Digital now always leaves flat on the line pair instead.
  assert.match(contents, /^PIDVS_PHONO_OUT=$/m, 'the output half must stay empty');
});

test('line leaves the output untouched, exactly as before either half existed', () => {
  const dataDir = tempDir();
  createDeckInputMode({ dataDir }).set(LINE);

  const contents = readFileSync(join(dataDir, 'deck1.env'), 'utf8');
  assert.match(contents, /^PIDVS_PHONO_OUT=$/m);
  assert.match(contents, /^PIDVS_PHONO_IN=$/m);
});

test('a file written before the output half existed is completed at startup', () => {
  const dataDir = tempDir();
  // Exactly what an older build left behind: the input half only.
  writeFileSync(join(dataDir, 'deck1.env'), 'PIDVS_PHONO_IN=--phono\n');

  createDeckInputMode({ dataDir, deckCount: 2 });

  const contents = readFileSync(join(dataDir, 'deck1.env'), 'utf8');
  assert.match(contents, /^PIDVS_PHONO_IN=--phono$/m, 'the mode it already had must survive');
  assert.match(contents, /^PIDVS_PHONO_OUT=$/m, 'and the missing half gets added, now always empty');
});
