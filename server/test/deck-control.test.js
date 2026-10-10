import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createSocketServer } from 'node:net';
import {
  loadTrack, unloadTrack, setRelativeMode, setKeyLock, seek, relocate, setCue, gotoCue, playCue, play, pause, setLoop, clearLoop,
} from '../src/deck-control.js';
import { deckSocketPath } from '../src/xwax-status.js';

// net.Server already unlinks its own Unix socket file on close() - no
// manual cleanup needed here.

test('loadTrack sends a LOAD line with the given path to the deck socket', async () => {
  const path = deckSocketPath(9911); // a deck number no real xwax instance uses
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    // The fake server above is already listening at this deck's
    // socket path, so the default ensureDeckRunning() readiness check
    // succeeds on its own without a systemctl call ever being
    // attempted - this deliberately exercises the real default path,
    // not an injected one.
    await loadTrack(9911, '/media/pidvs/sda2/Music/track.mp3');
    // The socket write is async from the server's perspective - give
    // the 'data' event a moment to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'LOAD /media/pidvs/sda2/Music/track.mp3\n');
  } finally {
    server.close();
  }
});

test('loadTrack rejects when the deck socket connection itself fails, even once the deck is ready', async () => {
  // isReady injected as always-true so this exercises the LOAD
  // connection failure specifically, independent of
  // ensureDeckRunning's own logic (covered in xwax-lifecycle.test.js)
  // - without it, this would otherwise fall through to a real
  // systemctl call, which a unit test must never do. retryAttempts/
  // retryDelayMs kept small so this doesn't pay the real retry delay -
  // nothing is listening on 9912 at all, so every attempt fails the
  // same way regardless of how many are tried.
  await assert.rejects(() => loadTrack(9912, '/some/track.mp3', { isReady: async () => true, retryAttempts: 2, retryDelayMs: 5 }));
});

test('loadTrack retries the LOAD connection after a transient failure, then succeeds', async () => {
  // Nothing listens on this socket path for the first ~40ms - mirrors
  // the real-hardware finding (xwax's control socket transiently
  // refusing a connection, eg. EAGAIN, while busy with its own
  // real-time thread) without depending on flaky mid-connection
  // destroy() semantics: the connection is genuinely unavailable
  // briefly, then genuinely becomes available.
  const path = deckSocketPath(9917);
  let received = '';
  let server;
  const startTimer = setTimeout(() => {
    server = createSocketServer();
    server.on('connection', (socket) => {
      socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
    });
    server.listen(path);
  }, 40);

  try {
    await loadTrack(9917, '/track.mp3', { isReady: async () => true, retryAttempts: 10, retryDelayMs: 15 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'LOAD /track.mp3\n');
  } finally {
    clearTimeout(startTimer);
    server?.close();
  }
});

test('loadTrack calls ensureDeckRunning (via the injected isReady) before sending LOAD', async () => {
  const path = deckSocketPath(9915);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  let checkedDeckNumber = null;
  const isReady = async (deckNumber) => {
    checkedDeckNumber = deckNumber;
    return true;
  };

  try {
    await loadTrack(9915, '/track.mp3', { isReady });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(checkedDeckNumber, 9915);
    assert.equal(received, 'LOAD /track.mp3\n');
  } finally {
    server.close();
  }
});

test('loadTrack propagates a failure to start the deck, without attempting the LOAD', async () => {
  const isReady = async () => false;
  const execFileFn = async () => {}; // "systemctl start" succeeds, but the socket never comes up
  await assert.rejects(
    () => loadTrack(9916, '/track.mp3', { isReady, execFileFn, timeoutMs: 50, pollIntervalMs: 10 }),
    /did not become ready/
  );
});

test('unloadTrack sends a bare UNLOAD line to the deck socket', async () => {
  const path = deckSocketPath(9918);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await unloadTrack(9918);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'UNLOAD\n');
  } finally {
    server.close();
  }
});

test('unloadTrack rejects when the deck socket connection fails - no ensureDeckRunning/retry, unlike loadTrack', async () => {
  // Nothing listening on 9919 at all - unlike loadTrack, unloadTrack
  // never calls ensureDeckRunning() first (it's only ever called for
  // a deck already known to be up, see its own doc comment), so this
  // exercises the bare connection failure with no readiness check or
  // retry in front of it.
  await assert.rejects(() => unloadTrack(9919));
});

test('setRelativeMode sends RELATIVE ON to the deck socket when turning on', async () => {
  const path = deckSocketPath(9931);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await setRelativeMode(9931, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'RELATIVE ON\n');
  } finally {
    server.close();
  }
});

