import { test, assert, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { UpdateBanner } from './UpdateBanner';

/*
 * The banner replaced an automatic installer on purpose, so what matters is that it NEVER installs by
 * itself: it carries news, and the person reading it picks the moment.
 */

let notice: Record<string, unknown>;
let dismissed: string[];
let applied: number;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  notice = { waiting: true, checked: true, version: 'v0.10.11', running: 'v0.10.10' };
  dismissed = [];
  applied = 0;
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/update/notice')) {
      if (init?.method === 'POST') {
        dismissed.push(JSON.parse(String(init.body)).version);
        notice = { ...notice, waiting: false, dismissed: true };
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return { ok: true, json: async () => notice };
    }
    if (path.endsWith('/update')) {
      applied += 1;
      return { ok: true, json: async () => ({ ok: true, applying: 'v0.10.11' }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  cleanup();
});

test('it says which version is waiting, and which this box is on', async () => {
  render(<UpdateBanner />);
  assert.ok(await screen.findByText(/v0\.10\.11/), 'the waiting version');
  assert.ok(await screen.findByText(/is available/));
  assert.ok(await screen.findByText(/v0\.10\.10/), 'and what it is replacing');
});

test('it installs NOTHING on its own', async () => {
  render(<UpdateBanner />);
  await screen.findByText(/is available/);
  // Rendering the news must never be the same thing as acting on it.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(applied, 0);
});

test('Later dismisses it, naming the version so a newer one still gets through', async () => {
  render(<UpdateBanner />);
  const later = await screen.findByRole('button', { name: 'Later' });
  later.click();

  await waitFor(() => assert.deepEqual(dismissed, ['v0.10.11']));
  /* Per version, not a blanket mute: the box decides whether a later release breaks the silence, and
   * it needs to know what was waved away to do that. */
  await waitFor(() => assert.equal(screen.queryByText(/is available/), null));
});

test('Install asks first, because it stops the decks', async () => {
  render(<UpdateBanner />);
  const install = await screen.findByRole('button', { name: 'Install' });
  install.click();

  // A confirm, not a silent install - the cost is the decks stopping for minutes.
  assert.ok(await screen.findByText(/Install v0\.10\.11\?/));
  assert.ok(await screen.findByText(/decks will stop/));
  assert.equal(applied, 0, 'nothing has been applied while the question is open');
});

test('confirming starts the update once, and hands over to the update screen', async () => {
  localStorage.clear();
  const started: string[] = [];
  window.addEventListener('waxcode:update-started', (e) => started.push((e as CustomEvent).detail.target));

  render(<UpdateBanner />);
  (await screen.findByRole('button', { name: 'Install' })).click();

  /* Scoped to the DIALOG. Both the banner and the confirm have a button reading "Install", so an
   * unscoped query re-clicked the banner and the confirm was never answered. */
  const dialog = await screen.findByRole('dialog');
  within(dialog).getByRole('button', { name: 'Install' }).click();

  await waitFor(() => assert.equal(applied, 1));

  /*
   * The banner must NOT claim anything itself any more. It used to render "Installing..." and reload
   * the page a few seconds later - but the box keeps answering for several seconds after accepting,
   * so the reload happened before the update began, lost the state, and offered the same update
   * again. The owner pressed it three times on 2026-10-08 while the box refused each one.
   *
   * Now it raises the update screen, which survives the reload because its watch is persisted.
   */
  await waitFor(() => assert.deepEqual(started, ['v0.10.11']));
  assert.ok(localStorage.getItem('waxcode.update'), 'the watch must survive a reload');
  assert.equal(screen.queryByText(/Installing/), null, 'the banner says nothing about progress');
});

test('nothing is shown before the box has checked', async () => {
  notice = { waiting: false, checked: false, version: null, running: null };
  render(<UpdateBanner />);
  await new Promise((resolve) => setTimeout(resolve, 60));
  // A banner on a guess is worse than one a second late.
  assert.equal(screen.queryByText(/is available/), null);
});

test('an up-to-date box shows nothing at all', async () => {
  notice = { waiting: false, checked: true, version: null, running: 'v0.10.11' };
  render(<UpdateBanner />);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(screen.queryByText(/is available/), null);
  assert.equal(screen.queryByRole('button', { name: 'Install' }), null);
});

test('it floats rather than taking a row, and sits under anything deliberately opened', async () => {
  render(<UpdateBanner />);
  const text = await screen.findByText(/is available/);
  const bar = text.closest('div');
  const style = bar ? getComputedStyle(bar) : null;

  /* A row of its own pushed the decks off the bottom of a landscape phone, whose layout is a fixed
   * height - a hard failure, where covering part of the top bar is soft and dismissible. */
  assert.equal(style?.position, 'fixed');

  /* And the layer matters: above deck content, BELOW the settings sheet (10), menus (20/40), its own
   * confirm (50) and the setup screens (100+). A notification must not outrank what someone opened. */
  const z = Number(style?.zIndex);
  assert.ok(z > 5 && z < 10, `expected a layer between content and the sheets, got ${style?.zIndex}`);
});
