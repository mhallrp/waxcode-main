import { test, assert, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { loadedFromBoxName, useSetupHandoff } from './useSetupHandoff';

/*
 * The box leaving its own network and reappearing on the owner's, which is the one moment this app
 * cannot ask the box about - it is the box that goes away. Every assertion here is about ORDER.
 */

function Reader({ address, lanIp = null }: { address: string; lanIp?: string | null }) {
  const { phase, target } = useSetupHandoff(address, lanIp, true);
  return <span>{`phase:${phase} target:${target ?? '-'}`}</span>;
}

/** Each entry answers one beat: an object is a reply, `null` is the box not being there. */
function answering(replies: (object | null)[]) {
  let i = 0;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const reply = replies[Math.min(i, replies.length - 1)];
    i += 1;
    if (reply === null) throw new TypeError(`unreachable: ${url}${init?.mode ? ` (${init.mode})` : ''}`);
    return { ok: true, status: 200, json: async () => reply };
  });
}

/** jsdom serves from localhost, so that is the name a page "loaded from the box" was loaded from. */
const OWN_NAME = 'localhost';
const OTHER_NAME = 'somebox.local';

const beats = (n: number) => act(async () => { await vi.advanceTimersByTimeAsync(2000 * n); });
/** The hook beats once on mount, before any interval fires, so that one is flushed on its own. */
const mounted = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/* The box is perfectly reachable while the phone is still on its AP, and reloading then would land
 * the page on a network seconds from disappearing. Here the box says which network it answered on,
 * which is the first of the two things stopping that. */
test('a box that never goes away never triggers the handoff', async () => {
  vi.stubGlobal('fetch', answering([{ version: 'v1', onSetupNetwork: true }]));
  render(<Reader address={OWN_NAME} />);
  await mounted();
  assert.ok(screen.getByText(/phase:waiting/));
  await beats(20);
  assert.ok(screen.getByText(/phase:waiting/), 'still waiting after forty seconds of a healthy AP');
});

/* The full handoff. Going away is the proof the join worked, so it is a state of its own and not an
 * error - somebody watching this page needs to be told that the box vanishing is the good outcome. */
test('gone, then back, and only in that order', async () => {
  vi.stubGlobal('fetch', answering([
    { version: 'v1', onSetupNetwork: true },   // the AP, still up
    null, null,                                // it drops: two misses, not one
    null,                                      // the phone has not rejoined yet
    { version: 'v1', onSetupNetwork: false },  // the box, on the owner's network
  ]));
  render(<Reader address={OWN_NAME} />);
  await mounted();
  assert.ok(screen.getByText(/phase:waiting/));

  await beats(1);
  assert.ok(screen.getByText(/phase:waiting/), 'one dropped request is not a network change');

  await beats(1);
  assert.ok(screen.getByText(/phase:gone/));

  await beats(1);
  assert.ok(screen.getByText(/phase:gone/), 'and it stays gone until something answers');

  await beats(1);
  assert.ok(screen.getByText(/phase:back/));
});

/* Reachable again is NOT the same question as back on the owner's network. A phone still on the AP
 * reaches the box too, so the box is asked which network the request came in on. */
test('a box answering from its own setup network is not back', async () => {
  vi.stubGlobal('fetch', answering([
    { version: 'v1', onSetupNetwork: true },
    null, null,
    { version: 'v1', onSetupNetwork: true },  // answering, but still over the AP
  ]));
  render(<Reader address={OWN_NAME} />);
  await beats(3);
  assert.ok(screen.getByText(/phase:gone/));
  await beats(5);
  assert.ok(screen.getByText(/phase:gone/), 'answering over the setup network is not the handoff');
});

/*
 * Somebody who typed the IP rather than the name. The page's own address dies with the AP, so there
 * is nothing to reload - it has to be a navigation to the box's name, and the box sends no CORS
 * headers, so the reply cannot be read. Reachability is all there is, and by now it is enough.
 */
test('loaded from the IP, the box is found by an unreadable request to its name', async () => {
  const fetchMock = answering([
    { version: 'v1', onSetupNetwork: true },
    null, null,
    {},
  ]);
  vi.stubGlobal('fetch', fetchMock);
  render(<Reader address={OTHER_NAME} />);
  await beats(4);
  assert.ok(screen.getByText(/phase:back/));

  const last = fetchMock.mock.calls.at(-1);
  assert.equal(last?.[0], `http://${OTHER_NAME}/version`, 'the box by name, not this dead origin');
  assert.equal(last?.[1]?.mode, 'no-cors', 'which is what makes a cross-origin read legal');
});

