import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchInit, fetchJson, fetchJsonNoRedirect, fetchText, safeResponseText, validatePublicHttpUrl } from '../src/http.js';

test('validatePublicHttpUrl accepts public http/https and rejects private/reserved', () => {
  // Public URLs accepted
  assert.equal(validatePublicHttpUrl('https://example.com/path'), 'https://example.com/path');
  assert.equal(validatePublicHttpUrl('https://api.github.com/repos'), 'https://api.github.com/repos');
  assert.equal(validatePublicHttpUrl('http://8.8.8.8/'), 'http://8.8.8.8/');

  // Credentials rejected
  assert.throws(() => validatePublicHttpUrl('http://user:password@example.com/'), /credentials/);
  assert.throws(() => validatePublicHttpUrl('http://user@example.com/'), /credentials/);
  // Private/reserved hostnames rejected
  assert.throws(() => validatePublicHttpUrl('http://localhost:3000/'), /Blocked hostname/);
  assert.throws(() => validatePublicHttpUrl('http://10.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://192.168.1.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://127.0.0.1/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://169.254.169.254/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://metadata.google.internal/'), /Blocked hostname/);
  assert.throws(() => validatePublicHttpUrl('http://[fd00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://[fc00::1]/'), /Private\/reserved/);
  assert.throws(() => validatePublicHttpUrl('http://100.64.0.1/'), /Private\/reserved/);

  // Non-HTTP schemes rejected
  assert.throws(() => validatePublicHttpUrl('ftp://example.com'), /scheme/);
  assert.throws(() => validatePublicHttpUrl('file:///etc/passwd'), /scheme/);
});

test('fetchInit rejects non-ByteString header values before fetch', () => {
  // Synthetic fixture: U+FFFD from a lossy cookie decode must fail fast with a
  // nameable error, not a cryptic undici ByteString TypeError at request time.
  assert.throws(() => fetchInit({ Cookie: 'session=\uFFFDabc' }, undefined), /non-latin1/);
  assert.doesNotThrow(() => fetchInit({ Cookie: 'session=ok; token=v1' }, undefined));
});

test('safeResponseText rejects content-length over cap', async () => {
  const response = new Response('', { headers: { 'content-length': '10' } });
  await assert.rejects(() => safeResponseText(response, 'https://example.com', 5), /too large/);
});

test('fetchText rejects initial private DNS without fetching (shared helper preflight)', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async () => {
    fetchCalls++;
    return new Response('unreachable');
  };
  try {
    await assert.rejects(
      () =>
        fetchText('https://initial-private.example/page', {}, undefined, undefined, async () => [
          { address: '10.0.0.1', family: 4 },
        ]),
      /private\/reserved/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});

test('fetchText rejects redirect hop to private DNS without fetching the target', async () => {
  const fetched: string[] = [];
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = async (input: unknown) => {
    fetched.push(String(input));
    return new Response('', { status: 302, headers: { location: 'https://redirect-private.example/loot' } });
  };
  try {
    await assert.rejects(
      () =>
        fetchText('https://example.com/start', {}, undefined, undefined, async (host: string) => {
          if (host === 'redirect-private.example') return [{ address: '10.0.0.1', family: 4 }];
          return [{ address: '93.184.216.34', family: 4 }];
        }),
      /private\/reserved/,
    );
    assert.deepEqual(fetched, ['https://example.com/start']);
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});

test('fetchJsonNoRedirect preflights DNS and rejects private answers without fetching', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (async () => {
    fetchCalls++;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchJsonNoRedirect('https://private-dns.example/api', {}, undefined, undefined, async () => [
        { address: '10.0.0.1', family: 4 },
      ]),
      /private\/reserved/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});

test('fetchText strips credential headers on cross-origin hop, keeps them same-origin', async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    if (url === 'https://example.com/start') {
      return new Response('', { status: 302, headers: { location: '/same' } });
    }
    if (url === 'https://example.com/same') {
      return new Response('', { status: 302, headers: { location: 'https://other.example/cross' } });
    }
    return new Response('ok');
  }) as typeof fetch;
  try {
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 as const }];
    const text = await fetchText(
      'https://example.com/start',
      {
        Accept: 'application/json',
        Authorization: 'Bearer secret',
        'X-Subscription-Token': 'token-secret',
        'x-API-key': 'key-secret',
        Cookie: 'session=secret',
        'proxy-authorization': 'proxy-secret',
        'Set-Cookie': 'a=secret',
        'X-Custom': 'keep',
      },
      undefined,
      undefined,
      publicLookup,
    );
    assert.equal(text, 'ok');
    assert.equal(seen.length, 3);
    // Same-origin hop keeps everything.
    assert.equal(seen[1]!.headers.Authorization, 'Bearer secret');
    assert.equal(seen[1]!.headers.Cookie, 'session=secret');
    // Cross-origin hop strips credential-class headers (case-insensitive), keeps the rest.
    const cross = seen[2]!.headers;
    assert.equal(cross.Accept, 'application/json');
    assert.equal(cross['X-Custom'], 'keep');
    for (const name of Object.keys(cross)) {
      assert.ok(
        !['authorization', 'x-subscription-token', 'x-api-key', 'cookie', 'set-cookie', 'proxy-authorization'].includes(
          name.toLowerCase(),
        ),
        `credential header leaked cross-origin: ${name}`,
      );
    }
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});

test('fetchJson propagates caller abort as AbortError without DNS preflight', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  (globalThis as Record<string, unknown>).fetch = (async (_input: unknown, init?: RequestInit) => {
    fetchCalls++;
    if ((init?.signal as AbortSignal | undefined)?.aborted) throw new DOMException('Aborted', 'AbortError');
    return new Response('{}');
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    controller.abort();
    let dnsCalls = 0;
    await assert.rejects(
      () => fetchJson('https://example.com/data', {}, controller.signal, undefined, async () => {
        dnsCalls++;
        return [{ address: '93.184.216.34', family: 4 }];
      }),
      (err: unknown) => (err as DOMException).name === 'AbortError',
    );
    assert.equal(fetchCalls, 1);
    assert.equal(dnsCalls, 0, 'aborted signal must skip DNS preflight');
  } finally {
    (globalThis as Record<string, unknown>).fetch = originalFetch;
  }
});
