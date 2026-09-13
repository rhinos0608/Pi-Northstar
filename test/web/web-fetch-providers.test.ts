import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fetchExternalReadablePage,
  isExternalFetchEligible,
  resolveWebFetchPolicy,
} from '../../src/web/web-fetch-providers.js';
import type {
  WebFetchAdapter,
  WebFetchAdapterInput,
  WebFetchedPage,
} from '../../src/web/web-search-types.js';

function fakeAdapter(
  id: 'firecrawl' | 'jina',
  opts: { configured?: boolean } = {},
): WebFetchAdapter {
  return {
    id,
    configured: () => opts.configured ?? true,
    fetch: () => {
      throw new Error('not implemented in policy test');
    },
  };
}

const bothConfigured: WebFetchAdapter[] = [fakeAdapter('firecrawl'), fakeAdapter('jina')];

test('fetch policy disabled by default: no gate, no backends', () => {
  const policy = resolveWebFetchPolicy({}, bothConfigured);
  assert.equal(policy.enabled, false);
  assert.deepEqual(policy.providers, []);
  assert.deepEqual(policy.unavailable, []);
  assert.equal(policy.timeoutMs, 15_000);
});

test('fetch policy gate on but blank backend list means no attempts', () => {
  const policy = resolveWebFetchPolicy(
    { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: '' },
    bothConfigured,
  );
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.providers, []);
});

test('fetch policy preserves explicit backend order', () => {
  const policy = resolveWebFetchPolicy(
    { PI_SEARCH_EXTERNAL_FETCH: 'true', PI_SEARCH_FETCH_BACKENDS: 'jina,firecrawl' },
    bothConfigured,
  );
  assert.equal(policy.enabled, true);
  assert.deepEqual(policy.providers, ['jina', 'firecrawl']);
  assert.deepEqual(policy.unavailable, []);
});

test('fetch policy rejects duplicate backends before adapter calls', () => {
  let calls = 0;
  const counting: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => {
      calls++;
      return true;
    },
    fetch: () => {
      throw new Error('must not be called');
    },
  };
  assert.throws(
    () =>
      resolveWebFetchPolicy(
        { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,firecrawl' },
        [counting],
      ),
    /duplicate/,
  );
  assert.equal(calls, 0);
});

test('fetch policy rejects unknown backends before adapter calls', () => {
  let calls = 0;
  const counting: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => {
      calls++;
      return true;
    },
    fetch: () => {
      throw new Error('must not be called');
    },
  };
  assert.throws(
    () =>
      resolveWebFetchPolicy(
        { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,exa' },
        [counting],
      ),
    /unknown backend/,
  );
  assert.equal(calls, 0);
});

test('fetch policy rejects more than two backends', () => {
  assert.throws(
    () =>
      resolveWebFetchPolicy(
        {
          PI_SEARCH_EXTERNAL_FETCH: '1',
          PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina,firecrawl',
        },
        bothConfigured,
      ),
    /duplicate/,
  );
  // Three distinct ids is impossible with two known ids; unknown also rejects.
  assert.throws(() =>
    resolveWebFetchPolicy(
      { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina,extra' },
      bothConfigured,
    ),
    /unknown backend/,
  );
});

test('fetch policy rejects malformed gate and out-of-range timeout', () => {
  assert.throws(() =>
    resolveWebFetchPolicy(
      { PI_SEARCH_EXTERNAL_FETCH: 'yes', PI_SEARCH_FETCH_BACKENDS: 'firecrawl' },
      bothConfigured,
    ),
  );
  assert.throws(() =>
    resolveWebFetchPolicy(
      { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: '50' },
      bothConfigured,
    ),
  );
  assert.throws(() =>
    resolveWebFetchPolicy(
      { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: 'huge' },
      bothConfigured,
    ),
  );
});

test('fetch policy accepts bounded timeout', () => {
  const policy = resolveWebFetchPolicy(
    {
      PI_SEARCH_EXTERNAL_FETCH: '1',
      PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
      PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: '20000',
    },
    bothConfigured,
  );
  assert.equal(policy.timeoutMs, 20000);
});

test('external fetch ineligible: caller abort, policy, DNS, size, 404/410', () => {
  const aborted = AbortSignal.abort();
  assert.equal(isExternalFetchEligible(new Error('fetch failed'), aborted), false);
  const abortError = new Error('operation aborted');
  abortError.name = 'AbortError';
  assert.equal(isExternalFetchEligible(abortError, aborted), false);
  assert.equal(isExternalFetchEligible(new Error('Disallowed URL scheme: ftp:'), undefined), false);
  assert.equal(
    isExternalFetchEligible(new Error('URL credentials are not allowed'), undefined),
    false,
  );
  assert.equal(isExternalFetchEligible(new Error('Blocked hostname: localhost'), undefined), false);
  assert.equal(
    isExternalFetchEligible(
      new Error('DNS resolved example.com to private/reserved address: 10.0.0.1'),
      undefined,
    ),
    false,
  );
  assert.equal(
    isExternalFetchEligible(new Error('DNS lookup timed out for example.com'), undefined),
    false,
  );
  assert.equal(
    isExternalFetchEligible(new Error('Response is too large (2000000 bytes)'), undefined),
    false,
  );
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 404 for https://example.com/x'), undefined),
    false,
  );
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 410 for https://example.com/x'), undefined),
    false,
  );
  assert.equal(
    isExternalFetchEligible(
      Object.assign(new Error('HTTP 404'), { status: 404 }),
      undefined,
    ),
    false,
  );
});

