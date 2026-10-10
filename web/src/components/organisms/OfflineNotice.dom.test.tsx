import { test, assert, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { OfflineNotice } from './OfflineNotice';

/*
 * The way out of an unreachable box.
 *
 * The case this is for: the box changed network, DNS still points at where it used to be for up to
 * ten minutes, and the secure address times out. waxcodedvs.local is mDNS and needs no DNS server, so
 * it is the one address that still works - but only worth offering from the origin that has the
 * problem.
 */

afterEach(cleanup);

function at(protocol: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, protocol },
    writable: true,
    configurable: true,
  });
}

test('it always says what has happened, and that nothing was lost', () => {
  at('https:');
  render(<OfflineNotice />);
  assert.ok(screen.getByText(/Can't reach the box/));
  assert.ok(screen.getByText(/decks keep playing/));
});


test('from http it offers nothing, because there is nothing better to offer', () => {
  at('http:');
  render(<OfflineNotice />);

  /* Already on the address that does not depend on DNS. A link to where you already are is noise. */
  assert.equal(screen.queryByRole('link'), null);
});

test('it does not grow a retry button', () => {
  at('https:');
  render(<OfflineNotice />);
  /* It is already retrying every few seconds. A button that does what is happening anyway invites
   * someone to stand there pressing it - the original reasoning, kept deliberately. */
  assert.equal(screen.queryByRole('button'), null);
});
