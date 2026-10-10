import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeckStatusRegistry } from '../src/deck-status-registry.js';

function fakePoller(lastStatus = null) {
  return { lastStatus, start() {}, stop() {} };
}

test('statusPollerFor lazily creates one poller per deck and reuses it on subsequent calls', () => {
  const created = [];
  const registry = createDeckStatusRegistry({
    deckCount: 2,
    createPoller: (deckNumber) => {
      created.push(deckNumber);
      return fakePoller();
    },
  });

  const first = registry.statusPollerFor(1);
  const second = registry.statusPollerFor(1);

  assert.equal(first, second);
  assert.deepEqual(created, [1]);
});

test('statusPollerFor returns null for a deck number outside the configured range', () => {
  const registry = createDeckStatusRegistry({ deckCount: 2, createPoller: () => fakePoller() });
  assert.equal(registry.statusPollerFor(0), null);
  assert.equal(registry.statusPollerFor(3), null);
});

test('anyDeckPlaying is false when no poller has ever been created', () => {
  const registry = createDeckStatusRegistry({ deckCount: 2, createPoller: () => fakePoller() });
  assert.equal(registry.anyDeckPlaying(), false);
});

test('anyDeckPlaying is false when every known deck is stopped/empty', () => {
  const registry = createDeckStatusRegistry({
    deckCount: 2,
    createPoller: () => fakePoller({ state: 'STOPPED', remain: 0, path: '/track.mp3' }),
  });
  registry.statusPollerFor(1);
  registry.statusPollerFor(2);
  assert.equal(registry.anyDeckPlaying(), false);
});

test('anyDeckPlaying is true as soon as any known deck is PLAYING', () => {
  let call = 0;
  const registry = createDeckStatusRegistry({
    deckCount: 2,
    createPoller: () => {
      call += 1;
      return call === 1
        ? fakePoller({ state: 'STOPPED', remain: 0, path: '/track.mp3' })
        : fakePoller({ state: 'PLAYING', remain: 120, path: '/other.mp3' });
    },
  });
  registry.statusPollerFor(1);
  registry.statusPollerFor(2);
  assert.equal(registry.anyDeckPlaying(), true);
});

test('stopAll stops every poller that has been created', () => {
  const stopped = [];
  const registry = createDeckStatusRegistry({
    deckCount: 2,
    createPoller: (deckNumber) => ({ ...fakePoller(), stop: () => stopped.push(deckNumber) }),
  });
  registry.statusPollerFor(1);
  registry.statusPollerFor(2);
  registry.stopAll();
  assert.deepEqual(stopped.sort(), [1, 2]);
});
