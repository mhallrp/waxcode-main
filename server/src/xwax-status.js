import { createConnection } from 'node:net';

// Matches the fork's per-deck socket path convention: /tmp/xwax-deck<N>.sock.
export function deckSocketPath(deckNumber) {
  return `/tmp/xwax-deck${deckNumber}.sock`;
}

/** True if a deck's xwax process is up - something is listening on its control socket. */
export function isDeckRunning(deckNumber, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(deckSocketPath(deckNumber));
    const finish = (ready) => {
      socket.destroy();
      resolve(ready);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

/** True if a deck's xwax is not just up but ABLE TO ANSWER - it replied to a STATUS. */
export function isDeckServing(deckNumber, { timeoutMs = 500 } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(deckSocketPath(deckNumber));
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);

    function finish(ready) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    }

    socket.on('connect', () => socket.write('STATUS\n', (err) => { if (err) finish(false); }));
    socket.on('data', () => finish(true));
    socket.on('error', () => finish(false));
  });
}
