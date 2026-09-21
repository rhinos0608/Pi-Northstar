import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callNativeTool } from '../src/native-tools.js';
import { sanitizeDiagnosticMessage, scrubDiagnosticSecrets } from '../src/core/diagnostic-sanitizer.js';
import { executeFetchRead } from '../src/commands/fetch-read-handler.js';
import { createCommandContext } from '../src/commands/command-context.js';
import type { NorthstarResultV1 } from '../src/result-contract.js';
import { snippetOf } from '../src/native-fetch.js';

test('diagnostic-sanitizer: scrubs auth headers, full cookies, query secrets, narrow userinfo, env labels', () => {
  const cases = [
    {
      name: 'Bearer header',
      input: 'Request failed with Authorization: Bearer secret-token-123456 at endpoint',
      notExpected: 'secret-token-123456',
      expected: 'Authorization: ***',
    },
    {
      name: 'Full Cookie header with multiple pairs',
      input: 'Failed with Cookie: session_id=abcdef123456; csrf=secret_token; extra=val\nNext line',
      notExpected: 'abcdef123456',
      expected: 'Cookie: ***\nNext line',
    },
    {
      name: 'Full Set-Cookie header',
      input: 'Header Set-Cookie: id=secret_cookie_val; Secure; HttpOnly; SameSite=Strict',
      notExpected: 'secret_cookie_val',
      expected: 'Set-Cookie: ***',
    },
    {
      name: 'URL userinfo http(s)',
      input: 'Failed to fetch https://user:super_secret_pw@internal.example.com/api',
      notExpected: 'super_secret_pw',
      expected: 'https://***:***@internal.example.com',
    },
    {
      name: 'Protocol-relative URL userinfo',
      input: 'Failed to fetch //user:super_secret_pw@example.com/path',
      notExpected: 'super_secret_pw',
      expected: '//***:***@',
    },
    {
      name: 'Non-URL userinfo retained (e.g. build@runner)',
      input: 'Worker //build@runner finished job',
      notExpected: 'SOMETHING_ELSE',
      expected: '//build@runner',
    },
    {
      name: 'URL query parameter token',
      input: 'Failed URL: https://api.example.com/data?token=my_secret_token&user=bob',
      notExpected: 'my_secret_token',
      expected: '?token=***',
    },
    {
      name: 'URL query parameter percent-encoded %74oken',
      input: 'Failed URL: https://api.example.com/data?%74oken=secret_encoded_token&user=bob',
      notExpected: 'secret_encoded_token',
      expected: '?%74oken=***',
    },
    {
      name: 'URL query parameter percent-encoded access%5Ftoken',
      input: 'Failed URL: https://api.example.com/data?access%5Ftoken=secret_encoded_access&user=bob',
      notExpected: 'secret_encoded_access',
      expected: '?access%5Ftoken=***',
    },
    {
      name: 'URL query parameter malformed percent encoding fails closed on that param only',
      input: 'Failed URL: https://api.example.com/data?bad%E0%A4=secret_bad_utf8&user=bob',
      notExpected: 'secret_bad_utf8',
      expected: 'user=bob',
    },
    {
      name: 'Common env credential label',
      input: 'Backend error: GITHUB_TOKEN=ghp_ABC123XYZ in environment',
      notExpected: 'ghp_ABC123XYZ',
      expected: 'GITHUB_TOKEN=***',
    },
  ];

  for (const c of cases) {
    const sanitized = sanitizeDiagnosticMessage(c.input);
    assert.ok(!sanitized.includes(c.notExpected), `Leaked secret in [${c.name}]: ${sanitized}`);
    assert.ok(sanitized.includes(c.expected), `Expected scrubbed pattern in [${c.name}]: ${sanitized}`);
  }
});

