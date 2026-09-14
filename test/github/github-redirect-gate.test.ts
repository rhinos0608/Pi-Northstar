import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callGithubTool } from '../../src/github/github-domain.js';
import { SocialError } from '../../src/social/social-contract.js';

const TOKEN = 'secret-token-xyz';

function redirectResponse(): Response {
  return new Response(null, {
    status: 302,
    headers: { location: 'https://evil.example/harvest' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function expectGithubError(code: string, fn: () => Promise<unknown>): Promise<SocialError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error as SocialError;
  }
  throw new Error(`expected SocialError(${code}), but nothing threw`);
}

test('authenticated API redirect rejects without leaking token or URL', async () => {
  const seen: RequestInit[] = [];
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    return redirectResponse();
  }) as typeof fetch;
  try {
    const err = await expectGithubError('upstream_error', () =>
      callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: { GITHUB_TOKEN: TOKEN } }),
    );
    assert.match(err.message, /redirect rejected/);
    assert.ok(!err.message.includes(TOKEN), 'token leaked into error');
    assert.ok(!err.message.includes('evil.example'), 'redirect target leaked into error');
    assert.ok(!err.message.includes('api.github.com'), 'request URL leaked into error');
    // Credentialed path proven: bearer rode the request, manual redirect mode on.
    const headers = new Headers(seen[0]?.headers as HeadersInit);
    assert.ok((headers.get('authorization') ?? '').startsWith('Bearer '), 'expected bearer on rejected hop');
    assert.equal(seen[0]?.redirect, 'manual');
    assert.equal(seen.length, 1, 'redirect must never be followed with a second fetch');
  } finally {
    globalThis.fetch = saved;
  }
});

test('anonymous redirect also rejects fail-closed and never follows', async () => {
  let calls = 0;
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls++;
    return redirectResponse();
  }) as typeof fetch;
  try {
    const err = await expectGithubError('upstream_error', () =>
      callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: {} }),
    );
    assert.match(err.message, /redirect rejected/);
    assert.equal(calls, 1, 'redirect must never be followed');
  } finally {
    globalThis.fetch = saved;
  }
});

test('304 Not Modified is not a credential-forwarding redirect (flows, never rejects)', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 304 })) as typeof fetch;
  try {
    const { isRedirectStatus } = await import('../../src/core/http.js');
    assert.equal(isRedirectStatus(304), false);
    assert.equal(isRedirectStatus(302), true);
    assert.equal(isRedirectStatus(200), false);
  } finally {
    globalThis.fetch = saved;
  }
});

test('non-redirect API responses still flow (control)', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/repos/o/r')) {
      return jsonResponse({ id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' });
    }
    if (url.endsWith('/repos/o/r/readme')) {
      return jsonResponse({ content: Buffer.from('hi').toString('base64'), encoding: 'base64' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const result = await callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: { GITHUB_TOKEN: TOKEN } });
    const text = JSON.stringify(result.details);
    assert.ok(!text.includes(TOKEN), 'token leaked into result');
    const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
    assert.equal(entities[0]?.full_name, 'o/r');
  } finally {
    globalThis.fetch = saved;
  }
});
