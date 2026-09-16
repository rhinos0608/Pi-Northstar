import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GITHUB_ACTIONS,
  GITHUB_BACKEND_PREFERENCE,
  GITHUB_ENTITY_CONTENT_MAX,
  GITHUB_PAGE_CONTENT_MAX,
  decodeGithubCursor,
  encodeGithubCursor,
  githubCursorFingerprint,
  githubPaginationSupported,
  orderGithubPlans,
  resolveGithubAction,
  resolveGithubAuthTier,
  resolveGithubLimit,
  validateGithubEntity,
  validateGithubPage,
  validateGithubPath,
  validateGithubRef,
  validateGithubRequest,
  validateGithubSha,
  type GithubAction,
  type GithubBackendPlan,
  type GithubEntityV1,
} from '../../src/github/github-contract.js';
import { SocialError } from '../../src/social/social-contract.js';
import type { GithubRequestInput } from '../../src/github/github-contract.js';
import {
  resolveGithubAction as resolveGithubActionDirect,
  resolveGithubLimit as resolveGithubLimitDirect,
  validateGithubPath as validateGithubPathDirect,
  validateGithubRequest as validateGithubRequestDirect,
} from '../../src/github/github-request-contract.js';
import {
  resolveGithubAction as resolveGithubActionFacade,
  resolveGithubLimit as resolveGithubLimitFacade,
  validateGithubPath as validateGithubPathFacade,
  validateGithubRequest as validateGithubRequestFacade,
} from '../../src/github/github-contract.js';

function githubError(code: string, run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error as SocialError;
  }
  throw new Error(`expected SocialError(${code}), but nothing threw`);
}

function plan(overrides: Partial<GithubBackendPlan> = {}): GithubBackendPlan {
  return {
    backend: 'github-api',
    authTier: 'env_var',
    pagination: 'cursor',
    degraded: false,
    quality: 'full',
    execute: async () => ({}),
    ...overrides,
  };
}

const REPO = { version: 1 as const, kind: 'repo' as const, id: 'octo:repo:1', backend: 'github-api', url: 'https://github.com/octo/kit' };

// ── Canonical actions ──

test('resolveGithubAction accepts all twelve canonical actions', () => {
  const expected = ['repo', 'file', 'tree', 'search', 'trending', 'issues', 'pulls', 'releases', 'commits', 'search_repos', 'workflows', 'runs'];
  assert.deepEqual([...GITHUB_ACTIONS], expected);
  for (const action of expected) assert.equal(resolveGithubAction(action), action);
});

test('resolveGithubAction rejects legacy and unknown actions with capped echo', () => {
  for (const legacy of ['list_dir', 'code_search', 'video']) {
    const err = githubError('unsupported_action', () => resolveGithubAction(legacy));
    assert.match(err.message, /Unsupported github action/);
  }
  const long = `x${'y'.repeat(100)}`;
  const err = githubError('unsupported_action', () => resolveGithubAction(long));
  assert.ok(err.message.length <= `Unsupported github action: ${'z'.repeat(32)}`.length);
  assert.ok(!err.message.includes('y'.repeat(33)));
});

// ── Owner/repo selectors ──

test('validateGithubRequest accepts owner/repo and repository slug', () => {
  const { request } = validateGithubRequest({ action: 'repo', owner: 'octo-cat_1.2', repo: 'kit.js' });
  assert.equal(request.owner, 'octo-cat_1.2');
  const slug = validateGithubRequest({ action: 'repo', repository: 'octo/kit' });
  assert.equal(slug.request.owner, 'octo');
  assert.equal(slug.request.repo, 'kit');
});

test('validateGithubRequest rejects missing owner/repo', () => {
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'octo' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', repository: 'octo' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', repository: 'a/b/c' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', repository: 'octo/' }));
});

test('validateGithubRequest rejects bad owner/repo charset, length, traversal, encodings', () => {
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'oc to', repo: 'kit' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'oc/to', repo: 'kit' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'octo@x', repo: 'kit' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'o'.repeat(40), repo: 'kit' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'octo', repo: 'r'.repeat(101) }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: 'oc..to', repo: 'kit' }));
  for (const encoded of ['%2F', '%2f', '%2E', '%2e', 'oc%41to']) {
    githubError('invalid_request', () => validateGithubRequest({ action: 'repo', owner: `oc${encoded}to`, repo: 'kit' }));
  }
});

