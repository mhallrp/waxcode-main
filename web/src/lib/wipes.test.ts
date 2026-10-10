import { test, assert } from 'vitest';
import { toolbarWipes } from './wipes';

/* At rest on each page, every pip must be fully one colour - a wipe caught half way at rest would
 * look like a rendering fault rather than a transition. */
test('resting on Deck A leaves its pip fully in deck A colour', () => {
  const w = toolbarWipes(0);
  assert.equal(w.deckA.wipe, 0, 'nothing wiped away yet');
  assert.equal(w.deckA.before, 'var(--deck-a)');
  assert.equal(w.deckB.wipe, 0);
  assert.equal(w.mix.wipe, 0);
});

test('resting on Deck B leaves A faint and B in its own colour', () => {
  const w = toolbarWipes(1);
  assert.equal(w.deckA.wipe, 1, 'deck A has fully wiped to faint');
  assert.equal(w.deckB.wipe, 1);
  assert.equal(w.deckB.after, 'var(--deck-b)');
});

test('resting on A+B leaves the mix pip in neutral ink, not a deck colour', () => {
  const w = toolbarWipes(2);
  assert.equal(w.mix.wipe, 1);
  assert.equal(w.mix.after, 'var(--ink)');
});

/*
 * The handoff between the two DECK pips must not move while travelling to A+B - `progress` sticks at
 * 1 for that whole run, so the third page existing does not disturb the first two.
 */
test('travelling from B to A+B does not disturb the A-to-B handoff', () => {
  assert.equal(toolbarWipes(1).deckA.wipe, 1);
  assert.equal(toolbarWipes(1.5).deckA.wipe, 1);
  assert.equal(toolbarWipes(2).deckA.wipe, 1);
});

/* Deck B swaps its colour PAIR over rather than running its progress backwards: every wipe must rise
 * left to right, and a falling one plays the reveal in reverse. */
test('deck B swaps its colours over rather than reversing its wipe', () => {
  const towardsB = toolbarWipes(0.5);
  assert.equal(towardsB.deckB.before, 'var(--ink-faint)');
  assert.equal(towardsB.deckB.after, 'var(--deck-b)');

  const leavingB = toolbarWipes(1.5);
  assert.equal(leavingB.deckB.before, 'var(--deck-b)', 'pair swapped');
  assert.equal(leavingB.deckB.after, 'var(--ink-faint)');
  assert.ok(leavingB.deckB.wipe > 0 && leavingB.deckB.wipe < 1, 'and still rising');
});

/* The side picker can only ever set ONE deck's side, so on the page showing both it goes inert. */
test('the timecode picker fades out and stops being tappable on A+B', () => {
  assert.equal(toolbarWipes(1).timecodeOpacity, 1);
  assert.equal(toolbarWipes(1).timecodeDisabled, false);
  assert.equal(toolbarWipes(2).timecodeOpacity, 0);
  assert.equal(toolbarWipes(2).timecodeDisabled, true);
});

test('a position beyond either end is clamped rather than overshooting a colour', () => {
  assert.equal(toolbarWipes(-1).deckA.wipe, 0);
  assert.equal(toolbarWipes(5).mix.wipe, 1);
});
