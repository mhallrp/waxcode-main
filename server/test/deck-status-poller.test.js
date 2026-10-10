import { test } from 'node:test';
/* `at` is the box's clock at the moment the status was parsed - see the poller. It cannot be
 * asserted against a literal, and one test below checks it is there and sane. */
const withoutReadTime = (status) => {
  if (!status) return status;
  const { at, ...rest } = status;
  return rest;
};
import assert from 'node:assert/strict';
import { createServer as createSocketServer } from 'node:net';
import { DeckStatusPoller } from '../src/deck-status-poller.js';
import { deckSocketPath } from '../src/xwax-status.js';

// net.Server already unlinks its own Unix socket file on close() - no
// manual cleanup needed here.

test('polls STATUS on an interval and fans replies out to subscribers', async () => {
  const path = deckSocketPath(9921); // a deck number no real xwax instance uses
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('STATUS')) {
        socket.write('STATUS PLAYING 187.4 1.000 0 0.000 0 0.000 0.000\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9921);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.deepEqual(withoutReadTime(updates[0]), {
      state: 'PLAYING',
      remain: 187.4,
      pitch: 1.0,
      relative: false,
      cuePoint: 0,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      elapsed: null,
      timecodeValid: null,
      unreadableSeconds: null,
      keyLock: null,
      path: null,
    });
  } finally {
    poller.stop();
    server.close();
  }
});

test('lastStatus is null before any reply arrives, then holds the most recent one', async () => {
  const path = deckSocketPath(9928);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS PLAYING 42.5 1.000 0 0.000 0 0.000 0.000\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9928);
  assert.equal(poller.lastStatus, null);

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(withoutReadTime(poller.lastStatus), {
      state: 'PLAYING',
      remain: 42.5,
      pitch: 1.0,
      relative: false,
      cuePoint: 0,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      elapsed: null,
      timecodeValid: null,
      unreadableSeconds: null,
      keyLock: null,
      path: null,
    });
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses the loaded track path when present, and reports null when absent (EMPTY)', async () => {
  const path = deckSocketPath(9926);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS STOPPED 12.0 0.000 0 0.000 0 0.000 0.000 /media/pidvs/sda2/A Band - A Song.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9926);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.deepEqual(withoutReadTime(updates[0]), {
      state: 'STOPPED',
      remain: 12.0,
      pitch: 0.0,
      relative: false,
      cuePoint: 0,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      elapsed: null,
      timecodeValid: null,
      unreadableSeconds: null,
      keyLock: null,
      path: '/media/pidvs/sda2/A Band - A Song.mp3',
    });
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses IMPORTING (a LOAD issued but xwax still decoding it) with its path', async () => {
  const path = deckSocketPath(9927);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS IMPORTING 0.0 0.000 0 0.000 0 0.000 0.000 /media/pidvs/sda2/A Band - A Song.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9927);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.deepEqual(withoutReadTime(updates[0]), {
      state: 'IMPORTING',
      remain: 0.0,
      pitch: 0.0,
      relative: false,
      cuePoint: 0,
      loopActive: false,
      loopStart: 0,
      loopEnd: 0,
      elapsed: null,
      timecodeValid: null,
      unreadableSeconds: null,
      keyLock: null,
      path: '/media/pidvs/sda2/A Band - A Song.mp3',
    });
  } finally {
    poller.stop();
    server.close();
  }
});

// Feeds one STATUS line through a real poller and returns the parsed status.
async function statusFrom(line, deckNumber = 9991) {
  const path = deckSocketPath(deckNumber);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('STATUS')) socket.write(line + '\n');
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(deckNumber);
  const updates = [];
  poller.subscribe((status) => updates.push(status));
  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return updates[0];
  } finally {
    poller.stop();
    server.close();
  }
}

