import { test, assert, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConnectionPinSection } from './ConnectionPinSection';

/*
 * The gate's own setting. Off is the default and the normal state, so most of what matters here is how
 * it behaves while switched off.
 */

let status: Record<string, unknown>;
let posted: Array<Record<string, unknown>>;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  status = { enabled: false, required: false };
  posted = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      posted.push(body);
      if (body.enabled !== undefined) status = { ...status, enabled: body.enabled };
      return { ok: true, json: async () => ({ ok: true, enabled: status.enabled }) };
    }
    return { ok: true, json: async () => status };
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

const field = () => screen.getByLabelText('New PIN') as HTMLInputElement;
const setButton = () => screen.getByRole('button', { name: 'Set PIN' }) as HTMLButtonElement;

test('while the gate is off, no PIN can be typed or set', async () => {
  render(<ConnectionPinSection />);
  await waitFor(() => assert.ok(screen.getByText(/Turn it on to set a PIN/)));

  /* A PIN that nothing checks is not a setting. Offering to change one would imply it did something. */
  assert.equal(field().disabled, true);
  assert.equal(setButton().disabled, true);
});

test('once on, a PIN can be set', async () => {
  status = { enabled: true, required: false };
  render(<ConnectionPinSection />);
  await waitFor(() => assert.equal(field().disabled, false));

  fireEvent.change(field(), { target: { value: '8271' } });
  assert.equal(setButton().disabled, false);

  fireEvent.click(setButton());
  await waitFor(() => assert.deepEqual(posted.at(-1), { pin: '8271' }));
});

test('it still takes only four digits once enabled', async () => {
  status = { enabled: true, required: false };
  render(<ConnectionPinSection />);
  await waitFor(() => assert.equal(field().disabled, false));

  fireEvent.change(field(), { target: { value: '12ab' } });
  assert.equal(field().value, '12', 'letters never land');
  assert.equal(setButton().disabled, true, 'and two digits is not a PIN');
});

test('the off state says plainly that anyone on the WiFi can control the decks', async () => {
  render(<ConnectionPinSection />);
  /* Worth being blunt about: it is the default, and the consequence is not obvious from the word Off. */
  await waitFor(() => assert.ok(screen.getByText(/Anyone on this WiFi can control the decks/)));
});

test('switching it on tells the box, and opens the PIN field', async () => {
  render(<ConnectionPinSection />);
  await waitFor(() => assert.equal(field().disabled, true));

  fireEvent.click(screen.getByRole('radio', { name: 'On' }));
  await waitFor(() => assert.deepEqual(posted.at(-1), { enabled: true }));
  await waitFor(() => assert.equal(field().disabled, false));
});