/* A phone that does not rejoin a network by itself leaves nothing to follow. Saying so is the point
 * - the alternative is a page that spins for ever while somebody waits for it. */
test('a phone that never rejoins is told to do it itself', async () => {
  vi.stubGlobal('fetch', answering([{ version: 'v1', onSetupNetwork: true }, null]));
  render(<Reader address={OWN_NAME} />);
  await beats(3);
  assert.ok(screen.getByText(/phase:gone/));
  await beats(46);
  assert.ok(screen.getByText(/phase:stalled/), 'after ninety seconds of nothing');
});

/*
 * And the second, which is the one that carries the weight. A box too old to report which network
 * it answered on says nothing either way - so without waiting for the AP to go away first, the only
 * reading left is "reachable", and the page would reload while still on the setup network.
 */
test('an old box that cannot say which network it is on waits for the AP to drop', async () => {
  vi.stubGlobal('fetch', answering([{ version: 'v0.9.1' }]));
  render(<Reader address={OWN_NAME} />);
  await mounted();
  await beats(20);
  assert.ok(screen.getByText(/phase:waiting/), 'silence is not an answer, and the AP is still up');
});

/*
 * The case with no readable signal at all, where ordering is the ONLY protection. Loaded from the
 * IP, the box can only be probed unreadably by name - and while the setup network is up, that name
 * resolves to the box anyway, because its dnsmasq answers every name with itself. So the probe
 * succeeds from the first beat, and nothing but "has the AP gone yet" can tell the difference.
 */
test('loaded from the IP, a name that already resolves on the setup network is not back', async () => {
  vi.stubGlobal('fetch', answering([{}]));
  render(<Reader address={OTHER_NAME} />);
  await mounted();
  await beats(20);
  assert.ok(screen.getByText(/phase:waiting/), 'reachable by name is not the same as off the AP');
});

/* Which of the two endings applies. Case-insensitively, because a hostname is, and nothing
 * guarantees the box reports it the way somebody typed it. */
test('whether the page was loaded from the box\'s own name ignores case', () => {
  assert.equal(loadedFromBoxName(OWN_NAME), true);
  assert.equal(loadedFromBoxName(OWN_NAME.toUpperCase()), true);
  assert.equal(loadedFromBoxName(OTHER_NAME), false);
});

/*
 * THE ONE A REAL PHONE FOUND, 2026-10-11.
 *
 * The owner joined their wifi through setup, the box landed on their network and answered
 * perfectly - and `waxcodedvs.local` loaded nothing on the phone. The phone had resolved that name
 * while it was on the setup network, so it was still holding 10.42.0.1 for it, and that address
 * stops existing the moment the box leaves. The name fails for a box that is sitting right there.
 *
 * Which is why the join reply is worth reading: it carries the box's address on the network it has
 * just joined, read after the join and delivered moments before the setup network drops. An IP
 * needs no resolver and cannot go stale this way.
 */
test('a poisoned name falls back to the address the join reported', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    // The name is the stale one: it resolves, to nothing that answers.
    if (String(url).includes(OWN_NAME)) throw new TypeError('unreachable');
    if (String(url).includes('192.168.1.87')) return { ok: true, status: 200, json: async () => ({}) };
    // The first phase polls the page's own origin, which dies with the setup network.
    throw new TypeError('gone');
  });
  vi.stubGlobal('fetch', fetchMock);

  render(<Reader address={OTHER_NAME} lanIp="192.168.1.87" />);
  await mounted();
  await beats(3);

  assert.ok(screen.getByText(/phase:back/), 'found by address');
  assert.ok(screen.getByText(/target:http:\/\/192\.168\.1\.87\//), 'and sent there, not to the name');
});

/* The name is still preferred when it works: it survives the box changing address, and it is what
 * somebody would type again tomorrow. The IP is the rescue, not the default. */
test('the name wins when it answers', async () => {
  vi.stubGlobal('fetch', answering([
    { version: 'v1', onSetupNetwork: true },
    null, null,
    { version: 'v1', onSetupNetwork: false },
  ]));
  render(<Reader address={OWN_NAME} lanIp="192.168.1.87" />);
  await mounted();
  await beats(3);

  assert.ok(screen.getByText(`phase:back target:http://${OWN_NAME}/`), 'the name, not the address');
});
