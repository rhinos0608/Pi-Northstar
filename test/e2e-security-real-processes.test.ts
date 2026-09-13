// End-to-end security tests with REAL processes/sockets (no mocked seams).
//
// (a) Pre-aborted AbortSignal prevents spawn of the browser executable:
//     a real fake executable exists on disk (+x, on PATH) and would leave a
//     marker file if launched; runCommand must reject without launching it.
// (b) SSRF redirect chain: real local HTTP servers; hop-0 is a public-syntax
//     hostname served by a real redirector, hop-1 targets 127.0.0.1/metadata.
//     The fetch layer must refuse the blocked final content and never dispatch
//     to it (hit counters stay zero, secret never surfaces).
// (c) Chrome bridge auth: a real ChromeBridgeServer on an ephemeral port
//     rejects a wrong token (403), rejects unknown targets (409), and serves
//     a full roundtrip for the correct token + registered instance.
//
// Cross-OS: only node:http, node:os tmpdir, node:path join. No shell tricks.
// Every test is fast local I/O; per-test timeouts keep the file under 30s.
import assert from 'node:assert/strict';
import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../src/browser/agent-browser-process.js';
import {
  CHROME_BRIDGE_HOST,
  ChromeBridgeClient,
  ChromeBridgeServer,
  extensionOriginForId,
} from '../src/chrome/chrome-profile-bridge.js';
import type { ChromeBridgeCommand } from '../src/chrome/chrome-profile-contract.js';
import { fetchText } from '../src/core/http.js';

const EXTENSION_ID = 'abcdefghijklmnopqrstuvwxyzabcdef';
const EXTENSION_ORIGIN = extensionOriginForId(EXTENSION_ID);
const TEST_TARGET = 'inst-e2e-001';
const SECRET = 'e2e-metadata-secret-must-never-surface';

// ── shared helpers ──

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

