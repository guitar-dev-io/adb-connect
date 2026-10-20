import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { diagnoseUnreachable, tcpReachable, ADB_BLOCKED_HINT } from '../src/adb/diagnose';

/** Open a throwaway listener on 127.0.0.1 and return its endpoint plus a disposer. */
function listen(): Promise<{ endpoint: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ endpoint: `127.0.0.1:${addr.port}`, close: () => server.close() });
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

/** A port nobody is listening on: bind, read the port, then close before the test. */
function closedEndpoint(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        const endpoint = `127.0.0.1:${addr.port}`;
        server.close(() => resolve(endpoint));
      } else {
        reject(new Error('no address'));
      }
    });
  });
}

test('tcpReachable: true for an open port, false for a closed one', async () => {
  const srv = await listen();
  try {
    assert.equal(await tcpReachable(srv.endpoint), true);
  } finally {
    srv.close();
  }
  const closed = await closedEndpoint();
  assert.equal(await tcpReachable(closed, 500), false);
});

test('tcpReachable: false for a malformed endpoint', async () => {
  assert.equal(await tcpReachable('not-an-endpoint'), false);
});

test('diagnoseUnreachable: returns the blocked hint only when adb says unreachable but we can reach it', async () => {
  const srv = await listen();
  try {
    assert.equal(await diagnoseUnreachable(srv.endpoint, 'failed to connect: No route to host'), ADB_BLOCKED_HINT);
    // adb text does not match an unreachable pattern -> no hint.
    assert.equal(await diagnoseUnreachable(srv.endpoint, 'failed to connect: Connection refused'), undefined);
  } finally {
    srv.close();
  }
});

test('diagnoseUnreachable: no hint when this process also cannot reach the endpoint', async () => {
  const closed = await closedEndpoint();
  assert.equal(await diagnoseUnreachable(closed, 'Network is unreachable'), undefined);
});
