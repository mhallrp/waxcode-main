import { test, assert, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PinScreen } from './PinScreen';

/*
 * The gate the owner sees when they have turned a PIN on. The box refuses the requests either way -
 * this screen exists so the refusal is something answerable rather than a broken-looking app.
 */

let reply: Record<string, unknown>;
let sent: string[];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  reply = { ok: true };
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)).pin);
    return { ok: true, json: async () => reply };
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

/* fireEvent, not a hand-rolled Event - a raw DOM event does not reach React's synthetic handler, so
 * the state never changes and every assertion here fails for the wrong reason. */
function type(value: string) {
  const field = screen.getByLabelText('Connection PIN') as HTMLInputElement;
  fireEvent.change(field, { target: { value } });
  return field;
}

test('Unlock stays disabled until four digits are in', () => {
  render(<PinScreen onUnlocked={() => {}} />);
  const button = screen.getByRole('button', { name: 'Unlock' });
  assert.equal((button as HTMLButtonElement).disabled, true);

  type('12');
  assert.equal((button as HTMLButtonElement).disabled, true, 'two is not enough');

  type('1234');
  assert.equal((button as HTMLButtonElement).disabled, false);
});

test('letters never make it into the field', () => {
  render(<PinScreen onUnlocked={() => {}} />);
  /* Stripped as typed rather than refused on submit: a field that accepts letters and then rejects
   * them is a worse way to learn the rule than one that never takes them. */
  assert.equal(type('1a2b').value, '12');
  assert.equal(type('abcd').value, '');
});

test('a correct PIN reports back so the app can show itself', async () => {
  let unlocked = false;
  render(<PinScreen onUnlocked={() => { unlocked = true; }} />);
  type('1234');
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

  await waitFor(() => assert.equal(unlocked, true));
  assert.deepEqual(sent, ['1234']);
});

test('a wrong PIN says so and does not let anyone through', async () => {
  reply = { ok: false, reason: 'wrong-pin' };
  let unlocked = false;
  render(<PinScreen onUnlocked={() => { unlocked = true; }} />);
  type('9999');
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

  assert.ok(await screen.findByText('Wrong PIN.'));
  assert.equal(unlocked, false);
});

test('being throttled says how long to wait, in seconds', async () => {
  reply = { ok: false, reason: 'too-many-attempts', retryInMs: 30_000 };
  render(<PinScreen onUnlocked={() => {}} />);
  type('9999');
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

  /* Told as a number rather than a countdown: it only means "not now", and a ticking clock invites
   * staring at it. */
  assert.ok(await screen.findByText(/Try again in 30s/));
});