function rawRequest(
  port: number,
  path: string,
  options?: { method?: string | undefined; headers?: Record<string, string> | undefined; body?: string | undefined },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = options?.body;
    const req = http.request(
      {
        host: CHROME_BRIDGE_HOST,
        port,
        path,
        method: options?.method ?? 'GET',
        headers: {
          ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...options?.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function listenLocalhost(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind local server');
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

function testCommand(server: ChromeBridgeServer, id: string, target = TEST_TARGET): ChromeBridgeCommand {
  return {
    protocol: 1,
    id,
    sessionKey: 'sk-e2e',
    grantId: 'grant-e2e',
    targetInstanceId: target,
    bridgeToken: server.bridgeToken,
    kind: 'execute',
    operation: { kind: 'tabs' },
  };
}

// ── (a) pre-aborted signal prevents spawn ──

test(
  'e2e: pre-aborted signal never spawns the browser executable',
  { timeout: 10_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pi-e2e-abort-'));
    const marker = join(dir, 'launched.marker');
    // Real executable file: if a regression ever spawns it, it leaves a marker.
    const fake = join(dir, 'agent-browser');
    await writeFile(
      fake,
      `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(marker)}, 'launched\\n');\n`,
      { mode: 0o755 },
    );
    await chmod(fake, 0o755).catch(() => {});
    assert.equal(existsSync(fake), true, 'fake executable must exist for the test to be meaningful');

    const runtimeRoot = await mkdtemp(join(tmpdir(), 'pi-e2e-abort-rt-'));
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await assert.rejects(
      runCommand(['snapshot'], {
        executablePath: fake,
        runtimeRoot,
        namespace: 'ns-e2e-preabort',
        signal: controller.signal,
        env: { PATH: `${dir}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}` },
      }),
      /abort/i,
    );
    assert.ok(Date.now() - start < 5000, 'pre-aborted runCommand must reject promptly');
    assert.equal(existsSync(marker), false, 'pre-aborted signal must prevent spawn: marker absent');
  },
);

// ── (b1) direct blocked literals refused before dispatch (always runs) ──

test(
  'e2e: fetch layer refuses loopback/metadata literals with zero dispatch',
  { timeout: 10_000 },
  async () => {
    let hits = 0;
    const metadata = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(SECRET);
    });
    const port = await listenLocalhost(metadata);
    try {
      await assert.rejects(fetchText(`http://127.0.0.1:${port}/secret`), /Private\/reserved/);
      assert.equal(hits, 0, 'blocked loopback literal must never reach the server');
      await assert.rejects(fetchText('http://169.254.169.254/latest/meta-data'), /Private\/reserved/);
      await assert.rejects(fetchText('http://metadata/latest/meta-data'), /Blocked hostname/);
    } finally {
      await closeServer(metadata);
    }
  },
);

// ── (b2) real redirect chain to 127.0.0.1/metadata refused ──

test(
  'e2e: SSRF redirect chain (public hop-0 -> 127.0.0.1/metadata) refused, secret never surfaces',
  { timeout: 15_000 },
  async (t) => {
    // Hop-0 must be a public-syntax hostname that actually routes to the real
    // local redirector over TCP. 127.0.0.1.nip.io resolves via public DNS on
    // every OS; skip honestly when DNS is unavailable (offline CI).
    let routesLocal = false;
    try {
      const answers = await dnsLookup('127.0.0.1.nip.io', { all: true });
      routesLocal = answers.some((entry) => entry.address === '127.0.0.1');
    } catch {
      routesLocal = false;
    }
    if (!routesLocal) {
      t.skip('no DNS route for 127.0.0.1.nip.io; offline environment');
      return;
    }

    let secretHits = 0;
    const secretServer = http.createServer((_req, res) => {
      secretHits++;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(SECRET);
    });
    const secretPort = await listenLocalhost(secretServer);

    let redirectHits = 0;
    const redirector = http.createServer((req, res) => {
      redirectHits++;
      const target =
        req.url === '/to-metadata'
          ? 'http://169.254.169.254/latest/meta-data'
          : `http://127.0.0.1:${secretPort}/secret`;
      res.writeHead(302, { location: target });
      res.end();
    });
    const redirectPort = await listenLocalhost(redirector);

    // Preflight DNS seam only (documented fetchText parameter): the redirector
    // is reached over real TCP via system DNS; the lie keeps preflight public.
    const preflight = async () => [{ address: '93.184.216.34', family: 4 as const }];
    try {
      const loopbackHop = fetchText(
        `http://127.0.0.1.nip.io:${redirectPort}/start`,
        {},
        undefined,
        5000,
        preflight as never,
      );
      await assert.rejects(loopbackHop, /Private\/reserved/);
      assert.equal(redirectHits, 1, 'hop-0 must be traversed over real HTTP');
      assert.equal(secretHits, 0, 'blocked redirect target must never be dispatched');

      const metadataHop = fetchText(
        `http://127.0.0.1.nip.io:${redirectPort}/to-metadata`,
        {},
        undefined,
        5000,
        preflight as never,
      );
      const error = await metadataHop.then(
        () => {
          throw new Error('metadata redirect was followed; expected rejection');
        },
        (rejection: unknown) => rejection,
      );
      assert.match(String(error), /Private\/reserved/);
      assert.ok(!String(error).includes(SECRET), 'rejection must not echo blocked content');
      assert.equal(secretHits, 0, 'metadata target must never be dispatched');
    } finally {
      await closeServer(redirector);
      await closeServer(secretServer);
    }
  },
);

// ── (c) Chrome bridge auth on a real ephemeral server ──

test(
  'e2e: bridge rejects wrong token and unknown target before any dispatch',
  { timeout: 10_000 },
  async () => {
    const port = await freePort();
    const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
    try {
      await server.start();
      server.registerInstance({ instanceId: TEST_TARGET, family: 'chrome', version: '1.0.0', caps: '' });

      const wrongToken = await rawRequest(port, '/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...testCommand(server, 'e2e-wrong-token'), bridgeToken: 'wrong-token' }),
      });
      assert.equal(wrongToken.status, 403);
      assert.ok(wrongToken.text.includes('bridge command rejected'));

      const unknownTarget = await rawRequest(port, '/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(testCommand(server, 'e2e-unknown-target', 'inst-no-such-companion')),
      });
      assert.equal(unknownTarget.status, 409);
      assert.ok(unknownTarget.text.includes('unknown target'));
      assert.equal(server.pendingCommandCount, 0, 'rejected commands must never queue');
    } finally {
      await server.stop();
    }
  },
);

test(
  'e2e: bridge serves full command roundtrip for correct token + registered instance',
  { timeout: 10_000 },
  async () => {
    const port = await freePort();
    const server = new ChromeBridgeServer({ extensionId: EXTENSION_ID, port });
    const client = new ChromeBridgeClient({ port, timeoutMs: 5_000 });
    try {
      await server.start();
      server.registerInstance({ instanceId: TEST_TARGET, family: 'chrome', version: '1.0.0', caps: '' });

      const send = client.send(testCommand(server, 'e2e-roundtrip'));
      const next = await rawRequest(
        port,
        `/next?timeoutMs=5000&protocol=1&instanceId=${TEST_TARGET}&family=chrome&version=1.0.0&caps=`,
        { headers: { origin: EXTENSION_ORIGIN } },
      );
      assert.equal(next.status, 200);
      const picked = JSON.parse(next.text) as ChromeBridgeCommand;
      assert.equal(picked.id, 'e2e-roundtrip');

      const posted = await rawRequest(port, '/result', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ protocol: 1, id: 'e2e-roundtrip', ok: true, data: { tabs: 1 } }),
      });
      assert.equal(posted.status, 200);
      const result = await send;
      assert.equal(result.ok, true);
      assert.equal(result.id, 'e2e-roundtrip');
    } finally {
      await server.stop();
    }
  },
);
