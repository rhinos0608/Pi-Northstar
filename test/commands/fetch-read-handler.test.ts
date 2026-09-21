import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeFetchRead, mapFetchReadCommandResult, parseFetchReadArgs, FETCH_READ_COMMAND } from '../../src/commands/fetch-read-handler.js';
import { createCommandContext } from '../../src/commands/command-context.js';
import { validateCommandResult } from '../../src/commands/command-result.js';
import { cacheFetchForRetrieve } from '../../src/native-fetch.js';
import { textResult } from '../../src/core/tool-output.js';
import { buildNorthstarResult } from '../../src/result-contract.js';
import { northstarTextResult } from '../../src/core/tool-output.js';

const LOOPBACK_DNS = async () => [{ address: '127.0.0.1', family: 4 as const }];
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 as const }];

function ctx(options: { env?: Record<string, string | undefined>; signal?: AbortSignal; lookup?: typeof PUBLIC_DNS; fetchPageText?: (url: string) => Promise<string> } = {}) {
  return createCommandContext({
    surface: 'test',
    env: options.env ?? {},
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.fetchPageText ? { fetchPageText: options.fetchPageText } : {}),
  });
}

test('fetch.read: argument parser enforces 5-branch union and rejects unknown fields', () => {
  assert.throws(() => parseFetchReadArgs({ unknownField: 123 }), /unknown field 'unknownField'/);
  assert.throws(() => parseFetchReadArgs({ provider: 'bing' }), /provider selection is operator-only/);
  assert.throws(() => parseFetchReadArgs({ format: 'json' }), /format is not a supported fetch field/);
  assert.throws(() => parseFetchReadArgs({ action: 'delete' }), /Unsupported fetch action/);
  assert.throws(() => parseFetchReadArgs({}), /url is required/);
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com', urls: ['https://example.com'] }), /accepts either url or urls/);
  assert.throws(() => parseFetchReadArgs({ urls: [] }), /urls\[1\.\.8\]/);
  assert.throws(() => parseFetchReadArgs({ urls: new Array(9).fill('https://example.com') }), /urls\[1\.\.8\]/);
  assert.throws(() => parseFetchReadArgs({ siteMap: false, url: 'https://example.com' }), /siteMap:true/);
  assert.throws(() => parseFetchReadArgs({ claims: ['claim1'] }), /source_check requires responseId/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'resp1', claims: [] }), /claims\[1\.\.20\]/);
  assert.throws(() => parseFetchReadArgs({ url: 'ftp://example.com' }), /HTTP\(S\) or GitHub asset URL/);
});

test('fetch.read: out-of-range bounds are rejected instead of clamped', () => {
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com', maxChars: 0 }), /maxChars/);
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com', maxChars: 60000 }), /maxChars must be an integer 1\.\.50000/);
  assert.throws(() => parseFetchReadArgs({ url: 'https://example.com', siteMap: true, maxPages: 30 }), /maxPages must be an integer 1\.\.25/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r1', limit: 60000 }), /limit must be an integer 1\.\.50000/);
  assert.throws(() => parseFetchReadArgs({ responseId: 'r1', offset: -1 }), /offset must be a non-negative integer/);
});

test('fetch.read: SSRF and blocked hostnames fail terminal and are not retryable', async () => {
  await assert.rejects(
    () => executeFetchRead({ url: 'http://127.0.0.1:8080/private' }, ctx({ lookup: LOOPBACK_DNS })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const commandResult = (error as { commandResult?: { outcome: string; retryability: string; error?: { code: string; retryable: boolean } } }).commandResult;
      assert.ok(commandResult, 'must attach commandResult to thrown error');
      assert.equal(commandResult.outcome, 'failed');
      assert.equal(commandResult.retryability, 'not_retryable');
      assert.equal(commandResult.error?.code, 'ssrf_denied');
      assert.equal(commandResult.error?.retryable, false);
      return true;
    },
  );
});

test('fetch.read: cancellation via AbortSignal marks outcome cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => executeFetchRead({ url: 'https://example.com' }, ctx({ signal: controller.signal })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const commandResult = (error as { commandResult?: { outcome: string; error?: { code: string } } }).commandResult;
      assert.ok(commandResult);
      assert.equal(commandResult.outcome, 'cancelled');
      assert.equal(commandResult.error?.code, 'cancelled');
      return true;
    },
  );
});

test('fetch.read: cached retrieve branch operates without network as no-network operation', async () => {
  const responseId = cacheFetchForRetrieve({
    query: 'cached test',
    title: 'Cached Title',
    url: 'https://example.com/cached',
    snippet: 'cached snippet',
    content: 'cached content for no-network retrieval',
  });
  assert.ok(responseId);

  // Calling retrieve with zero network:
  const result = await executeFetchRead({ responseId }, ctx());
  assert.ok(result.details);
  const commandResult = (result.details as Record<string, unknown>).northstarCommand as { outcome: string; commandId: string; sources: Array<{ kind: string }> };
  assert.equal(commandResult.commandId, FETCH_READ_COMMAND);
  assert.equal(commandResult.outcome, 'success');
  assert.equal(commandResult.sources[0]?.kind, 'internal');

  // Verify unknown responseId fails and never touches network
  await assert.rejects(
    () => executeFetchRead({ responseId: 'non-existent-resp-id' }, ctx()),
    /No stored results|No cached/,
  );
});

