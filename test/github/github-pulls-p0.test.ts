import assert from 'node:assert/strict';
import { test } from 'node:test';
import { callGithubTool } from '../../src/github/github-domain.js';
import {
  decodeGithubCursor,
  encodeGithubCursor,
  githubCursorFingerprint,
} from '../../src/github/github-contract.js';
import {
  validateGithubActionFields,
  validateGithubRequest,
} from '../../src/github/github-request-contract.js';
import { SocialError } from '../../src/social/social-contract.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response> | Response;

async function withFetch<T>(mock: FetchMock, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

async function expectGithubError(code: string, fn: () => Promise<unknown>): Promise<SocialError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}), but nothing threw`);
}

function expectInvalidRequest(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof SocialError && error.code === 'invalid_request');
}

// ── P0(1): pulls labels must reject, never silently drop ──
// Upstream truth: GET /repos/{owner}/{repo}/pulls has no labels parameter
// (labels filtering lives on the issues list endpoint), so pulls+labels
// rejects invalid_request at the contract layer instead of listing unfiltered.

test('pulls rejects labels at the contract layer', () => {
  expectInvalidRequest(() =>
    validateGithubActionFields({ action: 'pulls', owner: 'o', repo: 'r', labels: ['bug'] }, 'pulls'),
  );
  expectInvalidRequest(() =>
    validateGithubRequest({ action: 'pulls', owner: 'o', repo: 'r', labels: ['bug'] }),
  );
  // issues keeps labels.
  const { request } = validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', labels: ['bug'] });
  assert.deepEqual(request.labels, ['bug']);
});

test('pulls list with labels rejects before fetch (no silent drop)', async () => {
  let fetched = false;
  await expectGithubError(
    'invalid_request',
    () =>
      withFetch(async () => {
        fetched = true;
        return jsonResponse([]);
      }, () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', labels: ['bug'] }, { env: {} })),
  );
  assert.equal(fetched, false, 'labels rejection must happen before fetch');
});

// ── P0(3): pulls files=true without number must reject, not list ──

test('pulls files=true without number rejects before fetch', async () => {
  expectInvalidRequest(() => validateGithubRequest({ action: 'pulls', owner: 'o', repo: 'r', files: true }));
  let fetched = false;
  await expectGithubError(
    'invalid_request',
    () =>
      withFetch(async () => {
        fetched = true;
        return jsonResponse([]);
      }, () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', files: true }, { env: {} })),
  );
  assert.equal(fetched, false, 'files-without-number must reject before fetch');
});

// ── P0(2): cursor fingerprint pins state, labels, files ──

function pullsListMock(requested: string[]): FetchMock {
  return async (input) => {
    requested.push(String(input));
    const page = /[?&]page=2(?:&|$)/.test(String(input)) ? 2 : 1;
    if (page === 1) {
      return jsonResponse([{ number: 1, title: 'a', state: 'open' }], 200, {
        Link: '<https://api.github.com/repos/o/r/pulls?per_page=20&page=2>; rel="next"',
      });
    }
    return jsonResponse([{ number: 2, title: 'b', state: 'open' }]);
  };
}

test('pulls cursor pins state', async () => {
  const requested: string[] = [];
  const first = await withFetch(pullsListMock(requested), () =>
    callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', state: 'open' }, { env: {} }),
  );
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);

  // Same state round-trips.
  requested.length = 0;
  const second = await withFetch(pullsListMock(requested), () =>
    callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', state: 'open', cursor }, { env: {} }),
  );
  assert.match(requested[0] ?? '', /page=2/);
  const entities = (second.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.number, 2);

  // Changed state fails closed before fetch.
  let fetched = false;
  await expectGithubError(
    'cursor_invalid',
    () =>
      withFetch(async () => {
        fetched = true;
        return jsonResponse([]);
      }, () => callGithubTool({ action: 'pulls', owner: 'o', repo: 'r', state: 'closed', cursor }, { env: {} })),
  );
  assert.equal(fetched, false, 'state change must reject before fetch');
});

function issuesListMock(requested: string[]): FetchMock {
  return async (input) => {
    requested.push(String(input));
    const page = /[?&]page=2(?:&|$)/.test(String(input)) ? 2 : 1;
    if (page === 1) {
      return jsonResponse([{ number: 1, title: 'a', state: 'open' }], 200, {
        Link: '<https://api.github.com/repos/o/r/issues?per_page=20&page=2>; rel="next"',
      });
    }
    return jsonResponse([{ number: 2, title: 'b', state: 'open' }]);
  };
}

test('issues cursor pins labels', async () => {
  const requested: string[] = [];
  const first = await withFetch(issuesListMock(requested), () =>
    callGithubTool({ action: 'issues', owner: 'o', repo: 'r', labels: ['bug'] }, { env: {} }),
  );
  const cursor = (first.details as { pagination: { nextCursor?: string } }).pagination.nextCursor;
  assert.ok(typeof cursor === 'string' && cursor.length > 0);
  assert.match(requested[0] ?? '', /labels=bug/);

  // Same labels round-trip.
  requested.length = 0;
  await withFetch(issuesListMock(requested), () =>
    callGithubTool({ action: 'issues', owner: 'o', repo: 'r', labels: ['bug'], cursor }, { env: {} }),
  );
  assert.match(requested[0] ?? '', /page=2/);

  // Changed labels fail closed before fetch.
  let fetched = false;
  await expectGithubError(
    'cursor_invalid',
    () =>
      withFetch(async () => {
        fetched = true;
        return jsonResponse([]);
      }, () => callGithubTool({ action: 'issues', owner: 'o', repo: 'r', labels: ['other'], cursor }, { env: {} })),
  );
  assert.equal(fetched, false, 'labels change must reject before fetch');
});

test('fingerprint distinguishes state, labels, and files', () => {
  const base = { action: 'pulls' as const, owner: 'o', repo: 'r', limit: 20 };
  const open = githubCursorFingerprint({ ...base, state: 'open' });
  const closed = githubCursorFingerprint({ ...base, state: 'closed' });
  assert.notEqual(open, closed);
  const bug = githubCursorFingerprint({ ...base, state: 'open', labels: ['bug'] });
  const other = githubCursorFingerprint({ ...base, state: 'open', labels: ['other'] });
  assert.notEqual(bug, other);
  // Join-collision guard: ['a,b'] must not fingerprint like ['a', 'b'].
  const joined = githubCursorFingerprint({ ...base, labels: ['a,b'] });
  const split = githubCursorFingerprint({ ...base, labels: ['a', 'b'] });
  assert.notEqual(joined, split);
  const plain = githubCursorFingerprint({ ...base });
  const withFiles = githubCursorFingerprint({ ...base, files: true });
  assert.notEqual(plain, withFiles);
  // A cursor encoded under one fingerprint fails closed under another.
  const cursor = encodeGithubCursor({ action: 'pulls', backend: 'github-api', fingerprint: open, state: { page: 2 } });
  assert.throws(
    () => decodeGithubCursor(cursor, { action: 'pulls', backend: 'github-api', fingerprint: closed }),
    (error: unknown) => error instanceof SocialError && error.code === 'cursor_mismatch',
  );
});