test('diagnostic-sanitizer: scrubDiagnosticSecrets scrubs across full text without length reduction', () => {
  const bigSecretText = 'Header start with Authorization: Bearer secret_12345 ' + 'a'.repeat(700) + ' and Cookie: session=cookie_secret_val end of body';
  const scrubbed = scrubDiagnosticSecrets(bigSecretText);
  assert.ok(!scrubbed.includes('secret_12345'), 'no bearer secret');
  assert.ok(!scrubbed.includes('cookie_secret_val'), 'no cookie secret');
  assert.ok(scrubbed.includes('end of body'), 'tail of >500 byte content is preserved');
  assert.ok(scrubbed.length > 700, 'unbounded length retained');
});

test('native-fetch: snippetOf bounds by UTF-8 bytes and preserves multibyte characters', () => {
  const ascii = 'a'.repeat(600);
  assert.equal(Buffer.byteLength(snippetOf(ascii), 'utf8'), 500);

  // 4-byte UTF-8 emoji repeated
  const emoji = '🔥'.repeat(150); // 4 bytes each = 600 bytes
  const snipped = snippetOf(emoji);
  const snippedBytes = Buffer.byteLength(snipped, 'utf8');
  assert.ok(snippedBytes <= 500);
  assert.equal(snippedBytes % 4, 0, 'did not split 4-byte UTF-8 codepoint');
});

test('native-fetch: multi-URL error diagnostics scrub secrets from content, entries, northstar errors, and command result', async () => {
  const rawErrorMessage = 'Upstream 502 with Authorization: Bearer super_secret_bearer_token and Cookie: session=cookie_secret_val; csrf=cookie_secret_val_2 for GITHUB_TOKEN=ghp_secret_env and URL query ?token=super_secret_query_val&api_key=my_key_secret';

  const res = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/ok', 'https://example.com/error'] },
    {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchPageText: async (url: string) => {
        if (url.includes('error')) throw new Error(rawErrorMessage);
        return '<html><body><p>Normal good page</p></body></html>';
      },
    } as unknown as Parameters<typeof callNativeTool>[2],
  );

  const serialized = JSON.stringify(res);

  // Assert secrets absent from content, entries, northstar errors, command result
  assert.ok(!serialized.includes('super_secret_query_val'), 'no query secret in result');
  assert.ok(!serialized.includes('my_key_secret'), 'no api_key secret in result');
  assert.ok(!serialized.includes('super_secret_bearer_token'), 'no bearer token in result');
  assert.ok(!serialized.includes('cookie_secret_val'), 'no cookie secret in result');
  assert.ok(!serialized.includes('cookie_secret_val_2'), 'no cookie csrf secret in result');
  assert.ok(!serialized.includes('ghp_secret_env'), 'no env secret in result');
  assert.ok(!serialized.includes('"stack"'), 'no stack in result');

  // Assert useful diagnostic retained
  assert.match(serialized, /Upstream 502/);
  assert.match(serialized, /Authorization: \*\*\*/);
  assert.match(serialized, /Cookie: \*\*\*/);
  assert.match(serialized, /GITHUB_TOKEN=\*\*\*/);

  // Details entries check
  const details = res.details as Record<string, unknown>;
  const entries = details.entries as Array<{ url: string; status: string; error?: { message: string } }>;
  assert.equal(entries[1]!.status, 'error');
  assert.ok(!entries[1]!.error!.message.includes('super_secret_bearer_token'));
  assert.match(entries[1]!.error!.message, /Upstream 502/);

  // Canonical northstar errors check
  const northstar = details.northstar as { errors: Array<{ message: string }> };
  assert.ok(!northstar.errors[0]!.message.includes('super_secret_bearer_token'));
  assert.match(northstar.errors[0]!.message, /Upstream 502/);

  // Northstar command result error check
  const commandResult = details.northstarCommand as { error?: { message: string } };
  assert.ok(!commandResult.error?.message.includes('super_secret_bearer_token'));
  assert.match(commandResult.error?.message ?? '', /Upstream 502/);
});