// ── Path validation ──

test('validateGithubPath accepts normal paths, rejects traversal and confusion', () => {
  assert.equal(validateGithubPath('src/index.ts'), 'src/index.ts');
  for (const bad of ['../secret', 'a/../b', 'a..b/../c', '..']) {
    githubError('invalid_request', () => validateGithubPath(bad));
  }
  githubError('invalid_request', () => validateGithubPath('a\\b'));
  githubError('invalid_request', () => validateGithubPath('/leading'));
  githubError('invalid_request', () => validateGithubPath('trailing/'));
  githubError('invalid_request', () => validateGithubPath('a%2Fteste'));
  githubError('invalid_request', () => validateGithubPath('a%2eteste'));
  githubError('invalid_request', () => validateGithubPath('a//b'));
  githubError('invalid_request', () => validateGithubPath('p'.repeat(201)));
  githubError('invalid_request', () => validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', path: '   ' }));
});

// ── Ref validation ──

test('validateGithubRef accepts branches/tags, rejects git-dangerous spellings', () => {
  assert.equal(validateGithubRef('main'), 'main');
  assert.equal(validateGithubRef('feature/x-1.2'), 'feature/x-1.2');
  githubError('invalid_request', () => validateGithubRef('a..b'));
  githubError('invalid_request', () => validateGithubRef('-main'));
  githubError('invalid_request', () => validateGithubRef('a~1'));
  githubError('invalid_request', () => validateGithubRef('a^1'));
  githubError('invalid_request', () => validateGithubRef('a:b'));
  githubError('invalid_request', () => validateGithubRef('a\\b'));
  githubError('invalid_request', () => validateGithubRef('has space'));
  githubError('invalid_request', () => validateGithubRef('r'.repeat(201)));
  githubError('invalid_request', () =>
    validateGithubRequest({ action: 'tree', owner: 'o', repo: 'r', branch: 'a', ref: 'b' }),
  );
});

test('release tag rides validateGithubRef charset/traversal rules', () => {
  assert.equal(
    validateGithubRequest({ action: 'releases', owner: 'o', repo: 'r', tag: 'v1.0.0' }).request.tag,
    'v1.0.0',
  );
  for (const bad of ['../../tags', 'a..b', 'a\\b', 'a%2Fb', 'a%2fb', 'has space', 'a~1', 'a^1', 'a:b', '-v1']) {
    githubError('invalid_request', () =>
      validateGithubRequest({ action: 'releases', owner: 'o', repo: 'r', tag: bad }),
    );
  }
});

// ── Numbers, sha, since, query, labels ──

test('validateGithubRequest enforces positive-int numbers', () => {
  assert.equal(validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', number: 7 }).request.number, 7);
  for (const bad of [0, -1, 1.5, Number.NaN, '7'] as unknown[]) {
    githubError('invalid_request', () =>
      validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', number: bad as number }),
    );
  }
});

test('validateGithubSha accepts 7-40 hex, rejects rest', () => {
  assert.equal(validateGithubSha('ABC1234'), 'abc1234');
  assert.equal(validateGithubSha('a'.repeat(40)), 'a'.repeat(40));
  for (const bad of ['abc123', 'z'.repeat(7), 'a'.repeat(41), '']) {
    githubError('invalid_request', () => validateGithubSha(bad));
  }
});

test('validateGithubRequest enforces ISO since, trending windows', () => {
  const { request } = validateGithubRequest({ action: 'commits', owner: 'o', repo: 'r', since: '2024-01-02T00:00:00Z' });
  assert.equal(request.since, '2024-01-02T00:00:00Z');
  githubError('invalid_request', () => validateGithubRequest({ action: 'commits', owner: 'o', repo: 'r', since: 'yesterday-ish' }));
  assert.equal(validateGithubRequest({ action: 'trending', since: 'weekly' }).request.since, 'weekly');
  githubError('invalid_request', () => validateGithubRequest({ action: 'trending', since: '2024-01-01' }));
});

test('validateGithubRequest enforces query and labels bounds', () => {
  githubError('invalid_request', () => validateGithubRequest({ action: 'search', query: '   ' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'search_repos' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'search', query: 'q'.repeat(257) }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'search', query: 'q'.repeat(256), perPage: 0 }));
  const ok = validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', labels: ['bug', 'x'.repeat(50)] });
  assert.deepEqual(ok.request.labels, ['bug', 'x'.repeat(50)]);
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', labels: 'bug' }));
  githubError('invalid_request', () =>
    validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', labels: Array.from({ length: 11 }, (_, i) => `l${i}`) }),
  );
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', labels: ['x'.repeat(51)] }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', state: 'bogus' }));
});