test('setRelativeMode sends RELATIVE OFF to the deck socket when turning off', async () => {
  const path = deckSocketPath(9932);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await setRelativeMode(9932, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'RELATIVE OFF\n');
  } finally {
    server.close();
  }
});

test('setRelativeMode calls ensureDeckRunning (via the injected isReady) before sending RELATIVE ON - 2026-08-19, unlike unloadTrack/seek/etc.', async () => {
  // Relative mode can be armed before anything's ever been loaded (player_set_relative_mode() is
  // a plain field write server-side) - this could legitimately be the first command ever sent to
  // a deck with no xwax@N.service running yet, so it needs its own on-demand start, same as
  // loadTrack. See deck-control.js's own doc comment.
  const path = deckSocketPath(9933);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  let checkedDeckNumber = null;
  const isReady = async (deckNumber) => {
    checkedDeckNumber = deckNumber;
    return true;
  };

  try {
    await setRelativeMode(9933, true, { isReady });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(checkedDeckNumber, 9933);
    assert.equal(received, 'RELATIVE ON\n');
  } finally {
    server.close();
  }
});

test('setRelativeMode propagates a failure to start the deck, without attempting RELATIVE ON', async () => {
  const isReady = async () => false;
  const execFileFn = async () => {}; // "systemctl start" succeeds, but the socket never comes up
  await assert.rejects(
    () => setRelativeMode(9952, true, { isReady, execFileFn, timeoutMs: 50, pollIntervalMs: 10 }),
  );
});

test('seek sends a SEEK <seconds> line to the deck socket', async () => {
  const path = deckSocketPath(9934);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await seek(9934, 42.5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'SEEK 42.5\n');
  } finally {
    server.close();
  }
});

test('seek rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as unloadTrack', async () => {
  await assert.rejects(() => seek(9935, 0));
});

test('relocate sends a RELOCATE <seconds> line to the deck socket', async () => {
  const path = deckSocketPath(9950);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await relocate(9950, 12.75);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'RELOCATE 12.75\n');
  } finally {
    server.close();
  }
});

test('relocate rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => relocate(9951, 0));
});

test('setCue sends a SET_CUE <seconds> line to the deck socket', async () => {
  const path = deckSocketPath(9947);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await setCue(9947, 42.5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'SET_CUE 42.5\n');
  } finally {
    server.close();
  }
});

test('setCue rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => setCue(9941, 0));
});

test('gotoCue sends a bare GOTO_CUE line to the deck socket', async () => {
  const path = deckSocketPath(9942);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await gotoCue(9942);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'GOTO_CUE\n');
  } finally {
    server.close();
  }
});

test('gotoCue rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => gotoCue(9943));
});

test('playCue sends a bare PLAY_CUE line to the deck socket', async () => {
  const path = deckSocketPath(9944);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await playCue(9944);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'PLAY_CUE\n');
  } finally {
    server.close();
  }
});

test('playCue rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => playCue(9945));
});

test('play sends a bare PLAY line to the deck socket', async () => {
  const path = deckSocketPath(9946);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await play(9946);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'PLAY\n');
  } finally {
    server.close();
  }
});

test('play rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => play(9947));
});

test('pause sends a bare PAUSE line to the deck socket', async () => {
  const path = deckSocketPath(9948);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await pause(9948);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'PAUSE\n');
  } finally {
    server.close();
  }
});

test('pause rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => pause(9949));
});

test('setLoop sends a LOOP <start> <end> line to the deck socket', async () => {
  const path = deckSocketPath(9936);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await setLoop(9936, 12.5, 14.5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'LOOP 12.5 14.5\n');
  } finally {
    server.close();
  }
});

test('setLoop rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => setLoop(9937, 0, 2));
});

test('clearLoop sends a LOOP OFF line to the deck socket', async () => {
  const path = deckSocketPath(9938);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await clearLoop(9938);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'LOOP OFF\n');
  } finally {
    server.close();
  }
});

test('clearLoop rejects when the deck socket connection fails - no ensureDeckRunning/retry, same as seek', async () => {
  await assert.rejects(() => clearLoop(9939));
});

test('setRelativeMode persists the choice via deps.relativeModeStore when given', async () => {
  const path = deckSocketPath(9936);
  const server = createSocketServer();
  server.on('connection', (socket) => socket.on('data', () => {}));
  await new Promise((resolve) => server.listen(path, resolve));

  const stored = new Map();
  const relativeModeStore = { set: (deckNumber, on) => stored.set(deckNumber, on) };

  try {
    await setRelativeMode(9936, true, { relativeModeStore });
    assert.equal(stored.get(9936), true);
  } finally {
    server.close();
  }
});

