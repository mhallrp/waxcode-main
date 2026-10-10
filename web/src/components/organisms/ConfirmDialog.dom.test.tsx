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

  const { baseElement } = render(
    <ConfirmDialog
      title="Stop recording?" confirm="Stop Recording" cancel={null} anchor={anchor}
      onResolve={(ok) => { answer = ok; }}
    />,
  );

  assert.equal(screen.queryByText('Cancel'), null, 'no cancel button');
  assert.equal(screen.queryByText(/Keep Recording/i), null, 'and certainly not "Keep Recording"');
  assert.ok(screen.getByText('Stop Recording'), 'the only button is the one that acts');

  // No explanatory paragraph: the title and the button already say it.
  assert.equal(baseElement.querySelector('p'), null, 'nothing under the title');

  // The dialog sits in body now, so it is reached through the panel rather than the container.
  const backdrop = screen.getByRole('dialog').parentElement as HTMLElement;
  fireEvent.click(backdrop);
  assert.equal(answer, false, 'a click outside means carry on recording');
});

test('anchored, it is not a modal overlay', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  render(
    <ConfirmDialog
      title="Stop recording?" confirm="Stop" cancel={null} anchor={anchor}
      onResolve={() => {}}
    />,
  );
  const panel = screen.getByRole('dialog');
  assert.equal(panel.getAttribute('aria-modal'), null, 'no aria-modal on the anchored variant');
  assert.ok(panel, 'still a dialog for assistive tech');
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

/*
 * The bug this guards: `position: fixed` resolves against the nearest TRANSFORMED ancestor, not the
 * viewport. The deck pages live inside a translated swipe track, so a dialog raised from deck B was
 * laid out over deck B's own page - which by then is translated off-screen. The notice opened every
 * time; it was simply somewhere nobody could see (a real box, 2026-10-18).
 *
 * jsdom does no layout, so the assertion is structural: the dialog must not be a descendant of the
 * thing that carries the transform. That is the property that keeps it on screen in a real browser.
 */
test('the dialog escapes a transformed ancestor instead of being trapped inside it', () => {
  const track = document.createElement('div');
  track.style.transform = 'translateX(-100%)';
  document.body.append(track);

  render(
    <ConfirmDialog title="Experimental feature" confirm="Turn it on" onResolve={() => {}} />,
    { container: document.body.appendChild(track.appendChild(document.createElement('div'))) },
  );

  const panel = screen.getByRole('dialog');
  assert.ok(!track.contains(panel), 'not inside the transformed track');
  assert.equal(panel.parentElement, document.body, 'mounted directly on body');
});
