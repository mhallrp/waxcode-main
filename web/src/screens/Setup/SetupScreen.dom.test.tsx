import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SetupScreen } from './SetupScreen';

/*
 * The first thing anybody sees of this box, and since the captive portal was removed it is reached
 * by typing the box's address rather than by a sheet the OS opens. What it must NOT do is hand
 * somebody the deck screen when they are trying to get onto their wifi.
 */

const NETWORK = {
  connection: '', ip: '', ap: 'yes', serial: '0000beef', name: null,
  networks: [{ ssid: 'Waxcode Setup 46D4', signal: 99, secure: false }], saved: [],
  apPassword: 'x'.repeat(10), apOpen: false, bootstrapped: 'yes',
  /* Deliberately NOT the name this box happens to have. The address is the box's answer, and a test
   * using the real one could not tell a lookup from a string baked into the screen. */
  address: 'somebox.local',
};

beforeEach(() => {
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => NETWORK })));
});
afterEach(() => { vi.unstubAllGlobals(); });

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

/*
 * ONE thing to do, and no way past it (owner's call, 2026-10-11).
 *
 * "Use without Wi-Fi" used to sit here as an equal choice, and read as the easier one - but a box
 * that never joins a network gets no updates and can only ever be reached from a phone sitting on
 * its hotspot. Staying on the box's own network still works; it is simply not offered as a first
 * move. Something subtler can come back later.
 */
test('it offers the one thing a box cannot do for itself, and nothing else', async () => {
  render(<SetupScreen />);
  await settle();
  assert.ok(screen.getByText('Connect to Wi-Fi'));
  assert.equal(screen.queryByText('Use without Wi-Fi'), null, 'not offered as an equal choice');
  assert.equal(screen.queryByText(/go to the decks/i), null, 'and no way past it');
  assert.equal(screen.queryByText(/skip/i), null);
});

/*
 * The escape hatch was reversed deliberately on 2026-10-09 - a box on a real network used to offer
 * a way back to the decks and a box on its own AP did not, which was backwards - and then removed
 * outright on 2026-10-11 along with the choice it was really serving. Leaving half way is how
 * somebody ends up on a hotspot for every set with no idea why.
 */
test('there is no way out, however this screen was reached', async () => {
  render(<SetupScreen />);
  await settle();
  assert.equal(screen.queryByText('Back to the decks'), null);
  assert.equal(screen.queryByText(/go to the decks/i), null);
  assert.ok(screen.getByText('Connect to Wi-Fi'), 'the one thing left to do is still offered');
});

/* The setup network is open on purpose now (owner's call, 2026-09-29): it exists only while a
 * cable is in, and physical access is the trust this box already rests on. So nothing
 * stands between arriving here and the two things somebody came to do. */
test('an open setup network is not a gate - the choices come straight away', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ ...NETWORK, apOpen: true, apPassword: null }),
  })));
  render(<SetupScreen />);
  await settle();
  assert.ok(screen.getByText('Connect to Wi-Fi'));
});

/*
 * The silence, which is the whole reason this state exists.
 *
 * A successful join takes down the setup network this page is served over, so the reply never
 * arrives - which to somebody who has just carefully typed their password looks exactly like a
 * crash. So it is said BEFORE the join, while the page can still reach the box to say it.
 */
test('it says what is about to happen before joining, not after', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    /* A POST is the join, and a SUCCESSFUL one never answers - it takes down the network this page
     * is served over. That silence is exactly the case being tested. */
    if (init?.method === 'POST') return new Promise(() => {});
    return { ok: true, status: 200, json: async () => NETWORK };
  }));

  render(<SetupScreen />);
  await settle();
  await act(async () => { screen.getByText('Connect to Wi-Fi').click(); });
  await settle();

  // A network name, because the form quite rightly refuses to join nothing.
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/network name/i), { target: { value: 'Home Wi-Fi' } });
  });

  await act(async () => { screen.getByText('Connect').click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /stop responding/i);
  assert.match(document.body.textContent ?? '', /means it worked/i);
  /* And the address, every time. The page follows the handoff by itself, but a phone that does not
   * rejoin a network leaves nothing to follow - so the instruction somebody can carry out
   * themselves is never the one taken off the screen. */
  assert.ok(screen.getByText('somebox.local'), 'the way through that never depends on this page');
});

/*
 * The whole handoff, now that nothing opens a page for anybody. The setup network closes, the phone
 * goes back to its own wifi on its own, and the only instruction left is to reload - so the address
 * to reload AT has to be the box's real one. Hardcoding it here would be a lie on every box in the
 * field, which answers to a different name and runs this same release.
 */
test('it names the address the box actually reports, not one baked into the screen', async () => {
  /* A join that never answers, because a successful one takes this page down with the network it
   * was served over - which is the state the address has to be readable in. */
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
    if (init?.method === 'POST') return new Promise(() => {});
    return { ok: true, status: 200, json: async () => NETWORK };
  }));

  render(<SetupScreen />);
  await settle();
  await act(async () => { screen.getByText('Connect to Wi-Fi').click(); });
  await settle();
  await act(async () => {
    fireEvent.change(screen.getByLabelText(/network name/i), { target: { value: 'Home Wi-Fi' } });
  });
  await act(async () => { screen.getByText('Connect').click(); });
  await settle();

  assert.ok(screen.getByText('somebox.local'), 'the box\'s answer');
  assert.equal(screen.queryByText('waxcodedvs.local'), null, 'and not this file\'s idea of it');
});


/* And the box only being able to see itself is not a bug to hide - it is one radio, busy. */
test('in AP mode it explains why the list is empty and offers typing', async () => {
  render(<SetupScreen />);
  await settle();
  await act(async () => { screen.getByText('Connect to Wi-Fi').click(); });
  await settle();
  assert.match(document.body.textContent ?? '', /single\s+radio/i);
});