test('setRelativeMode without deps.relativeModeStore still sends the command (store is optional)', async () => {
  const path = deckSocketPath(9937);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await setRelativeMode(9937, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'RELATIVE ON\n');
  } finally {
    server.close();
  }
});

test('loadTrack sends LOAD and nothing else - a fresh track always starts in tracking', async () => {
  // It used to reapply the deck's last Relative choice here. A loaded track now deliberately starts
  // TRACKING whatever the last one ended as (xwax's player_set_track), so dropping the needle on it
  // behaves like a normal record and PLAY/CUEP is what turns tracking off. A leftover store-shaped
  // dep must not resurrect it, which is what the ignored `relativeModeStore` below guards.
  const path = deckSocketPath(9938);
  const server = createSocketServer();
  let received = '';
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => {
      // loadTrack now probes with STATUS before writing (see isDeckServing) - answer it like a real
      // xwax would, and do not record it as something the deck was asked to do.
      const text = chunk.toString();
      if (text.startsWith('STATUS')) { socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'); return; }
      received += text;
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  try {
    await loadTrack(9938, '/track.mp3', { isReady: async () => true, relativeModeStore: { get: () => true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received, 'LOAD /track.mp3\n');
  } finally {
    server.close();
  }
});


// --- passthrough guard ---
//
// A deck in passthrough is driven by alsaloop, not xwax, and both of these call ensureDeckRunning()
// first - which would START xwax on an ALSA device alsaloop is already holding. The app hides both
// controls during passthrough; this is the backstop for anything else that might send them.

/** Listens on a deck socket and resolves whatever arrives, so a test can assert on silence too. */
function listeningDeck(deckNumber) {
  const server = createSocketServer();
  const received = { text: '' };
  server.on('connection', (socket) => {
    socket.on('data', (chunk) => { received.text += chunk; });
  });
  const ready = new Promise((resolve) => server.listen(deckSocketPath(deckNumber), resolve));
  return { server, received, ready };
}

test('KEYLOCK is dropped for a deck in passthrough', async () => {
  const { server, received, ready } = listeningDeck(9961);
  await ready;
  try {
    await setKeyLock(9961, true, { passthrough: { isActive: () => true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.text, '', 'nothing should reach a deck alsaloop is driving');
  } finally {
    server.close();
  }
});

test('KEYLOCK still reaches a deck that is NOT in passthrough', async () => {
  const { server, received, ready } = listeningDeck(9962);
  await ready;
  try {
    // isActive answers for a different deck, so this one must go through untouched.
    await setKeyLock(9962, true, { passthrough: { isActive: (deck) => deck === 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.text, 'KEYLOCK ON\n');
  } finally {
    server.close();
  }
});

test('RELATIVE is dropped for a deck in passthrough', async () => {
  const { server, received, ready } = listeningDeck(9963);
  await ready;
  try {
    await setRelativeMode(9963, true, { passthrough: { isActive: () => true } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.text, '');
  } finally {
    server.close();
  }
});

/*
 * Dropped from the SOCKET, kept in the STORE.
 *
 * Passthrough owns the deck's channel pair, so no command may start xwax against it - but the
 * choice is still the user's, and the store is what a later deck start reapplies. Dropping it
 * outright made both lock buttons dead on an idle deck: the box answered ok, changed nothing, and
 * the toggle sprang straight back (2026-09-29).
 */
test('a lock set during passthrough is still remembered for the next deck start', async () => {
  const { server, received, ready } = listeningDeck(9965);
  await ready;
  try {
    const keyLock = new Map();
    const relative = new Map();
    const passthrough = { isActive: () => true };

    await setKeyLock(9965, true, { passthrough, keyLockStore: { set: (d, on) => keyLock.set(d, on) } });
    await setRelativeMode(9965, true, { passthrough, relativeModeStore: { set: (d, on) => relative.set(d, on) } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(received.text, '', 'still nothing on the wire');
    assert.equal(keyLock.get(9965), true, 'but the key lock choice was kept');
    assert.equal(relative.get(9965), true, 'and so was the relative one');
  } finally {
    server.close();
  }
});

test('with no passthrough manager wired in, nothing is refused', async () => {
  // Absent must mean "nobody told us", not "refuse" - every other caller and test omits it.
  const { server, received, ready } = listeningDeck(9964);
  await ready;
  try {
    await setKeyLock(9964, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.text, 'KEYLOCK ON\n');
  } finally {
    server.close();
  }
});
