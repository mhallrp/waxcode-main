import { test, assert, afterEach } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

/* Stopping a recording offered "Keep Recording", which reads as keeping the FILE rather than
 * carrying on. The option is gone: clicking away is how you carry on, so that has to work. */
test('anchored, there is no cancel button and clicking outside dismisses', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  let answer: boolean | null = null;

  const { container } = render(
    <ConfirmDialog
      title="Stop recording?" confirm="Stop Recording" cancel={null} anchor={anchor}
      onResolve={(ok) => { answer = ok; }}
    />,
  );

  assert.equal(screen.queryByText('Cancel'), null, 'no cancel button');
  assert.equal(screen.queryByText(/Keep Recording/i), null, 'and certainly not "Keep Recording"');
  assert.ok(screen.getByText('Stop Recording'), 'the only button is the one that acts');

  // No explanatory paragraph: the title and the button already say it.
  assert.equal(container.querySelector('p'), null, 'nothing under the title');

  const backdrop = container.firstElementChild as HTMLElement;
  fireEvent.click(backdrop);
  assert.equal(answer, false, 'a click outside means carry on recording');
});

test('anchored, it is not a modal overlay', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const { container } = render(
    <ConfirmDialog
      title="Stop recording?" confirm="Stop" cancel={null} anchor={anchor}
      onResolve={() => {}}
    />,
  );
  const backdrop = container.firstElementChild as HTMLElement;
  assert.equal(backdrop.getAttribute('aria-modal'), null, 'no aria-modal on the anchored variant');
  assert.ok(screen.getByRole('dialog'), 'still a dialog for assistive tech');
});

test('Escape dismisses, and a centred dialog keeps its cancel button', () => {
  let answer: boolean | null = null;
  render(
    <ConfirmDialog
      title="Replace?" message="This deletes the take." confirm="Replace" destructive
      onResolve={(ok) => { answer = ok; }}
    />,
  );
  assert.ok(screen.getByText('Cancel'), 'the destructive dialog still has an explicit way out');
  fireEvent.keyDown(window, { key: 'Escape' });
  assert.equal(answer, false);
});