test('native-fetch: two identical upstream error inputs survive in order without collapse', async () => {
  const rawErrorMessage = 'Upstream 502 with Authorization: Bearer secret_bearer_val and Cookie: auth_token=secret_cookie_val';

  const res = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/err1', 'https://example.com/err2'] },
    {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchPageText: async () => {
        throw new Error(rawErrorMessage);
      },
    } as unknown as Parameters<typeof callNativeTool>[2],
  );

  const serialized = JSON.stringify(res);
  assert.ok(!serialized.includes('secret_bearer_val'), 'no bearer secret');
  assert.ok(!serialized.includes('secret_cookie_val'), 'no cookie secret');

  const details = res.details as Record<string, unknown>;
  const canonical = details.northstar as NorthstarResultV1;

  // Multiplicity preserved: both identical upstream errors survive in encounter order
  assert.equal(canonical.errors.length, 2, 'both identical upstream errors survive without collapse');
  assert.equal(canonical.errors[0]!.code, canonical.errors[1]!.code);
  assert.equal(canonical.errors[0]!.message, canonical.errors[1]!.message);
  assert.ok(canonical.errors[0]!.message.includes('Authorization: ***'));

  // Sources survive with their multiplicity and statuses
  assert.equal(canonical.sources.length, 2);
  assert.equal(canonical.sources[0]!.status, 'error');
  assert.equal(canonical.sources[1]!.status, 'error');

  // Pure error response: no responseId should be issued
  assert.equal(details.responseId, undefined, 'no responseId when all URLs fail');
});

