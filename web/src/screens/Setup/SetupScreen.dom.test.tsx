import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SetupScreen } from './SetupScreen';

/*
 * The first thing anybody sees of this box. What it must NOT do is hand somebody the deck screen
 * when they are trying to get onto their wifi - which is what the portal did before.
 */

const NETWORK = {
  connection: '', ip: '', ap: 'yes', serial: '0000beef', name: null,
  networks: [{ ssid: 'Waxcode Setup 46D4', signal: 99, secure: false }], saved: [],
  apPassword: 'x'.repeat(10), apOpen: false, bootstrapped: 'yes',
};

beforeEach(() => {
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => NETWORK })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

test('on the setup network it offers the two things somebody has to decide between', async () => {
  render(<SetupScreen onSkip={() => {}} required />);
  await settle();
  assert.ok(screen.getByText('Connect to Wi-Fi'));
  assert.ok(screen.getByText('Use without Wi-Fi'));
});

/* The box builds this name from the last four of its serial, and somebody choosing to stay on the
 * setup network needs to know what to look for in their wifi list. */
test('the box’s own network is named, derived from the serial', async () => {
  render(<SetupScreen onSkip={() => {}} required />);
  await settle();
  await act(async () => { screen.getByText('Use without Wi-Fi').click(); });
  assert.ok(screen.getByText('Waxcode Setup BEEF'), 'the last four, upper-cased');
});

/* It cannot show the box becoming secure - joining a network takes down the setup network this page
 * is being served over. So it has to say where the box will be instead. */
test('staying on the setup network explains the cost rather than hiding it', async () => {
  render(<SetupScreen onSkip={() => {}} required />);
  await settle();
  await act(async () => { screen.getByText('Use without Wi-Fi').click(); });
  assert.match(document.body.textContent ?? '', /screen will dim on its own/i);
  assert.match(document.body.textContent ?? '', /Auto-Lock/i);
  /* It says nothing about the phone's own internet either way. iOS sometimes routes around a
   * network with none and sometimes does not, depending on how the captive prompt was answered -
   * and a screen that states either as fact will be wrong for somebody. */
  assert.notMatch(document.body.textContent ?? '', /mobile data|no internet while/i);
});

/*
 * Two different arrivals, and they must not behave the same.
 *
 * On the box's OWN network this is first-time setup: the two choices are the whole decision and
 * nothing is offered past them. "Skip" was never a third choice, it was a way of not reading either -
 * and a box that never joins a network gets no name, no certificate, no updates, and cannot be
 * activated once licensing lands. "Use without Wi-Fi" already covers anyone who genuinely does not
 * want it, with the costs spelled out.
 *
 * Arriving deliberately on a working box is different: there must be a way back, or somebody who
 * only wanted a look is stuck.
 */
test('on the setup network there is no way past the two choices', async () => {
  render(<SetupScreen onSkip={() => {}} required />);
  await settle();
  assert.equal(screen.queryByText(/go to the decks/i), null);
  /* The real choices are both still there - this removes an escape, not an option. */
  assert.ok(screen.getByText('Connect to Wi-Fi'));
  assert.ok(screen.getByText('Use without Wi-Fi'));
});

/*
 * Reversed deliberately (owner's call, 2026-10-09). The old contract was that a box on a real
 * network offered a way back to the decks and a box on its own AP did not - backwards, because the
 * online box is the one that can actually finish securing itself, and leaving half way is how
 * somebody ends up on plain http with a screen that dims mid-set and no idea why.
 *
 * "Use without Wi-Fi" goes with it: on a network the box has already joined, "keep using the box's
 * own network" is not a choice that exists - it was the same escape hatch wearing a different hat.
 */
test('on a box that is already online there is no way out and nothing to opt out of', async () => {
  let skipped = false;
  render(<SetupScreen onSkip={() => { skipped = true; }} />);
  await settle();
  assert.equal(screen.queryByText('Back to the decks'), null);
  assert.equal(screen.queryByText('Use without Wi-Fi'), null, 'not a choice once the box is on a network');
  assert.ok(screen.getByText('Connect to Wi-Fi'), 'the one thing left to do is still offered');
  assert.equal(skipped, false);
});

/* The setup network is open on purpose now (owner's call, 2026-09-29): it exists only while a
 * cable is in, and physical access is the trust this box already rests on. So nothing
 * stands between arriving here and the two things somebody came to do. */
test('an open setup network is not a gate - the choices come straight away', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ ...NETWORK, apOpen: true, apPassword: null }),
  })));
  render(<SetupScreen onSkip={() => {}} />);
  await settle();
  assert.ok(screen.getByText('Connect to Wi-Fi'));
});

/*
 * The empty tab, which is the whole reason this state exists.
 *
 * A successful join takes down the setup network this page is served over, so the reply never
 * arrives and the tab dies - which to somebody who has just carefully typed their password looks
 * exactly like a crash. So it is said BEFORE the join, while the page is still alive to say it.
 */
test('it says what is about to happen before joining, not after', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    /* A POST is the join, and a SUCCESSFUL one never answers - it takes down the network this page
     * is served over. That silence is exactly the case being tested. */
    if (init?.method === 'POST') return new Promise(() => {});
    return { ok: true, status: 200, json: async () => NETWORK };
  }));

  render(<SetupScreen onSkip={() => {}} />);
  await settle();
  await act(async () => { screen.getByText('Connect to Wi-Fi').click(); });
  await settle();

  // A network name, because the form quite rightly refuses to join nothing.
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/network name/i), { target: { value: 'Home Wi-Fi' } });
  });

  await act(async () => { screen.getByText('Connect').click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /page will go blank/i);
  assert.match(document.body.textContent ?? '', /means it worked/i);
});

/* And the box only being able to see itself is not a bug to hide - it is one radio, busy. */
test('in AP mode it explains why the list is empty and offers typing', async () => {
  render(<SetupScreen onSkip={() => {}} />);
  await settle();
  await act(async () => { screen.getByText('Connect to Wi-Fi').click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /single\s+radio/i);
});