test('parses the elapsed field when a newer xwax sends it, including mid-import', async () => {
  // The point of the field: position is valid while IMPORTING, when remain is not - so a client
  // that knows the duration can show a live readout from the moment the needle drops.
  const importing = await statusFrom('STATUS IMPORTING 0.0 0.000 0 0.000 0 0.000 0.000 12.5000 /media/pidvs/port-1/t.mp3');
  assert.equal(importing.elapsed, 12.5);
  assert.equal(importing.remain, 0);

  const playing = await statusFrom('STATUS PLAYING 42.0000 1.000 0 0.000 0 0.000 0.000 8.2500 /media/pidvs/port-1/t.mp3', 9992);
  assert.equal(playing.elapsed, 8.25);
  assert.equal(playing.path, '/media/pidvs/port-1/t.mp3');
});

test('parses timecodeValid, which says whether anything outside the app can move the deck', async () => {
  const needleDown = await statusFrom('STATUS PLAYING 42.0000 1.000 1 0.000 0 0.000 0.000 8.2500 1 /media/pidvs/port-1/t.mp3', 9994);
  assert.equal(needleDown.timecodeValid, true);

  const needleUp = await statusFrom('STATUS PLAYING 42.0000 1.000 1 0.000 0 0.000 0.000 8.2500 0 /media/pidvs/port-1/t.mp3', 9995);
  assert.equal(needleUp.timecodeValid, false, 'false, not null - the box said so rather than not saying');
  assert.equal(needleUp.path, '/media/pidvs/port-1/t.mp3', 'the path is not mistaken for the new field');
});

test('still parses an xwax that predates the elapsed field - the two deploy separately', async () => {
  const status = await statusFrom('STATUS PLAYING 42.0000 1.000 0 0.000 0 0.000 0.000 /media/pidvs/port-1/t.mp3', 9993);
  assert.equal(status.elapsed, null);
  assert.equal(status.remain, 42);
  assert.equal(status.path, '/media/pidvs/port-1/t.mp3', 'the path is not mistaken for the new field');
});

test('parses a negative pitch (reverse scratch) correctly, not just positive/forward', async () => {
  const path = deckSocketPath(9929);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS PLAYING 60.0 -0.750 0 0.000 0 0.000 0.000 /media/pidvs/sda2/Track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9929);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].pitch, -0.75);
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses relative:true when the deck is in relative mode', async () => {
  const path = deckSocketPath(9930);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS PLAYING 60.0 1.000 1 0.000 0 0.000 0.000 /media/pidvs/sda2/Track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9930);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].relative, true);
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses cuePoint as a real elapsed-seconds value, not just the fixed 0.000 default', async () => {
  const path = deckSocketPath(9946);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS STOPPED 60.0 0.000 1 42.750 0 0.000 0.000 /media/pidvs/sda2/Track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9946);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].cuePoint, 42.75);
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses an active loop range, not just the fixed 0/0.000/0.000 inactive default', async () => {
  const path = deckSocketPath(9948);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS PLAYING 60.0 1.000 1 0.000 1 10.000 15.000 /media/pidvs/sda2/Track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9948);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].loopActive, true);
    assert.equal(updates[0].loopStart, 10);
    assert.equal(updates[0].loopEnd, 15);
  } finally {
    poller.stop();
    server.close();
  }
});

test('an unsubscribed listener stops receiving updates', async () => {
  const path = deckSocketPath(9922);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9922);
  const updates = [];
  const unsubscribe = poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    unsubscribe();
    const countAtUnsubscribe = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(updates.length, countAtUnsubscribe);
  } finally {
    poller.stop();
    server.close();
  }
});

