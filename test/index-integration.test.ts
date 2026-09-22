import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSearchRoute,
  ensureChromeBridgeServer,
  resolveChromeExtensionId,
  searchLedgerOptions,
  selectChromeCompanion,
  stopChromeBridgeServer,
} from '../src/index.js';

test('buildSearchRoute fans out queries batch through the canonical runtime', () => {
  const route = buildSearchRoute({ queries: ['alpha', 'beta'], limit: 5 });
  assert.equal(route.tool, 'web_search');
  assert.deepEqual(route.args.queries, ['alpha', 'beta']);
  assert.equal(route.args.query, undefined);
  assert.equal(route.args.limit, 5);
});

test('buildSearchRoute keeps single query singular and forwards query fields', () => {
  const route = buildSearchRoute({
    query: 'q',
    includeContent: true,
    recency: 'week',
    domains: ['example.com', '-blocked.com'],
    yearFrom: 2020,
  });
  assert.equal(route.tool, 'web_search');
  assert.equal(route.args.query, 'q');
  assert.equal(route.args.queries, undefined);
  assert.equal(route.args.includeContent, true);
  assert.equal(route.args.recency, 'week');
  assert.deepEqual(route.args.domains, ['example.com', '-blocked.com']);
  assert.equal(route.args.yearFrom, 2020);
});

test('buildSearchRoute rejects query+queries, empty selectors, and multi-query cursor', () => {
  assert.throws(() => buildSearchRoute({ query: 'a', queries: ['b'] }), /exactly one of query or queries/);
  assert.throws(() => buildSearchRoute({}), /requires selector/);
  assert.throws(() => buildSearchRoute({ queries: [] }), /1-8/);
  assert.throws(
    () => buildSearchRoute({ queries: ['a', 'b'], category: 'research', source: 'arxiv', cursor: 'x' }),
    /only supported with a single query/,
  );
});

test('buildSearchRoute research takes a single query and rejects batches', () => {
  const route = buildSearchRoute({ queries: ['only'], category: 'research', source: 'arxiv' });
  assert.equal(route.tool, 'research');
  assert.equal(route.args.query, 'only');
  assert.throws(
    () => buildSearchRoute({ queries: ['a', 'b'], category: 'research' }),
    /not supported with category "research"/,
  );
});

test('buildSearchRoute carries no provider selection input', () => {
  const route = buildSearchRoute({ query: 'q' });
  for (const key of ['provider', 'providers', 'backend', 'backends']) {
    assert.equal(route.args[key], undefined, `route must not carry ${key}`);
  }
});

test('ledger options derive safely from params that route validation rejects', () => {
  // Reject-on-overflow stays in the route: ledger key derivation never throws
  // and never smuggles the cursor into the duplicate key.
  const options = searchLedgerOptions({ query: 'x', limit: 21, cursor: 'opaque-token' });
  assert.equal(options.limit, 21);
  assert.equal((options as { cursor?: string }).cursor, undefined);
  assert.throws(
    () => buildSearchRoute({ query: 'x', limit: 21 }),
    (error: unknown) => (error as { code?: string }).code === 'invalid_request',
  );
});

test('resolveChromeExtensionId trims and fails closed on blank', () => {
  assert.equal(resolveChromeExtensionId({}), undefined);
  assert.equal(resolveChromeExtensionId({ PI_SEARCH_CHROME_EXTENSION_ID: '  ' }), undefined);
  assert.equal(resolveChromeExtensionId({ PI_SEARCH_CHROME_EXTENSION_ID: '  abc123  ' }), 'abc123');
});

test('selectChromeCompanion never fabricates inventory; ambiguity fails', () => {
  const missing = selectChromeCompanion({ instances: [], osDefault: null, explicitFamily: 'chrome' });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.message, /no connected chrome companion/);
  const at = Date.now();
  const solo = selectChromeCompanion({
    instances: [{ instanceId: 'i-1', family: 'chrome', version: '1.0.0', caps: '', lastSeen: at }],
    osDefault: { family: 'chrome', isChromium: true },
  });
  assert.equal(solo.ok, true);
  const dup = selectChromeCompanion({
    instances: [
      { instanceId: 'i-1', family: 'chrome', version: '1.0.0', caps: '', lastSeen: at },
      { instanceId: 'i-2', family: 'chrome', version: '1.0.0', caps: '', lastSeen: at },
    ],
    osDefault: { family: 'chrome', isChromium: true },
  });
  assert.equal(dup.ok, false);
});

test('ensureChromeBridgeServer gates unconfigured auto-pin behind explicit pairing authority', async () => {
  await assert.rejects(() => ensureChromeBridgeServer({}, { port: 0 }), /pairing is not armed/);
  const server = await ensureChromeBridgeServer({}, { port: 0, allowPairingBootstrap: true });
  assert.deepEqual(server.listInstances(), []);
  await stopChromeBridgeServer();
});

test('ensureChromeBridgeServer starts and stops on an ephemeral port', async () => {
  const server = await ensureChromeBridgeServer(
    {
      PI_SEARCH_CHROME_EXTENSION_ID: 'abcdefghijklmnopqrstuvwxyzabcdef',
      PI_SEARCH_CHROME_PAIRING_SECRET: 'integration-pairing-secret',
    },
    { port: 0 },
  );
  assert.deepEqual(server.listInstances(), []);
  const again = await ensureChromeBridgeServer(
    {
      PI_SEARCH_CHROME_EXTENSION_ID: 'abcdefghijklmnopqrstuvwxyzabcdef',
      PI_SEARCH_CHROME_PAIRING_SECRET: 'integration-pairing-secret',
    },
    { port: 0 },
  );
  assert.equal(again, server);
  await stopChromeBridgeServer();
});