test('native-fetch: partial status retains >500 byte content tail while scrubbing embedded secrets, remains non-cacheable', async () => {
  const longTail = 'Tail marker: legitimate partial report content ' + 'x'.repeat(600) + ' end-of-partial-data';

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('api.github.com/repos/testorg/testrepo/issues/42')) {
      return new Response(JSON.stringify({
        id: 42, number: 42, title: 'Sample Issue',
        body: `Header Authorization: Bearer secret_partial_token and Cookie: session=cookie_secret_partial\n${longTail}`,
        user: { login: 'octocat' }, created_at: '2023-01-01T00:00:00Z',
        html_url: 'https://github.com/testorg/testrepo/issues/42', state: 'open', comments: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(url);
  };

  try {
    const res = await callNativeTool(
      'fetch',
      { urls: ['https://github.com/testorg/testrepo/issues/42'] },
      {
        env: {},
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      } as unknown as Parameters<typeof callNativeTool>[2],
    );

    const serialized = JSON.stringify(res);

    // Assert secrets absent everywhere
    assert.ok(!serialized.includes('secret_partial_token'), 'no partial bearer secret in output');
    assert.ok(!serialized.includes('cookie_secret_partial'), 'no partial cookie secret in output');

    // Assert >500 byte tail preserved in content
    assert.ok(serialized.includes('end-of-partial-data'), 'tail of >500-byte partial body preserved');

    // Assert entry status is partial and non-cacheable
    const details = res.details as Record<string, unknown>;
    const entries = details.entries as Array<{ url: string; status: string }>;
    assert.equal(entries[0]!.status, 'partial');
    assert.equal(details.responseId, undefined, 'partial is non-cacheable: no responseId');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('native-fetch: cache policy excludes partial/error body from retrieve cache', async () => {
  // Sibling with ok body should cache, but failing sibling must be excluded
  const res = await callNativeTool(
    'fetch',
    { urls: ['https://example.com/success', 'https://example.com/fail'] },
    {
      env: {},
      lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
      fetchPageText: async (url: string) => {
        if (url.includes('fail')) throw new Error('failure for https://example.com/fail');
        return '<html><body><p>Clean success content body</p></body></html>';
      },
    } as unknown as Parameters<typeof callNativeTool>[2],
  );

  const details = res.details as Record<string, unknown>;
  const responseId = details.responseId as string;
  assert.ok(typeof responseId === 'string' && responseId.length > 0, 'successful sibling creates responseId');

  // Query retrieve cache
  const retrieved = await callNativeTool('fetch', { action: 'retrieve', responseId }, { env: {} });
  const retrievedText = JSON.stringify(retrieved);
  assert.ok(retrievedText.includes('Clean success content body'), 'success content is in retrieve corpus');
  assert.ok(!retrievedText.includes('failure for https://example.com/fail'), 'error body excluded from retrieve corpus');
});

test('fetch-read-handler: authentication required classifies as nonretryable auth, not invalid_input', async () => {
  const ctx = createCommandContext({ surface: 'test', env: {} });
  const failing = {
    ...ctx,
    lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchPageText: async () => {
      throw new Error('authentication required for this resource');
    },
  };

  const res = await executeFetchRead({ urls: ['https://example.com/auth-needed'] }, failing);
  const commandResult = (res.details as Record<string, unknown>).northstarCommand as {
    outcome: string;
    error?: { code: string; retryable: boolean; category: string };
  };

  assert.equal(commandResult.outcome, 'failed');
  assert.equal(commandResult.error?.code, 'backend_http_error');
  assert.equal(commandResult.error?.retryable, false);
});

test('native-fetch: multi-URL preserves GitHub canonical specialist entity and provenance', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.github.com')) {
      return new Response(JSON.stringify({
        id: 42, number: 42, title: 'Sample Northstar Issue', body: 'Issue description body',
        user: { login: 'octocat' }, created_at: '2023-01-01T00:00:00Z',
        html_url: 'https://github.com/testorg/testrepo/issues/42', state: 'open', comments: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(url);
  };

  try {
    const res = await callNativeTool(
      'fetch',
      { urls: ['https://example.com/normal', 'https://github.com/testorg/testrepo/issues/42'] },
      {
        env: {},
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        fetchPageText: async () => '<html><body><p>Normal web page text</p></body></html>',
      } as unknown as Parameters<typeof callNativeTool>[2],
    );

    const details = res.details as Record<string, unknown>;
    const canonical = details.northstar as {
      status: string;
      sources: Array<{ source: string; backend: string; status: string }>;
      data: { entities: Array<{ source: string; id: string; title: string }> };
    };

    assert.ok(canonical !== undefined, 'canonical envelope exists');
    assert.ok(Array.isArray(canonical.sources), 'sources array exists');

    // Provenance preserved from specialist
    const sources = canonical.sources.map((s) => s.source);
    assert.ok(sources.includes('web'), 'web source exists');
    assert.ok(sources.includes('github'), 'github specialist provenance preserved');

    // Entities preserved from specialist exactly once
    const githubEntities = canonical.data.entities.filter((e) => e.source === 'github');
    assert.equal(githubEntities.length, 1, 'entity preserved exactly once');
    assert.equal(githubEntities[0]?.id, 'github:issue:testorg/testrepo#42');
    assert.match(githubEntities[0]?.title ?? '', /Sample Northstar Issue/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('native-fetch: multi-URL preserves degraded specialist status and truthful entry status', async () => {
  // Test YouTube watch URL with opted in video analysis degrading
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('youtube.com/oembed')) {
      return new Response(JSON.stringify({
        title: 'Sample Video Title',
        author_name: 'Creator',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return origFetch(url);
  };

  try {
    const ctx = createCommandContext({ surface: 'test', env: { PI_VISION_FETCH_VIDEO_FRAMES: '1' } });
    const res = await executeFetchRead(
      { urls: ['https://example.com/normal', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'] },
      {
        ...ctx,
        lookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
        fetchPageText: async () => '<html><body><p>Normal web page text</p></body></html>',
      },
    );

    const details = res.details as Record<string, unknown>;
    const entries = details.entries as Array<{ url: string; status: string }>;
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.status, 'ok');
    // Degraded specialist truth reflected in entry status and command outcome
    const commandResult = details.northstarCommand as { outcome: string };
    assert.equal(entries[1]!.status, 'degraded');
    assert.equal(commandResult.outcome, 'degraded');
  } finally {
    globalThis.fetch = origFetch;
  }
});
