import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createSocketServer } from 'node:net';
import { isDeckRunning, isDeckServing, deckSocketPath } from '../src/xwax-status.js';

// net.Server already unlinks its own Unix socket file on close() - no
// manual cleanup needed here.

test('isDeckRunning is true when something is listening on the deck socket', async () => {
  const path = deckSocketPath(9901); // a deck number no real xwax instance uses
  const server = createSocketServer();
  await new Promise((resolve) => server.listen(path, resolve));
  try {
    assert.equal(await isDeckRunning(9901), true);
  } finally {
    server.close();
  }
});

test('isDeckRunning is false when nothing is listening on the deck socket', async () => {
  assert.equal(await isDeckRunning(9902), false);
});

test('isDeckRunning is false once the listener goes away', async () => {
  const path = deckSocketPath(9903);
  const server = createSocketServer();
  await new Promise((resolve) => server.listen(path, resolve));
  await new Promise((resolve) => server.close(resolve));

  assert.equal(await isDeckRunning(9903), false);
});

// Each of these tracks its server-side sockets and destroys them before close(). net.Server.close()
// waits for existing connections to finish, and isDeckServing deliberately leaves one open for its
// whole timeout - without this the close() promise never resolves and every later test in the file
// stalls behind it.
function socketServer(path, onConnection) {
  const server = createSocketServer();
  const open = new Set();
  server.on('connection', (socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    onConnection?.(socket);
  });
  return {
    listen: () => new Promise((resolve) => server.listen(path, resolve)),
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('isDeckServing is false for a socket that accepts but never answers', async () => {
  // The real failure: xwax creates its control socket before its control thread serves it, so a
  // bare connect() succeeds against a deck that resets the very next write. ensureDeckRunning()
  // called that ready, and the LOAD that followed died with ECONNRESET (hardware, 2026-09-20).
  const server = socketServer(deckSocketPath(9991)); // accepts, stays silent - a deck still starting
  await server.listen();

  assert.equal(await isDeckServing(9991, { timeoutMs: 150 }), false);
  // The distinction that matters: the very same socket IS "running".
  assert.equal(await isDeckRunning(9991, { timeoutMs: 150 }), true);

  await server.close();
});

test('isDeckServing is true once the deck answers', async () => {
  const server = socketServer(deckSocketPath(9992), (socket) => {
    socket.on('data', () => socket.write('STATUS EMPTY 0.0 0.000 0 0.000 0 0.000 0.000\n'));
  });
  await server.listen();

  assert.equal(await isDeckServing(9992, { timeoutMs: 500 }), true);

  await server.close();
});

test('isDeckServing accepts any reply, not just a parseable STATUS', async () => {
  // "Can you talk to me", not "what did you say" - parsing is deck-status-poller.js's job, and a
  // deck answering something unexpected will still accept a LOAD.
  const server = socketServer(deckSocketPath(9993), (socket) => {
    socket.on('data', () => socket.write('not a status line at all\n'));
  });
  await server.listen();

  assert.equal(await isDeckServing(9993, { timeoutMs: 500 }), true);

  await server.close();
});

test('isDeckServing is false when nothing is listening', async () => {
  assert.equal(await isDeckServing(9994, { timeoutMs: 150 }), false);
});