test('validateGithubRequest validates run status enum for runs, reuses path validation for workflow', () => {
  const { request } = validateGithubRequest({ action: 'runs', owner: 'o', repo: 'r', status: 'success' });
  assert.equal(request.status, 'success');
  githubError('invalid_request', () => validateGithubRequest({ action: 'runs', owner: 'o', repo: 'r', status: 'bogus' }));

  const withWorkflow = validateGithubRequest({ action: 'workflows', owner: 'o', repo: 'r', workflow: 'ci.yml' });
  assert.equal(withWorkflow.request.workflow, 'ci.yml');
  githubError('invalid_request', () => validateGithubRequest({ action: 'workflows', owner: 'o', repo: 'r', workflow: '../secret' }));
});

test('validateGithubRequest accepts workflow only for workflows/runs, status only for runs', () => {
  assert.equal(validateGithubRequest({ action: 'runs', owner: 'o', repo: 'r', workflow: 'ci.yml' }).request.workflow, 'ci.yml');
  for (const action of ['issues', 'pulls', 'releases', 'commits', 'repo', 'file', 'tree'] as const) {
    githubError('invalid_request', () => validateGithubRequest({ action, owner: 'o', repo: 'r', workflow: 'ci.yml' }));
  }
  for (const action of ['issues', 'pulls', 'workflows', 'releases', 'commits'] as const) {
    githubError('invalid_request', () => validateGithubRequest({ action, owner: 'o', repo: 'r', status: 'success' }));
  }
});

test('validateGithubEntity requires safe positive ints for workflow/run/job ids', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '1'] as unknown[]) {
    assert.equal(validateGithubEntity({ ...validEntity('workflow'), workflow_id: bad }).ok, false);
    assert.equal(validateGithubEntity({ ...validEntity('workflow_run'), run_id: bad }).ok, false);
    assert.equal(validateGithubEntity({ ...validEntity('workflow_run'), run_number: bad }).ok, false);
    assert.equal(validateGithubEntity({ ...validEntity('workflow_job'), job_id: bad }).ok, false);
    assert.equal(validateGithubEntity({ ...validEntity('workflow_job'), run_id: bad }).ok, false);
  }
  const { workflow_id: _w, ...noWorkflowId } = validEntity('workflow') as unknown as Record<string, unknown>;
  void _w;
  assert.equal(validateGithubEntity(noWorkflowId).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('workflow_run'), run_id: undefined }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('workflow_job'), job_id: undefined }).ok, false);
});

// ── Limits reject-not-clamp ──

test('resolveGithubLimit rejects out-of-range with field and cap named', () => {
  assert.equal(resolveGithubLimit(undefined, 'limit', 50, 20), 20);
  assert.equal(resolveGithubLimit(50, 'limit', 50, 20), 50);
  for (const bad of [0, 51, 1.5, '10']) {
    const err = githubError('invalid_request', () => resolveGithubLimit(bad, 'limit', 50, 20));
    assert.match(err.message, /limit must be an integer in \[1, 50\]/);
  }
});