test('reconnects after the connection is dropped from the other end (eg. a LOAD evicting it)', async () => {
  const path = deckSocketPath(9923);
  const server = createSocketServer();
  let connectionCount = 0;
  server.on('connection', (socket) => {
    connectionCount++;
    if (connectionCount === 1) {
      // Simulate control.c's accept_clients() replacing this
      // connection with a fresh one, as happens when a LOAD request
      // arrives while this poller's connection is still open.
      socket.destroy();
      return;
    }
    socket.on('data', () => socket.write('STATUS STOPPED 12.0 0.000 0 0.000 0 0.000 0.000\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9923);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(connectionCount >= 2, `expected a reconnect, only saw ${connectionCount} connection(s)`);
    assert.ok(updates.some((u) => u.state === 'STOPPED'));
  } finally {
    poller.stop();
    server.close();
  }
});

test('ignores malformed or unrecognised lines rather than throwing', async () => {
  const path = deckSocketPath(9924);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write('not a status line\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9924);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(updates.length, 0);
  } finally {
    poller.stop();
    server.close();
  }
});

test('stop() halts polling - no further connections after it is called', async () => {
  const path = deckSocketPath(9925);
  const server = createSocketServer();
  let connectionCount = 0;
  server.on('connection', (socket) => {
    connectionCount++;
    socket.on('data', () => socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9925);

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    poller.stop();
    const countAtStop = connectionCount;
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(connectionCount, countAtStop);
  } finally {
    server.close();
  }
});

test('requestSignal asks on the poller\'s own connection and parses the reply', async () => {
  const path = deckSocketPath(9931);
  const server = createSocketServer();
  let connections = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        if (line === 'SIGNAL') {
          socket.write('SIGNAL 1073741824 536870912 900000000 4231 17 1 1 8388608\n');
        } else if (line === 'STATUS') {
          socket.write('STATUS PLAYING 12.0 1.000 0 0.000 0 0.000 0.000\n');
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9931);
  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const signal = await poller.requestSignal();
    assert.deepEqual(signal, {
      peakLeft: 1073741824,
      peakRight: 536870912,
      refLevel: 900000000,
      validCounter: 4231,
      ticker: 17,
      forwards: true,
      safe: true,
      threshold: 8388608,
      sensitivity: null,
    });
    // The point of sending over the existing socket: xwax accepts one control client per deck, so
    // a second connection would have evicted the poller and stalled every deck readout.
    assert.equal(connections, 1);
  } finally {
    poller.stop();
    server.close();
  }
});

test('requestSignal rejects rather than hanging when the deck is not connected', async () => {
  const poller = new DeckStatusPoller(9932); // never started, nothing listening
  await assert.rejects(() => poller.requestSignal(), /not connected/);
});

test('requestSignal rejects in-flight waiters when the socket closes', async () => {
  const path = deckSocketPath(9933);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    // Answers STATUS but deliberately never answers SIGNAL, then drops.
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('STATUS')) {
        socket.write('STATUS STOPPED 0.0 0.000 0 0.000 0 0.000 0.000\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9933);
  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const pending = poller.requestSignal();
    poller.stop();
    await assert.rejects(() => pending, /stopped|closed/);
  } finally {
    server.close();
  }
});

test('requestSignal parses a reply from an xwax that predates the threshold field', async () => {
  const path = deckSocketPath(9934);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        if (line === 'SIGNAL') socket.write('SIGNAL 100 200 300 4 5 0 0\n');
        else if (line === 'STATUS') socket.write('STATUS STOPPED 0.0 0.000 0 0.000 0 0.000 0.000\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9934);
  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const signal = await poller.requestSignal();
    assert.equal(signal.threshold, null);
    assert.equal(signal.forwards, false);
  } finally {
    poller.stop();
    server.close();
  }
});

test('requestSignal parses the sensitivity level when xwax reports it', async () => {
  const path = deckSocketPath(9935);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        if (line === 'SIGNAL') socket.write('SIGNAL 100 200 300 4 5 1 1 8388608 2\n');
        else if (line === 'STATUS') socket.write('STATUS STOPPED 0.0 0.000 0 0.000 0 0.000 0.000\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9935);
  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const signal = await poller.requestSignal();
    assert.equal(signal.sensitivity, 2);
    assert.equal(signal.threshold, 8388608);
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses unreadableSeconds - a turning platter whose position will not decode', async () => {
  // The signature of a mismatched timecode SIDE: the sine carrier gives a good pitch, the
  // side-specific code sequence never decodes, and the deck plays silence while still reporting
  // PLAYING. See the fork's player.h.
  const path = deckSocketPath(9965);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write(
      'STATUS PLAYING 187.4000 0.998 0 0.000 0 0.000 0.000 12.3456 0 4.2 /media/pidvs/sda2/track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9965);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.ok(updates.length >= 1);
    assert.equal(updates[0].unreadableSeconds, 4.2);
    assert.equal(updates[0].timecodeValid, false);
    // The path must still land in the right group now that a field sits in front of it.
    assert.equal(updates[0].path, '/media/pidvs/sda2/track.mp3');
  } finally {
    poller.stop();
    server.close();
  }
});

test('unreadableSeconds is 0 while a deck is tracking normally', async () => {
  const path = deckSocketPath(9966);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', () => socket.write(
      'STATUS PLAYING 187.4000 0.998 0 0.000 0 0.000 0.000 12.3456 1 0.0 /media/pidvs/sda2/track.mp3\n'));
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9966);
  const updates = [];
  poller.subscribe((status) => updates.push(status));

  try {
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(updates[0].unreadableSeconds, 0);
    assert.equal(updates[0].timecodeValid, true);
  } finally {
    poller.stop();
    server.close();
  }
});

test('parses keyLock, so the app reads it back rather than assuming what it last sent', async () => {
  const on = await statusFrom('STATUS PLAYING 42.0000 1.000 0 0.000 0 0.000 0.000 5.0000 1 0.0 1 /media/pidvs/port-1/t.mp3', 9971);
  assert.equal(on.keyLock, true);
  assert.equal(on.path, '/media/pidvs/port-1/t.mp3', 'the path must not be swallowed by the new field');

  const off = await statusFrom('STATUS PLAYING 42.0000 1.000 0 0.000 0 0.000 0.000 5.0000 1 0.0 0 /media/pidvs/port-1/t.mp3', 9972);
  assert.equal(off.keyLock, false);
});

test('keyLock is null - not false - from an xwax that predates the field', async () => {
  // "Unknown" and "off" are different: a client must not draw a key lock button as off just
  // because it is talking to an older engine.
  const status = await statusFrom('STATUS PLAYING 42.0000 1.000 0 0.000 0 0.000 0.000 5.0000 1 0.0 /media/pidvs/port-1/t.mp3', 9973);
  assert.equal(status.keyLock, null);
  assert.equal(status.unreadableSeconds, 0, 'the older trailing field must still land in its own slot');
  assert.equal(status.path, '/media/pidvs/port-1/t.mp3');
});

test('parses keyLock on an EMPTY deck, which now carries the same fields in the same order', async () => {
  const status = await statusFrom('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000 0.000 0 0.0 1', 9974);
  assert.equal(status.state, 'EMPTY');
  assert.equal(status.keyLock, true, 'key lock is armable before anything is loaded, like relative mode');
  assert.equal(status.path, null);
});

test('markStopped clears the cache and tells subscribers the deck is empty', async () => {
  // The bug it fixes: status is notify-only, so when passthrough stops a deck's xwax the stream
  // goes quiet rather than saying the deck emptied - and the app kept showing a track that had
  // genuinely been unloaded (owner-reported 2026-09-19). Being starved of updates and being told
  // "empty" look identical to a client; only the second one is the truth.
  const path = deckSocketPath(9975);
  const server = createSocketServer();
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      if (chunk.toString().includes('STATUS')) {
        socket.write('STATUS PLAYING 42.0 1.000 0 0.000 0 0.000 0.000 5.0 1 0.0 0 /media/pidvs/port-1/t.mp3\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  const poller = new DeckStatusPoller(9975);
  const seen = [];
  poller.subscribe((status) => seen.push(status));
  poller.start();

  await new Promise((resolve) => {
    const wait = setInterval(() => {
      if (poller.lastStatus?.path) { clearInterval(wait); resolve(); }
    }, 10);
  });
  assert.equal(poller.lastStatus.path, '/media/pidvs/port-1/t.mp3', 'precondition: a track is loaded');

  poller.markStopped();

  assert.equal(poller.lastStatus, null, 'the cached status must not outlive the deck it described');
  const last = seen.at(-1);
  assert.equal(last.state, 'EMPTY');
  assert.equal(last.path, null, 'a client reconciling against this must see no track');
  assert.equal(last.keyLock, null, 'unknown, not false - the process that would report it is gone');

  poller.stop();
  await new Promise((resolve) => server.close(resolve));
});
