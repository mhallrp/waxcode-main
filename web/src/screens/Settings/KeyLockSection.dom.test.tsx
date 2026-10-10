import { test, assert, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeyLockSection } from './KeyLockSection';

/*
 * Key lock ships as an experiment somebody opts into, because it degrades audio whichever way it is
 * configured and no setting avoids it. What matters here is that it is OFF by default and that the
 * cost is stated specifically - a vague "may affect quality" tells nobody anything.
 */

let state: { enabled: boolean };
let posted: Array<{ enabled: boolean }>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  state = { enabled: false };
  posted = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      state = { enabled: body.enabled };
      return { ok: true, json: async () => ({ ok: true, enabled: state.enabled }) };
    }
    return { ok: true, json: async () => state };
  }) as typeof globalThis.fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; cleanup(); });

test('it is marked experimental and starts off', async () => {
  render(<KeyLockSection />);
  await waitFor(() => assert.ok(screen.getByText(/Experimental/i)));
  const off = screen.getByRole('radio', { name: 'Off' });
  assert.equal(off.getAttribute('aria-checked'), 'true');
});

test('the cost is named, in one line', async () => {
  render(<KeyLockSection />);
  /* Naming kicks and the direction of the damage is what matters. A vague "may affect audio quality"
   * would be ignored - but the reasoning behind it belongs in keylock.c, not on a settings pane. An
   * earlier version of this ran to two paragraphs and was rightly called ridiculous. */
  await waitFor(() => assert.match(document.body.textContent ?? '', /kicks lose punch/i));
  assert.ok((document.body.textContent ?? '').length < 400, 'the whole section stays short');
});

test('turning it on tells the box', async () => {
  render(<KeyLockSection />);
  await waitFor(() => screen.getByRole('radio', { name: 'On' }));
  fireEvent.click(screen.getByRole('radio', { name: 'On' }));
  await waitFor(() => assert.deepEqual(posted.at(-1), { enabled: true }));
});


