import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCommand } from '../../src/cli/cli.js';
import { callNativeTool } from '../../src/native-tools.js';
import { cacheFetchForRetrieve } from '../../src/native-fetch.js';

test('CLI discovery exposes fetch and search domains, capabilities, and help', async () => {
  const domains = await runCommand(['domains'], {});
  assert.ok((domains.data as string[]).includes('fetch'), 'domains must include fetch');
  assert.ok((domains.data as string[]).includes('search'), 'domains must include search');

  const caps = await runCommand(['capabilities'], {});
  assert.ok((caps.data as string[]).includes('fetch.read'), 'capabilities must include fetch.read');
  assert.ok((caps.data as string[]).includes('search.web'), 'capabilities must include search.web');

  const fetchHelp = await runCommand(['fetch', '--help'], {});
  assert.equal(fetchHelp.ok, true);
  assert.equal((fetchHelp.data as { commandId: string }).commandId, 'fetch.read');
  const fetchUsage = (fetchHelp.data as { usage: string }).usage;
  assert.match(fetchUsage, /--mode readable\|raw\|answer/);
  assert.match(fetchUsage, /--prompt QUESTION/);

  const fetchReadHelp = await runCommand(['fetch', 'read', '--help'], {});
  assert.equal(fetchReadHelp.ok, true);
  assert.equal((fetchReadHelp.data as { commandId: string }).commandId, 'fetch.read');

  const searchHelp = await runCommand(['search', '--help'], {});
  assert.equal(searchHelp.ok, true);
  assert.equal((searchHelp.data as { commandId: string }).commandId, 'search.web');

  const searchWebHelp = await runCommand(['search', 'web', '--help'], {});
  assert.equal(searchWebHelp.ok, true);
  assert.equal((searchWebHelp.data as { commandId: string }).commandId, 'search.web');
});

test('CLI fetch and search reject malformed flags and arguments strictly', async () => {
  assert.equal((await runCommand(['fetch', '--bogus'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['fetch', 'https://example.com', '--query'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['fetch', 'https://example.com', '--mode'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['fetch', 'https://example.com', '--prompt'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['fetch', 'https://example.com', '--top-k', 'abc'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['fetch', 'https://example.com', '--json', '--agent'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['fetch', 'https://example.com', 'extra_arg'], {})).error?.code, 'invalid_usage');

  assert.equal((await runCommand(['search', '--bogus'], {})).error?.code, 'unknown_flag');
  assert.equal((await runCommand(['search', 'query', '--limit'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['search', 'query', '--limit', 'abc'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['search', 'query', '--json', '--agent'], {})).error?.code, 'invalid_usage');
  assert.equal((await runCommand(['search', 'q1', 'q2'], {})).error?.code, 'invalid_usage');

  // Range checks are deferred to contract: CLI accepts integers, contract rejects out-of-range
  const badSearchLimit = await runCommand(['search', 'query', '--limit', '99', '--json'], {});
  assert.equal(badSearchLimit.ok, false);
  const badFetchChars = await runCommand(['fetch', 'https://example.com', '--max-chars', '999999', '--json'], {});
  assert.equal(badFetchChars.ok, false);
});

test('CLI fetch: cached retrieve branch executes via --response-id', async () => {
  const responseId = cacheFetchForRetrieve({
    query: 'cli retrieve test',
    title: 'CLI Retrieve Title',
    url: 'https://example.com/cli-retrieve',
    snippet: 'cli snippet',
    content: 'cli cached content for retrieve',
  });
  assert.ok(responseId);

  const result = await runCommand(['fetch', '--response-id', responseId, '--json'], {});
  assert.equal(result.ok, true);
  const parsed = JSON.parse(result.data as string) as { commandId: string; outcome: string };
  assert.equal(parsed.commandId, 'fetch.read');
  assert.equal(parsed.outcome, 'success');
});

test('CLI search: search QUERY executes with json output', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/cli-search">CLI Result</a>' +
        '<a class="result__snippet" href="https://example.com/cli-search">CLI snippet text</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const result = await runCommand(['search', 'cli query', '--json'], { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' });
    assert.equal(result.ok, true);
    const parsed = JSON.parse(result.data as string) as { commandId: string; outcome: string };
    assert.equal(parsed.commandId, 'search.web');
    assert.equal(parsed.outcome, 'success');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('native bypass closure: callNativeTool fetch and web_search route through registry handlers', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('https://duckduckgo.com/html/')) {
      return new Response(
        '<html><body><div><a class="result__a" href="https://example.com/closure">Closure Hit</a>' +
        '<a class="result__snippet" href="https://example.com/closure">Closure snippet</a></div></body></html>',
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const searchRes = await callNativeTool('web_search', { query: 'closure query' }, { env: { PI_SEARCH_WEB_BACKENDS: 'duckduckgo' } });
    const searchDetails = searchRes.details as Record<string, unknown>;
    assert.ok(searchDetails.northstarCommand, 'must carry northstarCommand');
    assert.equal((searchDetails.northstarCommand as { commandId: string }).commandId, 'search.web');

    const fetchRes = await callNativeTool('fetch', {
      action: 'retrieve',
      responseId: searchDetails.responseId as string,
    }, { env: {} });
    const fetchDetails = fetchRes.details as Record<string, unknown>;
    assert.ok(fetchDetails.northstarCommand, 'must carry northstarCommand');
    assert.equal((fetchDetails.northstarCommand as { commandId: string }).commandId, 'fetch.read');
  } finally {
    globalThis.fetch = savedFetch;
  }
});
