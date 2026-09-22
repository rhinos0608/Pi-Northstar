// Regression: concurrent ensureChromeBridgeServer calls must share one start.
// Before the fix, check-before-await + assign-after-await let two first calls
// each bind a server; the loser went shared-mode and overwrote the owner.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { CHROME_BRIDGE_HOST } from '../../src/chrome/chrome-profile-bridge.js';
import { ensureChromeBridgeServer, stopChromeBridgeServer } from '../../src/index.js';

const ENV = { PI_SEARCH_CHROME_EXTENSION_ID: 'abcdefghijklmnopqrstuvwxyzabcdef', PI_SEARCH_CHROME_PAIRING_SECRET: 'start-race-pairing-secret' };

async function freePort(): Promise<number> {
  const probe = http.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, CHROME_BRIDGE_HOST, resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

test('concurrent ensureChromeBridgeServer calls share a single server', async () => {
  const port = await freePort();
  try {
    const [first, second] = await Promise.all([
      ensureChromeBridgeServer(ENV, { port }),
      ensureChromeBridgeServer(ENV, { port }),
    ]);
    assert.equal(first, second, 'concurrent ensure calls must return the same owner');
    const sequential = await ensureChromeBridgeServer(ENV, { port });
    assert.equal(sequential, first, 'post-start ensure must return the cached owner');
  } finally {
    await stopChromeBridgeServer();
  }
});

test('unconfigured bridge requires explicit pairing authority before it binds', async () => {
  const port = await freePort();
  await assert.rejects(
    () => ensureChromeBridgeServer({}, { port }),
    /pairing is not armed/,
  );
  try {
    const server = await ensureChromeBridgeServer({}, { port, allowPairingBootstrap: true });
    assert.equal(server.isShared, false, 'explicit user pairing path owns the fresh bind');
    assert.deepEqual(server.listInstances(), []);
  } finally {
    await stopChromeBridgeServer();
  }
});

test('ensureChromeBridgeServer retries after a foreign-protocol conflict', async () => {
  const port = await freePort();
  const squatter = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ protocol: 999, ok: false }));
  });
  await new Promise<void>((resolve) => {
    squatter.listen(port, CHROME_BRIDGE_HOST, resolve);
  });
  try {
    await assert.rejects(() => ensureChromeBridgeServer(ENV, { port }), /bridge unavailable/);
  } finally {
    await new Promise<void>((resolve) => {
      squatter.close(() => {
        resolve();
      });
    });
  }
  // Failed start must clear the in-flight slot so a later call can bind fresh.
  const retry = await ensureChromeBridgeServer(ENV, { port });
  assert.equal(retry.isShared, false);
  await stopChromeBridgeServer();
});
