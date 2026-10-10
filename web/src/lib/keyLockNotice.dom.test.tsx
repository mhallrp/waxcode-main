import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import {
  acknowledgeKeyLockNotice,
  keyLockNeedsNotice,
  refreshKeyLockNotice,
  resetKeyLockNoticeForTest,
  useKeyLockAvailable,
} from './keyLockNotice';

/*
 * Key lock stopped being an opt-in in Settings on 2026-10-11 and became an ordinary deck control.
 * Two facts replaced the switch, and they are not the same question: what the ENGINE can do, and
 * whether the owner has been told once what it costs.
 */

beforeEach(() => { resetKeyLockNoticeForTest(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const answering = (body: object) => vi.stubGlobal('fetch', vi.fn(async () => ({
  ok: true, status: 200, json: async () => body,
})));

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function Reader({ label }: { label: string }) {
  return <span>{`${label}:${useKeyLockAvailable() ? 'yes' : 'no'}`}</span>;
}

/* One shared store, not one per component - the reason the box-wide flag needed it too. A deck
 * card already mounted has to follow the answer rather than wait for its own poll. */
test('every deck card follows the same answer, and the box is asked once', async () => {
  answering({ available: true, acknowledged: false });
  render(<><Reader label="a" /><Reader label="b" /></>);
  await settle();

  assert.ok(screen.getByText('a:yes'));
  assert.ok(screen.getByText('b:yes'), 'the second card updated without asking again');
  /* Both cards mount in the same commit, so this is one request only because the guard closes when
   * the request STARTS. Guarding on the answer instead let every card fire its own. */
  assert.equal((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length, 1);
});

/* The old switch doubled as an availability check by accident. Without this a box whose xwax
 * predates KEYLOCK shows a button that silently does nothing. */
test('an engine that cannot do key lock offers no button', async () => {
  answering({ available: false, acknowledged: true });
  render(<Reader label="deck" />);
  await act(async () => { await refreshKeyLockNotice(); });
  assert.ok(screen.getByText('deck:no'));
});

test('the notice is needed until it has been acknowledged', async () => {
  answering({ available: true, acknowledged: false });
  await refreshKeyLockNotice();
  assert.equal(keyLockNeedsNotice(), true);

  await acknowledgeKeyLockNotice();
  assert.equal(keyLockNeedsNotice(), false, 'and never again this session');
});

/* A box that has already been told does not ask again on a different device - which is the whole
 * reason this is kept on the box rather than in the browser. */
test('a box that reports it already acknowledged never shows the notice', async () => {
  answering({ available: true, acknowledged: true });
  await refreshKeyLockNotice();
  assert.equal(keyLockNeedsNotice(), false);
});

/*
 * The press must not be swallowed by a box that cannot save the acknowledgement. Showing the
 * notice twice costs a dialog; refusing the press costs the feature.
 */
test('a failed save still lets key lock be turned on', async () => {
  answering({ available: true, acknowledged: false });
  await refreshKeyLockNotice();

  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('box went away'); }));
  await acknowledgeKeyLockNotice();

  assert.equal(keyLockNeedsNotice(), false, 'the press goes through regardless');
});