test('external fetch eligible: transport, non-caller timeout, 401/403/429, retryable 5xx, empty', () => {
  assert.equal(isExternalFetchEligible(new Error('fetch failed'), undefined), true);
  assert.equal(isExternalFetchEligible(new Error('Network request failed'), undefined), true);
  const timeout = new Error('Request timed out');
  timeout.name = 'TimeoutError';
  assert.equal(isExternalFetchEligible(timeout, undefined), true);
  const strayAbort = new Error('aborted due to timeout');
  strayAbort.name = 'AbortError';
  assert.equal(isExternalFetchEligible(strayAbort, undefined), true);
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 401 for https://example.com/x'), undefined),
    true,
  );
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 403 for https://example.com/x'), undefined),
    true,
  );
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 429 for https://example.com/x'), undefined),
    true,
  );
  assert.equal(
    isExternalFetchEligible(new Error('HTTP 503 for https://example.com/x'), undefined),
    true,
  );
  assert.equal(
    isExternalFetchEligible(new Error('native fetch returned no usable content'), undefined),
    true,
  );
});

test('external fetch disabled gate makes zero adapter calls', async () => {
  let calls = 0;
  const adapter: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: () => {
      calls++;
      throw new Error('must not be called');
    },
  };
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: { PI_SEARCH_FETCH_BACKENDS: 'firecrawl' },
    timeoutMs: 15_000,
  };
  const result = await fetchExternalReadablePage(input, [adapter]);
  assert.equal(result.page, undefined);
  assert.equal(calls, 0);
});

test('external fetch tries backends in order and stops at first valid page', async () => {
  const order: string[] = [];
  const first: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: () => {
      order.push('firecrawl');
      throw new Error('HTTP 503 for https://example.com/page');
    },
  };
  const page: WebFetchedPage = {
    url: 'https://example.com/page',
    title: 'Example',
    content: 'readable text',
    backend: 'jina',
    externalProcessing: true,
    generatedText: [],
  };
  const second: WebFetchAdapter = {
    id: 'jina',
    configured: () => true,
    fetch: async () => {
      order.push('jina');
      return page;
    },
  };
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina' },
    timeoutMs: 15_000,
  };
  const result = await fetchExternalReadablePage(input, [first, second]);
  assert.deepEqual(order, ['firecrawl', 'jina']);
  assert.equal(result.page, page);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.backend, 'firecrawl');
});

test('external fetch stops after first valid page, never calls later backends', async () => {
  let secondCalls = 0;
  const page: WebFetchedPage = {
    url: 'https://example.com/page',
    title: 'Example',
    content: 'readable text',
    backend: 'firecrawl',
    externalProcessing: true,
    generatedText: [],
  };
  const first: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: async () => page,
  };
  const second: WebFetchAdapter = {
    id: 'jina',
    configured: () => true,
    fetch: () => {
      secondCalls++;
      throw new Error('must not be called');
    },
  };
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina' },
    timeoutMs: 15_000,
  };
  const result = await fetchExternalReadablePage(input, [first, second]);
  assert.equal(result.page, page);
  assert.equal(secondCalls, 0);
  assert.deepEqual(result.failures, []);
});

test('external fetch skips empty pages and continues, aborts without further calls', async () => {
  const order: string[] = [];
  const empty: WebFetchedPage = {
    url: 'https://example.com/page',
    title: '',
    content: '   ',
    backend: 'firecrawl',
    externalProcessing: true,
    generatedText: [],
  };
  const second: WebFetchAdapter = {
    id: 'jina',
    configured: () => true,
    fetch: () => {
      order.push('jina');
      throw new Error('must not be called after abort');
    },
  };
  const controller = new AbortController();
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina' },
    timeoutMs: 15_000,
    signal: controller.signal,
  };
  // Abort lands after the first attempt resolves: patch fetch to abort mid-flight.
  const abortingFirst: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: async () => {
      order.push('firecrawl');
      controller.abort();
      return empty;
    },
  };
  const result = await fetchExternalReadablePage(input, [abortingFirst, second]);
  assert.equal(result.page, undefined);
  assert.deepEqual(order, ['firecrawl']);
});

test('external fetch validates policy before any adapter call', async () => {
  let calls = 0;
  const adapter: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: () => {
      calls++;
      throw new Error('must not be called');
    },
  };
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,firecrawl' },
    timeoutMs: 15_000,
  };
  await assert.rejects(() => fetchExternalReadablePage(input, [adapter]), /duplicate/);
  assert.equal(calls, 0);
});

test('external fetch passes bounded policy timeout to adapters', async () => {
  let seenTimeout = 0;
  const adapter: WebFetchAdapter = {
    id: 'firecrawl',
    configured: () => true,
    fetch: async (fetchInput) => {
      seenTimeout = fetchInput.timeoutMs;
      return {
        url: 'https://example.com/page',
        title: '',
        content: 'text',
        backend: 'firecrawl',
        externalProcessing: true,
        generatedText: [],
      };
    },
  };
  const input: WebFetchAdapterInput = {
    url: 'https://example.com/page',
    env: {
      PI_SEARCH_EXTERNAL_FETCH: '1',
      PI_SEARCH_FETCH_BACKENDS: 'firecrawl',
      PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS: '20000',
    },
    timeoutMs: 1_000,
  };
  await fetchExternalReadablePage(input, [adapter]);
  assert.equal(seenTimeout, 20000);
});

test('fetch policy skips unconfigured adapters with diagnostic, never adds others', () => {
  const policy = resolveWebFetchPolicy(
    { PI_SEARCH_EXTERNAL_FETCH: '1', PI_SEARCH_FETCH_BACKENDS: 'firecrawl,jina' },
    [fakeAdapter('firecrawl', { configured: true }), fakeAdapter('jina', { configured: false })],
  );
  assert.deepEqual(policy.providers, ['firecrawl']);
  assert.deepEqual(policy.unavailable, ['jina']);
});
