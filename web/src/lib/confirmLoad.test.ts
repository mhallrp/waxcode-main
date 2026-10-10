import { test, assert, beforeEach } from 'vitest';
import { setDeckPlaying, isDeckPlaying } from './deckPlaying';
import { loadOverPlayingWarning } from './confirmLoad';

/*
 * Owner-reported want (2026-10-09): loading over a deck that is playing should ask first. The deck
 * being live is the whole point - a stopped or paused deck must not nag, or the warning becomes
 * something to click through without reading.
 */

beforeEach(() => {
  setDeckPlaying(1, false);
  setDeckPlaying(2, false);
});

test('a stopped deck is loaded without a word', () => {
  assert.equal(loadOverPlayingWarning(1), null);
});

test('a playing deck is asked about, and says which one', () => {
  setDeckPlaying(1, true);
  const warning = loadOverPlayingWarning(1);
  assert.ok(warning);
  assert.match(warning.title, /Deck 1/);
  // The consequence, not the mechanism: what the room hears is the thing worth stating.
  assert.match(warning.message, /hear it cut out/);
  assert.equal(warning.confirm, 'Load anyway');
  assert.equal(warning.destructive, true);
});

test('the decks are tracked apart', () => {
  setDeckPlaying(2, true);
  // Mixing out of 2 into 1 is the normal case and must stay silent on the deck being loaded.
  assert.equal(loadOverPlayingWarning(1), null);
  assert.ok(loadOverPlayingWarning(2));
});

test('a deck that stops stops warning', () => {
  setDeckPlaying(1, true);
  assert.ok(loadOverPlayingWarning(1));
  setDeckPlaying(1, false);
  assert.equal(loadOverPlayingWarning(1), null);
  assert.equal(isDeckPlaying(1), false);
});