test('file requires exactly one of path / paths (XOR)', () => {
  assert.equal(validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts' }).request.path, 'src/a.ts');
  assert.deepEqual(validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', paths: ['src/a.ts', 'src/b.ts'] }).request.paths, ['src/a.ts', 'src/b.ts']);
  githubError('invalid_request', () => validateGithubRequest({ action: 'file', owner: 'o', repo: 'r' }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', paths: ['src/b.ts'] }));
  githubError('invalid_request', () => validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', paths: [] }));
});

test('per-action limit caps hold: lists 50, trending 25, search perPage 51+ rejected', () => {
  assert.equal(validateGithubRequest({ action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', limit: 50 }).request.limit, 50);
  assert.equal(validateGithubRequest({ action: 'commits', owner: 'o', repo: 'r', limit: 50 }).request.limit, 50);
  assert.equal(validateGithubRequest({ action: 'trending', limit: 25 }).request.limit, 25);
  assert.equal(validateGithubRequest({ action: 'search', query: 'q', perPage: 50 }).request.limit, 50);
  for (const input of [
    { action: 'file', owner: 'o', repo: 'r', path: 'src/a.ts', limit: 51 },
    { action: 'issues', owner: 'o', repo: 'r', limit: 51 },
    { action: 'trending', limit: 26 },
    { action: 'search', query: 'q', perPage: 51 },
    { action: 'search_repos', query: 'q', limit: 51 },
  ] as GithubRequestInput[]) {
    const err = githubError('invalid_request', () => validateGithubRequest(input));
    assert.match(err.message, /must be an integer in \[1, (25|50)\]/);
  }
  const longEcho = githubError('invalid_request', () =>
    validateGithubRequest({ action: 'search', query: 'q', perPage: 99999999999999999999 }),
  );
  assert.ok(!longEcho.message.includes('9'.repeat(33)));
});

// ── Entities ──

function validEntity(kind: GithubEntityV1['kind']): GithubEntityV1 {
  const base = { version: 1 as const, id: `id-${kind}`, backend: 'github-api' };
  switch (kind) {
    case 'repo':
      return { ...base, kind, url: 'https://github.com/o/r', name: 'r', full_name: 'o/r', stars: 3, readme: 'hi' };
    case 'file':
      return { ...base, kind, path: 'src/a.ts', content: 'code', encoding: 'utf8' };
    case 'tree':
      return { ...base, kind, entries: [{ path: 'src', type: 'tree' }] };
    case 'search_result':
      return { ...base, kind, url: 'https://github.com/o/r/blob/main/a.ts', repository: 'o/r' };
    case 'issue':
    case 'pull':
      return { ...base, kind, number: 12, title: 't', state: 'open', labels: ['bug'], body: 'b' };
    case 'release':
      return { ...base, kind, tag: 'v1.0.0', name: 'one', body: 'notes' };
    case 'commit':
      return { ...base, kind, sha: 'abc1234', message: 'fix' };
    case 'workflow':
      return { ...base, kind, workflow_id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
    case 'workflow_run':
      return { ...base, kind, run_id: 1, run_number: 3, status: 'completed', conclusion: 'success' };
    case 'workflow_job':
      return { ...base, kind, job_id: 1, run_id: 1, name: 'build', status: 'completed' };
  }
}

test('validateGithubEntity accepts every entity kind', () => {
  const kinds: GithubEntityV1['kind'][] = [
    'repo', 'file', 'tree', 'search_result', 'issue', 'pull', 'release', 'commit',
    'workflow', 'workflow_run', 'workflow_job',
  ];
  for (const kind of kinds) assert.equal(validateGithubEntity(validEntity(kind)).ok, true);
});

test('validateGithubEntity fail-closed: backend_text, unknown kind, unknown fields', () => {
  assert.deepEqual(validateGithubEntity({ ...REPO, backend_text: 'x' }).ok, false);
  assert.deepEqual(validateGithubEntity({ ...REPO, backendText: 'x' }).ok, false);
  const unknown = validateGithubEntity({ version: 1, kind: 'work', id: 'x', backend: 'b' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.issues.join('; '), /kind is not a valid github entity kind/);
  const extra = validateGithubEntity({ ...REPO, score: 9 });
  assert.equal(extra.ok, false);
  assert.match(extra.issues.join('; '), /score is not a known field/);
  assert.equal(validateGithubEntity(null).ok, false);
  assert.equal(validateGithubEntity({ ...REPO, version: 2 }).ok, false);
});

test('validateGithubEntity enforces per-entity bounds and shapes', () => {
  assert.equal(validateGithubEntity({ ...validEntity('file'), content: 'x'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1) }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('issue'), body: 'x'.repeat(GITHUB_ENTITY_CONTENT_MAX + 1) }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('release'), tag: '' }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('commit'), sha: 'zzz' }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('issue'), number: 0 }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('repo'), url: 'not-a-url' }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('tree'), entries: [{ path: '' }] }).ok, false);
  assert.equal(validateGithubEntity({ ...validEntity('tree'), entries: 'nope' }).ok, false);
});

test('validateGithubPage enforces dedupe, page cap, pagination shape', () => {
  const entity = validEntity('issue');
  const good = {
    entities: [entity],
    pagination: { supported: true, limit: 20, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
  };
  assert.equal(validateGithubPage(good).ok, true);
  const dup = validateGithubPage({ ...good, entities: [entity, { ...entity }] });
  assert.equal(dup.ok, false);
  assert.match(dup.issues.join('; '), /duplicate ids/);
  const big = validateGithubPage({
    ...good,
    entities: Array.from({ length: 8 }, (_, i) => ({ ...validEntity('file'), id: `f${i}`, content: 'x'.repeat(8000) })),
    pagination: { supported: true, limit: 20, returned: 8, hasMore: false },
  });
  assert.equal(big.ok, false);
  assert.match(big.issues.join('; '), new RegExp(String(GITHUB_PAGE_CONTENT_MAX)));
  assert.ok(String(GITHUB_PAGE_CONTENT_MAX).includes('60000'));
  const badCount = validateGithubPage({ ...good, pagination: { supported: true, limit: 20, returned: 2, hasMore: false } });
  assert.equal(badCount.ok, false);
  const singleShot = validateGithubPage({
    ...good,
    pagination: { supported: false, limit: 20, returned: 1, hasMore: false, nextCursor: 'x' },
  });
  assert.equal(singleShot.ok, false);
  const dangling = validateGithubPage({
    ...good,
    pagination: { supported: true, limit: 20, returned: 1, hasMore: false, nextCursor: 'x' },
  });
  assert.equal(dangling.ok, false);
  assert.equal(validateGithubPage({ ...good, backend_text: 'x' }).ok, false);
});

// ── Cursors + pagination policy ──

test('githubPaginationSupported is cursor only for list actions', () => {
  for (const action of ['issues', 'pulls', 'releases', 'commits', 'search', 'search_repos', 'workflows', 'runs'] as GithubAction[]) {
    assert.equal(githubPaginationSupported(action), true);
  }
  for (const action of ['repo', 'file', 'tree', 'trending'] as GithubAction[]) {
    assert.equal(githubPaginationSupported(action), false);
  }
});

test('cursor round-trip binds owner/repo/action/limit', () => {
  const fingerprint = githubCursorFingerprint({ action: 'issues', owner: 'o', repo: 'r', limit: 20 });
  const cursor = encodeGithubCursor({ action: 'issues', backend: 'github-api', fingerprint, state: { page: 2 } });
  const decoded = decodeGithubCursor(cursor, { action: 'issues', backend: 'github-api', fingerprint });
  assert.deepEqual(decoded.state, { page: 2 });
});

test('cursor fingerprint mismatch and invalid cursors reject distinctly', () => {
  const fp = (limit: number) => githubCursorFingerprint({ action: 'issues', owner: 'o', repo: 'r', limit });
  const cursor = encodeGithubCursor({ action: 'issues', backend: 'github-api', fingerprint: fp(20), state: { page: 2 } });
  githubError('cursor_mismatch', () => decodeGithubCursor(cursor, { action: 'issues', backend: 'github-api', fingerprint: fp(21) }));
  githubError('cursor_mismatch', () =>
    decodeGithubCursor(cursor, {
      action: 'issues',
      backend: 'github-api',
      fingerprint: githubCursorFingerprint({ action: 'issues', owner: 'o', repo: 'other', limit: 20 }),
    }),
  );
  githubError('cursor_mismatch', () =>
    decodeGithubCursor(cursor, { action: 'pulls', backend: 'github-api', fingerprint: fp(20) }),
  );
  githubError('cursor_invalid', () => decodeGithubCursor('!!!not-a-cursor!!!', { action: 'issues', backend: 'github-api', fingerprint: fp(20) }));
  githubError('cursor_invalid', () => decodeGithubCursor('', { action: 'issues', backend: 'github-api', fingerprint: fp(20) }));
  githubError('cursor_invalid', () =>
    encodeGithubCursor({ action: 'issues', backend: 'github-api', fingerprint: fp(20), state: { token: 'abc' } }),
  );
});

test('single-shot actions reject cursors; list actions accept', () => {
  for (const action of ['repo', 'file', 'tree'] as const) {
    const base = action === 'repo' || action === 'file' || action === 'tree' ? { owner: 'o', repo: 'r' } : {};
    githubError('cursor_invalid', () => validateGithubRequest({ action, cursor: 'abc', ...base }));
  }
  const { request } = validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', cursor: 'abc' });
  assert.equal(request.cursor, 'abc');
});

// ── Plan seam ──

test('resolveGithubAuthTier prefers env_var token, anonymous otherwise', () => {
  assert.equal(resolveGithubAuthTier({ GITHUB_TOKEN: 't' }), 'env_var');
  assert.equal(resolveGithubAuthTier({ GH_TOKEN: 't' }), 'env_var');
  assert.equal(resolveGithubAuthTier({}), process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ? 'env_var' : 'anonymous');
});

test('orderGithubPlans prefers complete, full, cursor, authenticated', () => {
  const degraded = plan({ degraded: true });
  const anon = plan({ authTier: 'anonymous' });
  const unsupported = plan({ pagination: 'unsupported' });
  const ordered = orderGithubPlans('issues', [degraded, unsupported, anon, plan()]);
  assert.deepEqual(
    ordered.map((p) => [p.degraded, p.pagination, p.authTier]),
    [
      [false, 'cursor', 'env_var'],
      [false, 'cursor', 'anonymous'],
      [false, 'unsupported', 'env_var'],
      [true, 'cursor', 'env_var'],
    ],
  );
});

test('Plan E3 routing: repo/tree clone-first with REST fallback, file REST-first', () => {
  assert.deepEqual([...GITHUB_BACKEND_PREFERENCE.repo], ['github-clone', 'github-api']);
  assert.deepEqual([...GITHUB_BACKEND_PREFERENCE.tree], ['github-clone', 'github-api']);
  assert.deepEqual([...GITHUB_BACKEND_PREFERENCE.file], ['github-api', 'github-clone']);
  for (const action of GITHUB_ACTIONS) {
    assert.ok(GITHUB_BACKEND_PREFERENCE[action].includes('github-api'), `${action} keeps REST in chain`);
  }
});

test('github-request-contract owns request validation; facade re-exports identical refs', () => {
  assert.equal(validateGithubRequestFacade, validateGithubRequestDirect);
  assert.equal(resolveGithubActionFacade, resolveGithubActionDirect);
  assert.equal(resolveGithubLimitFacade, resolveGithubLimitDirect);
  assert.equal(validateGithubPathFacade, validateGithubPathDirect);
  assert.throws(() => resolveGithubLimitDirect(51, 'limit', 50, 20), /limit must be an integer in \[1, 50\]: 51/);
  assert.throws(() => validateGithubRequestDirect({ action: 'list_dir' }), /Unsupported github action: list_dir/);
});

test('M5 regression: issues/pulls with number remain valid requests (no contract change)', () => {
  const issue = validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', number: 1 });
  assert.equal(issue.request.action, 'issues');
  assert.equal(issue.request.number, 1);
  const pull = validateGithubRequest({ action: 'pulls', owner: 'o', repo: 'r', number: 2 });
  assert.equal(pull.request.action, 'pulls');
  assert.equal(pull.request.number, 2);
  // Comment threads ride the entity body: no new request field exists.
  assert.throws(() => validateGithubRequest({ action: 'issues', owner: 'o', repo: 'r', number: 0 }), /number must be a positive integer/);
});