test('fetch.read: cached source_check branch verifies claims against cached corpus', async () => {
  const responseId = cacheFetchForRetrieve({
    query: 'claims test',
    title: 'Claims Title',
    url: 'https://example.com/claims',
    snippet: 'claims snippet',
    content: 'The solar system has eight planets.',
  });
  assert.ok(responseId);

  const result = await executeFetchRead({
    responseId,
    claims: ['The solar system has eight planets.'],
  }, ctx());

  assert.ok(result.details);
  const commandResult = (result.details as Record<string, unknown>).northstarCommand as { outcome: string; commandId: string };
  assert.equal(commandResult.commandId, FETCH_READ_COMMAND);
  assert.equal(commandResult.outcome, 'success');
});

test('fetch.read: details.degraded marker maps degraded with data retained, error still outranks', async () => {
  // Shaped like existing video/PDF specialized degraded outputs: details.degraded
  // true, no northstar envelope. Command outcome must be degraded, not success.
  const degraded = textResult('transcript body with keyframes unavailable', {
    url: 'https://www.youtube.com/watch?v=deg1',
    degraded: true,
    note: 'Keyframes were requested but unavailable; transcript and metadata only.',
    video: { keyframes: 0, synthesized: false },
  });
  const mapped = mapFetchReadCommandResult(degraded, ctx());
  assert.equal(mapped.outcome, 'degraded');
  const check = validateCommandResult(mapped);
  assert.equal(check.ok, true, `Validation failed: ${check.issues.join('; ')}`);
  assert.match(JSON.stringify(mapped.data), /transcript body/);

  // Status error still outranks degradation.
  const envelope = buildNorthstarResult({
    request: { tool: 'fetch', channel: 'web', action: 'read' },
    outcomes: [{ source: 'web', backend: 'native-fetch', error: { code: 'backend_http_error', message: 'nope', retryable: true } }],
    pagination: { supported: false, limit: 1, hasMore: false },
  });
  const errorWithDegraded = northstarTextResult('x', { url: 'https://example.com/e', degraded: true }, envelope);
  assert.equal(mapFetchReadCommandResult(errorWithDegraded, ctx()).outcome, 'failed');
});

test('fetch.read: multi-URL mixed maps partial with first error, all-failed maps failed with null data', async () => {
  const flaky = ctx({
    lookup: PUBLIC_DNS,
    fetchPageText: async (url: string) => {
      if (url.includes('/bad')) throw Object.assign(new Error('boom upstream failure'), { code: 'boom' });
      return '<html><head><title>T</title></head><body><p>body words</p></body></html>';
    },
  });
  const mixed = await executeFetchRead({ urls: ['https://example.com/good', 'https://example.com/bad'] }, flaky);
  const mixedCommand = (mixed.details as Record<string, unknown>).northstarCommand as {
    outcome: string; retryability: string; data: Record<string, unknown> | null; error?: { code: string; message: string; retryable: boolean };
  };
  assert.equal(mixedCommand.outcome, 'partial');
  assert.equal(mixedCommand.error?.code, 'backend_unavailable');
  assert.equal(mixedCommand.error?.retryable, true);
  assert.match(mixedCommand.error?.message ?? '', /boom upstream failure/);
  assert.equal(mixedCommand.retryability, 'retryable');
  assert.ok(mixedCommand.data !== null && Array.isArray((mixedCommand.data as { entries?: unknown }).entries));
  const entries = (mixedCommand.data as { entries: Array<{ url: string; status: string }> }).entries;
  assert.deepEqual(entries.map((e) => [e.url, e.status]), [['https://example.com/good', 'ok'], ['https://example.com/bad', 'error']]);

  const failing = ctx({
    lookup: PUBLIC_DNS,
    fetchPageText: async () => { throw new Error('boom upstream failure'); },
  });
  const allFailed = await executeFetchRead({ urls: ['https://example.com/a', 'https://example.com/b'] }, failing);
  const failedCommand = (allFailed.details as Record<string, unknown>).northstarCommand as {
    outcome: string; data: null; error?: { code: string; retryable: boolean };
  };
  assert.equal(failedCommand.outcome, 'failed');
  assert.equal(failedCommand.data, null);
  assert.equal(failedCommand.error?.retryable, true);
});

test('fetch.read: successful URL read produces validated command result envelope with responseId cache handle', async () => {
  const fakeHtml = '<html><head><title>Test Page</title></head><body><p>Hello world page text</p></body></html>';
  const result = await executeFetchRead(
    { url: 'https://example.com/hello' },
    ctx({
      lookup: PUBLIC_DNS,
      fetchPageText: async () => fakeHtml,
    }),
  );

  const commandResult = (result.details as Record<string, unknown>).northstarCommand;
  const validation = validateCommandResult(commandResult);
  assert.equal(validation.ok, true, `Validation failed: ${validation.issues.join('; ')}`);
  const validated = validation.result!;
  assert.equal(validated.commandId, FETCH_READ_COMMAND);
  assert.equal(validated.outcome, 'success');
  assert.equal(validated.trust, 'external');
  assert.equal(validated.sources[0]?.name, 'example.com');
  assert.equal(validated.sources[0]?.locator, 'https://example.com/hello');
  assert.ok((validated.data as { responseId?: string }).responseId, 'must provide responseId in data');
});
