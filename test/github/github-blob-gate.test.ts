import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GITHUB_ENTITY_CONTENT_MAX } from '../../src/github/github-contract.js';
import { callGithubTool } from '../../src/github/github-domain.js';
import { SocialError } from '../../src/social/social-contract.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
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
    return error as SocialError;
  }
  throw new Error(`expected SocialError(${code}), but nothing threw`);
}

function fileRow(content: string, encoding = 'base64') {
  return {
    type: 'file',
    path: 'src/a.ts',
    html_url: 'https://github.com/o/r/blob/main/src/a.ts',
    size: content.length,
    content,
    encoding,
  };
}

const fileMock = (row: Record<string, unknown>): FetchMock => async () => jsonResponse(row);

test('binary base64 (NUL bytes) omits content, keeps metadata', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const result = await withFetch(fileMock(fileRow(png.toString('base64'))), () =>
    callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }, { env: {} }),
  );
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.kind, 'file');
  assert.equal(entities[0]?.content, undefined);
  assert.equal(entities[0]?.path, 'src/a.ts');
});

test('oversize base64 rejects pre-decode without echoing content', async () => {
  const big = Buffer.from('x'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1000)).toString('base64');
  const err = await expectGithubError(
    'upstream_error',
    () => withFetch(fileMock(fileRow(big)), () => callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }, { env: {} })),
  );
  assert.match(err.message, new RegExp(String(GITHUB_ENTITY_CONTENT_MAX)));
  assert.ok(!err.message.includes('x'.repeat(33)), 'content echoed into error');
});

test('UTF-8 byte accounting rejects multibyte text inside char count', async () => {
  // 5000 chars but 10000 bytes: char counting would pass, byte accounting rejects.
  const text = 'é'.repeat(5000);
  assert.ok(text.length <= GITHUB_ENTITY_CONTENT_MAX, 'test premise: chars fit, bytes do not');
  const err = await expectGithubError(
    'upstream_error',
    () => withFetch(fileMock(fileRow(Buffer.from(text).toString('base64'))), () =>
      callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }, { env: {} })),
  );
  assert.match(err.message, /exceeds maximum/);
});

test('oversize non-base64 payload rejects instead of slicing', async () => {
  const err = await expectGithubError(
    'upstream_error',
    () => withFetch(fileMock(fileRow('y'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1), 'utf8')), () =>
      callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }, { env: {} })),
  );
  assert.match(err.message, /exceeds maximum/);
  assert.ok(!err.message.includes('y'.repeat(33)), 'content echoed into error');
});

test('small base64 still decodes (control)', async () => {
  const result = await withFetch(fileMock(fileRow(Buffer.from('hello').toString('base64'))), () =>
    callGithubTool({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }, { env: {} }),
  );
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.content, 'hello');
  assert.equal(entities[0]?.encoding, 'utf8');
});

test('truncation-to-reject: oversize issue body rejects the request', async () => {
  const issue = {
    id: 9, number: 12, title: 'bug', state: 'open',
    user: { login: 'octo' }, html_url: 'https://github.com/o/r/issues/12',
    body: 'b'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1), labels: [], created_at: '2024-01-01T00:00:00Z',
  };
  const err = await expectGithubError(
    'upstream_error',
    () => withFetch(async () => jsonResponse(issue), () =>
      callGithubTool({ action: 'issues', owner: 'o', repo: 'r', number: 12 }, { env: {} })),
  );
  assert.match(err.message, /issue body/);
});

test('truncation-to-reject: oversize repo description rejects the request', async () => {
  const repo = {
    id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r',
    description: 'd'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1),
  };
  const err = await expectGithubError(
    'upstream_error',
    () => withFetch(async (input) => {
      const url = String(input);
      if (url.endsWith('/repos/o/r')) return jsonResponse(repo);
      if (url.endsWith('/repos/o/r/readme')) throw new Error('readme must not be fetched after reject');
      throw new Error(`unexpected fetch ${url}`);
    }, () => callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: {} })),
  );
  assert.match(err.message, /repo description/);
});

test('invalid-base64 readme degrades to absent instead of decoding', async () => {
  const repo = { id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' };
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/o/r')) return jsonResponse(repo);
    if (url.endsWith('/repos/o/r/readme')) return jsonResponse({ content: '!!!not-base64!!!', encoding: 'base64' });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.readme, undefined);
});

test('binary (NUL) readme degrades to absent, keeps repo metadata', async () => {
  const repo = { id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' };
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/o/r')) return jsonResponse(repo);
    if (url.endsWith('/repos/o/r/readme')) return jsonResponse({ content: png.toString('base64'), encoding: 'base64' });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.readme, undefined);
  assert.equal(entities[0]?.full_name, 'o/r');
});
test('oversize readme degrades to absent instead of truncating', async () => {
  const repo = { id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r' };
  const big = Buffer.from('r'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1)).toString('base64');
  const result = await withFetch(async (input) => {
    const url = String(input);
    if (url.endsWith('/repos/o/r')) return jsonResponse(repo);
    if (url.endsWith('/repos/o/r/readme')) return jsonResponse({ content: big, encoding: 'base64' });
    throw new Error(`unexpected fetch ${url}`);
  }, () => callGithubTool({ action: 'repo', owner: 'o', repo: 'r' }, { env: {} }));
  const entities = (result.details as Record<string, unknown>).entities as Array<Record<string, unknown>>;
  assert.equal(entities[0]?.readme, undefined);
});
