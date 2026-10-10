import { test, assert, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MixRow } from './MixRow';

afterEach(cleanup);

const row = (extra: Partial<Parameters<typeof MixRow>[0]> = {}) => (
  <MixRow
    deck={1}
    title="Tension"
    sub="Pepe Arcade"
    remain={310}
    playing
    bpm={128.56}
    waveform={<div data-testid="wave" />}
    {...extra}
  />
);

/* On the A+B page the row is the obvious thing to press to go and look at that deck, and a phone
 * wants the whole row rather than just the letter. */
test('pressing a row opens that deck', () => {
  let opened = 0;
  render(row({ onOpen: () => { opened += 1; } }));

  fireEvent.click(screen.getByRole('button', { name: /open deck a/i }));
  assert.equal(opened, 1);
});

test('deck B says B, so the two rows are not both "open deck A"', () => {
  render(row({ deck: 2, onOpen: () => {} }));
  assert.ok(screen.getByRole('button', { name: /open deck b/i }));
});

/* The waveform and the readout must stay INSIDE the control, or half the row is dead to a finger. */
test('the whole row is the target, not just the letter', () => {
  render(row({ onOpen: () => {} }));
  const button = screen.getByRole('button', { name: /open deck a/i });

  assert.ok(button.contains(screen.getByTestId('wave')), 'the waveform is inside the button');
  assert.ok(button.textContent?.includes('Tension'), 'and so is the title');
});

/* Used anywhere without a handler it has to stay exactly as inert as it was. */
test('without a handler there is no button at all', () => {
  render(row());

  assert.equal(screen.queryByRole('button'), null);
  assert.ok(screen.getByText('Tension'), 'the row still renders its content');
});
