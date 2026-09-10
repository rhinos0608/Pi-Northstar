// Stage 2 Reddit worker tests: fixture-based normalization, plan ordering
// (cookie → anonymous → api_key), cursor pinning, closed argv mappings, and
// the shared sanitized Python child environment. No live backends.

import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildPythonChildEnvironment } from '../src/python-child-env.js';
import {
  SocialError,
  decodeSocialCursor,
  encodeSocialCursor,
  socialCursorFingerprint,
  validateSocialPage,
  validateSocialRequest,
  type SocialBackendPlan,
  type SocialPageV1,
  type SocialRequest,
  type SocialRequestInput,
} from '../src/social-contract.js';
import {
  REDDIT_BACKEND_CAPABILITIES,
  createRedditWorker,
  resolveRedditChildEnv,
  runRedditCli,
} from '../src/social-reddit.js';

function socialError(code: string, run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

function req(input: SocialRequestInput): SocialRequest {
  return validateSocialRequest(input).request;
}

// ── Fixtures ──

function t3Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 't3',
    data: {
      name: 't3_abc123',
      id: 'abc123',
      title: 'Hello Reddit',
      selftext: 'Body text',
      author: 'alice',
      subreddit: 'test',
      permalink: '/r/test/comments/abc123/hello/',
      created_utc: 1714550000,
      score: 5,
      num_comments: 2,
      ...overrides,
    },
  };
}

function t1Row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 't1',
    data: {
      fullname: 't1_cdef1234',
      body: 'A comment',
      author: 'bob',
      link_id: 't3_abc123',
      parent_fullname: 't3_abc123',
      created_utc: 1714550100,
      score: 7,
      ...overrides,
    },
  };
}

function rawListing(rows: unknown[], after?: string): unknown {
  return { kind: 'Listing', data: { children: rows, ...(after !== undefined ? { after } : {}) } };
}

function rdtListing(rows: unknown[], after?: string): unknown {
  return {
    ok: true,
    schema_version: '1',
    data: { kind: 'Listing', data: { children: rows, ...(after !== undefined ? { after } : {}) } },
  };
}

function rdtReadFixture(): unknown {
  return {
    ok: true,
    schema_version: '1',
    data: {
      post: {
        id: 'abc123',
        name: 't3_abc123',
        title: 'Hello Reddit',
        selftext: 'Body text',
        author: 'alice',
        subreddit: 'test',
        score: 5,
        num_comments: 2,
        created_utc: 1714550000,
        permalink: '/r/test/comments/abc123/hello/',
      },
      comments: [
        {
          fullname: 't1_cdef1234',
          parent_fullname: 't3_abc123',
          body: 'A comment',
          author: 'bob',
          score: 7,
          created_utc: 1714550100,
          replies: [
            {
              fullname: 't1_efgh5678',
              parent_fullname: 't1_cdef1234',
              body: 'A reply',
              author: 'carol',
              score: 1,
              created_utc: 1714550200,
              replies: [],
            },
          ],
        },
      ],
    },
  };
}

function opencliSearchFixture(): unknown {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `abcd${index}`,
    title: `Post ${index}`,
    subreddit: 'r/test',
    author: 'alice',
    score: index,
    comments: index,
    url: `https://www.reddit.com/r/test/comments/abcd${index}/x/`,
    created_utc: 1714550000 + index,
    selftext: '',
  }));
}

function rdtCommunityFixture(): unknown {
  return {
    ok: true,
    data: {
      name: 't5_2qh0y',
      display_name: 'Python',
      title: 'Python',
      public_description: 'News about Python',
      subscribers: 1510558,
      created_utc: 1200000000,
    },
  };
}

function rdtUserFixture(): unknown {
  return {
    ok: true,
    data: { name: 'spez', id: '1w72', title: 'spez', public_description: 'Reddit CEO', created_utc: 1100000000 },
  };
}

function pageOk(page: SocialPageV1): SocialPageV1 {
  const validation = validateSocialPage(page);
  assert.deepEqual(validation.issues, [], `page must validate: ${validation.issues.join('; ')}`);
  return validation.page!;
}

function firstPlan(plans: readonly SocialBackendPlan[]): SocialBackendPlan {
  assert.ok(plans.length > 0, 'expected at least one plan');
  return plans[0]!;
}

interface CliInvocation {
  command: string;
  args: string[];
}

function cliRecorder(defaultPayload: unknown = rdtListing([])): {
  calls: CliInvocation[];
  runCli: (command: string, args: readonly string[], options: { signal?: AbortSignal | undefined }) => Promise<unknown>;
} {
  const calls: CliInvocation[] = [];
  return {
    calls,
    async runCli(command, args) {
      calls.push({ command, args: [...args] });
      return defaultPayload;
    },
  };
}

const OAUTH_ENV = {
  REDDIT_CLIENT_ID: 'cid',
  REDDIT_CLIENT_SECRET: 'secret-value',
  REDDIT_USER_AGENT: 'ua',
};

// ── Capability invariants ──

test('every advertised Reddit action has at least one backend operation', () => {
  const actions = new Set(REDDIT_BACKEND_CAPABILITIES.flatMap((backend) => backend.operations.map((operation) => operation.action)));
  for (const action of [
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies', 'get_profile',
    'get_user_posts', 'get_user_comments', 'get_feed', 'get_trending', 'get_saved',
    'get_community', 'get_community_posts',
  ] as const) {
    assert.ok(actions.has(action), `${action} must have a backend operation`);
  }
});

test('backend operations never reference unadvertised Reddit actions', () => {
  const advertised = new Set([
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies', 'get_profile',
    'get_user_posts', 'get_user_comments', 'get_feed', 'get_trending', 'get_saved',
    'get_community', 'get_community_posts',
  ]);
  for (const backend of REDDIT_BACKEND_CAPABILITIES) {
    for (const operation of backend.operations) {
      assert.ok(advertised.has(operation.action), `${backend.name} advertises unknown action ${operation.action}`);
      assert.ok(!operation.upstreamAction.some((command) => command.includes('download')), 'no download commands');
      assert.ok(!operation.upstreamAction.some((command) => /^(save|upvote|comment|reply|subscribe|login)$/.test(command)), 'no mutation commands');
    }
  }
});

test('reddit-oauth never serves feed or saved (public actions only)', () => {
  const oauth = REDDIT_BACKEND_CAPABILITIES.find((backend) => backend.name === 'reddit-oauth');
  assert.ok(oauth !== undefined);
  const actions = oauth.operations.map((operation) => operation.action);
  assert.ok(!actions.includes('get_feed'));
  assert.ok(!actions.includes('get_saved'));
});

// ── Plan ordering: cookie → anonymous → api_key ──

test('public action orders cookie, anonymous, then api_key plans', async () => {
  const worker = createRedditWorker({
    env: { REDDIT_COOKIE: 'a=b; c=d', ...OAUTH_ENV },
    runCli: cliRecorder().runCli,
  });
  const plans = await worker.plans(req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 }), {});
  assert.deepEqual(plans.map((plan) => `${plan.backend}:${plan.authTier}`), [
    'reddit-cookie:cookie',
    'OpenCLI:anonymous',
    'rdt-cli:anonymous',
    'reddit-oauth:api_key',
  ]);
});

test('auth-required actions only emit cookie-tier plans', async () => {
  const worker = createRedditWorker({
    env: { REDDIT_COOKIE: 'a=b' },
    runCli: cliRecorder().runCli,
  });
  const plans = await worker.plans(req({ platform: 'reddit', action: 'get_saved', limit: 5 }), {});
  assert.deepEqual(plans.map((plan) => plan.backend), ['OpenCLI', 'rdt-cli', 'reddit-cookie']);
  assert.ok(plans.every((plan) => plan.authTier === 'cookie'));
});

test('without credentials only anonymous CLI plans are declared', async () => {
  const worker = createRedditWorker({ env: {}, runCli: cliRecorder().runCli });
  const plans = await worker.plans(req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 }), {});
  assert.deepEqual(plans.map((plan) => `${plan.backend}:${plan.authTier}`), [
    'OpenCLI:anonymous',
    'rdt-cli:anonymous',
  ]);
});

test('oauth plan appears only with API credentials and only for public actions', async () => {
  const worker = createRedditWorker({ env: OAUTH_ENV, runCli: cliRecorder().runCli });
  const publicPlans = await worker.plans(req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 }), {});
  assert.ok(publicPlans.some((plan) => plan.backend === 'reddit-oauth'));
  const savedPlans = await worker.plans(req({ platform: 'reddit', action: 'get_saved', limit: 5 }), {});
  assert.ok(!savedPlans.some((plan) => plan.backend === 'reddit-oauth'));
});

test('backends without a mapping for the action are skipped, not fatal', async () => {
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' }, runCli: cliRecorder().runCli });
  const plans = await worker.plans(req({ platform: 'reddit', action: 'get_comment_replies', commentId: 't1_cdef1234', limit: 5 }), {});
  assert.deepEqual(plans.map((plan) => plan.backend), ['reddit-cookie']);
});

// ── Cursor pinning ──

function cursorFor(request: SocialRequest, backend: string, after = 't3_abc123'): string {
  return encodeSocialCursor({
    platform: 'reddit',
    action: request.action,
    backend,
    fingerprint: socialCursorFingerprint(request),
    state: { after },
  });
}

test('a cursor pins the issuing backend and never switches', async () => {
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const worker = createRedditWorker({
    env: { REDDIT_COOKIE: 'a=b', ...OAUTH_ENV },
    runCli: cliRecorder().runCli,
  });
  const pinned = await worker.plans({ ...request, cursor: cursorFor(request, 'rdt-cli') }, {});
  assert.deepEqual(pinned.map((plan) => plan.backend), ['rdt-cli']);
});

test('cursor issued for the cookie backend excludes CLI plans', async () => {
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' }, runCli: cliRecorder().runCli });
  const plans = await worker.plans({ ...request, cursor: cursorFor(request, 'reddit-cookie') }, {});
  assert.deepEqual(plans.map((plan) => plan.backend), ['reddit-cookie']);
});

test('cursor bound to a backend with no declared plan returns no plans', async () => {
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const worker = createRedditWorker({ env: {}, runCli: cliRecorder().runCli });
  const plans = await worker.plans({ ...request, cursor: cursorFor(request, 'reddit-cookie') }, {});
  assert.deepEqual(plans, []);
});

test('cursor fingerprint change (limit) rejects every plan', async () => {
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const worker = createRedditWorker({ env: {}, runCli: cliRecorder().runCli });
  const changed = req({ platform: 'reddit', action: 'search', query: 'test', limit: 10 });
  const plans = await worker.plans({ ...changed, cursor: cursorFor(request, 'rdt-cli') }, {});
  assert.deepEqual(plans, []);
});

test('malformed continuation token in cursor state is cursor_invalid', async () => {
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const worker = createRedditWorker({ env: {}, runCli: cliRecorder().runCli });
  const cursor = encodeSocialCursor({
    platform: 'reddit',
    action: 'search',
    backend: 'rdt-cli',
    fingerprint: socialCursorFingerprint(request),
    state: { after: 'DROP TABLE posts' },
  });
  await assert.rejects(
    () => worker.plans({ ...request, cursor }, {}),
    (error: unknown) => socialError('cursor_invalid', () => { throw error; }) === error,
  );
});

// ── Closed argv mappings ──

const FORBIDDEN_ARGV_TOKENS = ['download', 'save', 'upvote', 'comment', 'reply', 'subscribe', 'login', 'open', 'export', 'show', '--output'];

test('opencli argv stays inside the verified command map and always uses -f json', async () => {
  const { calls, runCli } = cliRecorder(opencliSearchFixture());
  const worker = createRedditWorker({ env: {}, runCli });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'OpenCLI');
  assert.ok(plan !== undefined);
  await plan.execute();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, 'opencli');
  assert.deepEqual(calls[0]!.args.slice(0, 3), ['reddit', 'search', 'test']);
  assert.ok(calls[0]!.args.includes('-f') && calls[0]!.args.includes('json'));
  for (const token of calls[0]!.args) {
    assert.ok(!FORBIDDEN_ARGV_TOKENS.includes(token), `forbidden token ${token} in opencli argv`);
  }
});

test('rdt argv uses --json and passes --after for cursor listings', async () => {
  const { calls, runCli } = cliRecorder();
  const worker = createRedditWorker({ env: {}, runCli });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plans = await worker.plans({ ...request, cursor: cursorFor(request, 'rdt-cli') }, {});
  assert.equal(plans.length, 1);
  const plan = firstPlan(plans);
  assert.equal(plan.backend, 'rdt-cli');
  await plan.execute();

  assert.equal(calls[0]!.command, 'rdt');
  assert.equal(calls[0]!.args[0], 'search');
  assert.ok(calls[0]!.args.includes('--after'));
  assert.equal(calls[0]!.args[calls[0]!.args.indexOf('--after') + 1], 't3_abc123');
  assert.ok(calls[0]!.args.includes('--json'));
});

test('no mutation command reaches the subprocess runner for any read action', async () => {
  const { calls, runCli } = cliRecorder();
  const worker = createRedditWorker({ env: {}, runCli });
  const inputs: SocialRequestInput[] = [
    { platform: 'reddit', action: 'search', query: 'q', limit: 5 },
    { platform: 'reddit', action: 'get_post', postId: 'abc123', limit: 5 },
    { platform: 'reddit', action: 'get_thread', postId: 'abc123', limit: 5 },
    { platform: 'reddit', action: 'get_comments', postId: 'abc123', limit: 5 },
    { platform: 'reddit', action: 'get_profile', user: 'alice', limit: 5 },
    { platform: 'reddit', action: 'get_user_posts', user: 'alice', limit: 5 },
    { platform: 'reddit', action: 'get_user_comments', user: 'alice', limit: 5 },
    { platform: 'reddit', action: 'get_trending', limit: 5 },
    { platform: 'reddit', action: 'get_community', community: 'test', limit: 5 },
    { platform: 'reddit', action: 'get_community_posts', community: 'test', limit: 5 },
  ];
  for (const input of inputs) {
    for (const plan of await worker.plans(validateSocialRequest(input).request, {})) {
      await plan.execute();
    }
  }
  assert.ok(calls.length > 0);
  for (const call of calls) {
    for (const token of call.args) {
      assert.ok(!FORBIDDEN_ARGV_TOKENS.includes(token), `forbidden token ${token} in argv: ${call.args.join(' ')}`);
    }
  }
});

// ── Shared sanitized Python child environment ──

test('runRedditCli uses buildPythonChildEnvironment: secrets never reach the child', async () => {
  const sentinel = 'REDDIT_WORKER_SENTINEL_SECRET';
  process.env[sentinel] = 'leak-me-not';
  try {
    const payload = (await runRedditCli('node', ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {})) as Record<string, string>;
    assert.ok(!(sentinel in payload), 'secret leaked into the child environment');
    assert.ok(typeof payload.PATH === 'string' && payload.PATH.length > 0);
  } finally {
    delete process.env[sentinel];
  }
});

test('opencli child env passes OPENCLI_HOST/PORT/TOKEN and excludes other secrets', () => {
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    OPENCLI_HOST: 'cli.example',
    OPENCLI_PORT: '9222',
    OPENCLI_TOKEN: 'operator-token-abc',
    REDDIT_COOKIE: 'cookie-secret',
    GITHUB_TOKEN: 'github-secret',
    OTHER_SECRET: 'other-secret',
    FOO: 'bar',
  };
  const env = resolveRedditChildEnv('opencli', source);
  assert.equal(env['OPENCLI_HOST'], 'cli.example');
  assert.equal(env['OPENCLI_PORT'], '9222');
  assert.equal(env['OPENCLI_TOKEN'], 'operator-token-abc');
  assert.equal(env['PATH'], '/usr/bin:/bin');
  for (const secret of ['REDDIT_COOKIE', 'GITHUB_TOKEN', 'OTHER_SECRET', 'FOO']) {
    assert.ok(!(secret in env), `${secret} must not reach the opencli child env`);
  }
});

test('rdt child env keeps the python allowlist and never inherits secrets or OPENCLI_*', () => {
  const source = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    OPENCLI_HOST: 'cli.example',
    OPENCLI_PORT: '9222',
    OPENCLI_TOKEN: 'operator-token-abc',
    REDDIT_COOKIE: 'cookie-secret',
    GITHUB_TOKEN: 'github-secret',
    OTHER_SECRET: 'other-secret',
  };
  const env = resolveRedditChildEnv('rdt', source);
  assert.deepEqual(env, buildPythonChildEnvironment(source));
  for (const secret of ['REDDIT_COOKIE', 'GITHUB_TOKEN', 'OTHER_SECRET', 'OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN']) {
    assert.ok(!(secret in env), `${secret} must not reach the rdt child env`);
  }
  assert.equal(env['PATH'], '/usr/bin:/bin');
});

test('opencli spawn receives OPENCLI_* without secret leakage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reddit-opencli-'));
  const probe = 'opencli-probe-env';
  writeFileSync(join(dir, probe), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.env));\n');
  chmodSync(join(dir, probe), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${dir}:${previousPath ?? '/usr/bin:/bin'}`;
  try {
    const payload = (await runRedditCli(probe, [], {}, {
      PATH: process.env.PATH,
      HOME: '/home/u',
      OPENCLI_HOST: 'cli.example',
      OPENCLI_PORT: '9222',
      OPENCLI_TOKEN: 'operator-token-abc',
      REDDIT_COOKIE: 'cookie-secret',
      GITHUB_TOKEN: 'github-secret',
    })) as Record<string, string>;
    assert.equal(payload['OPENCLI_HOST'], 'cli.example');
    assert.equal(payload['OPENCLI_PORT'], '9222');
    assert.equal(payload['OPENCLI_TOKEN'], 'operator-token-abc');
    assert.ok(!('REDDIT_COOKIE' in payload), 'REDDIT_COOKIE leaked into the opencli child');
    assert.ok(!('GITHUB_TOKEN' in payload), 'GITHUB_TOKEN leaked into the opencli child');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Native HTTP execution ──

test('cookie plan hits fixed www.reddit.com with the cookie header only', async () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const worker = createRedditWorker({
    env: { REDDIT_COOKIE: 'session-cookie-value' },
    httpGet: async (url, headers) => {
      requests.push({ url, headers });
      return rawListing([t3Row()]);
    },
  });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = firstPlan(await worker.plans(request, {}));
  assert.equal(plan.backend, 'reddit-cookie');
  await plan.execute();

  assert.equal(requests.length, 1);
  assert.ok(requests[0]!.url.startsWith('https://www.reddit.com/search.json?'));
  assert.equal(requests[0]!.headers.Cookie, 'session-cookie-value');
  assert.ok(!('Authorization' in requests[0]!.headers));
});

test('oauth plan sends bearer token to oauth.reddit.com only', async () => {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const worker = createRedditWorker({
    env: OAUTH_ENV,
    requestToken: async () => 'token-value',
    httpGet: async (url, headers) => {
      requests.push({ url, headers });
      return rawListing([t3Row()]);
    },
  });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'reddit-oauth');
  assert.ok(plan !== undefined);
  await plan.execute();

  assert.ok(requests[0]!.url.startsWith('https://oauth.reddit.com/search.json?'));
  assert.equal(requests[0]!.headers.Authorization, 'Bearer token-value');
});

test('get_comment_replies resolves the comment then its subtree over fixed hosts', async () => {
  const requests: string[] = [];
  const worker = createRedditWorker({
    env: { REDDIT_COOKIE: 'a=b' },
    httpGet: async (url) => {
      requests.push(url);
      if (requests.length === 1) {
        return rawListing([{ kind: 't1', data: { fullname: 't1_cdef1234', link_id: 't3_abc123' } }]);
      }
      return [rawListing([t3Row()]), rawListing([t1Row()])];
    },
  });
  const request = req({ platform: 'reddit', action: 'get_comment_replies', commentId: 't1_cdef1234', limit: 5 });
  const plan = firstPlan(await worker.plans(request, {}));
  assert.equal(plan.backend, 'reddit-cookie');
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  assert.deepEqual(result.entities.map((entity) => entity.id), [
    'reddit:social_comment:t1_cdef1234',
  ]);

  assert.ok(requests[0]!.startsWith('https://www.reddit.com/api/info.json?id=t1_cdef1234'));
  assert.ok(requests[1]!.startsWith('https://www.reddit.com/comments/abc123.json?'));
});

// ── Normalization ──

test('native listing normalizes posts and exposes a truthful after cursor', async () => {
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' } });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = firstPlan(await worker.plans(request, {}));
  const payload = rawListing([t3Row(), t3Row({ data: { name: 't3_zzzz9999', id: 'zzzz9999', title: 'Second' } })], 't3_next0001');
  const result = pageOk(worker.normalize(request, plan, payload));

  assert.equal(result.entities.length, 2);
  assert.equal(result.entities[0]!.kind, 'social_post');
  assert.equal(result.pagination.supported, true);
  assert.equal(result.pagination.hasMore, true);
  const decoded = decodeSocialCursor(result.pagination.nextCursor!, {
    platform: 'reddit',
    action: 'search',
    backend: 'reddit-cookie',
    fingerprint: socialCursorFingerprint(request),
  });
  assert.equal(decoded.state.after, 't3_next0001');
});

test('listing without upstream continuation never fabricates hasMore', async () => {
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' } });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 1 });
  const plan = firstPlan(await worker.plans(request, {}));
  const result = pageOk(worker.normalize(request, plan, rawListing([t3Row()])));
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.pagination.nextCursor, undefined);
  assert.ok(!result.partial);
});

test('opencli listings are non-pageable and flag truncation at the limit', async () => {
  const { runCli } = cliRecorder(opencliSearchFixture());
  const worker = createRedditWorker({ env: {}, runCli });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'OpenCLI');
  assert.ok(plan !== undefined);
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  assert.equal(result.pagination.supported, false);
  assert.equal(result.pagination.hasMore, false);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some((warning) => warning.includes('truncated')));
});

test('rdt listing exposes a cursor bound to rdt-cli', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtListing([t3Row()], 't3_rdt00001') });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(plan !== undefined);
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  assert.equal(result.pagination.hasMore, true);
  const decoded = decodeSocialCursor(result.pagination.nextCursor!, {
    platform: 'reddit',
    action: 'search',
    backend: 'rdt-cli',
    fingerprint: socialCursorFingerprint(request),
  });
  assert.equal(decoded.state.after, 't3_rdt00001');
});

test('get_post returns exactly one post; get_thread is post + comments in source order', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtReadFixture() });
  const postRequest = req({ platform: 'reddit', action: 'get_post', postId: 'abc123', limit: 5 });
  const threadRequest = req({ platform: 'reddit', action: 'get_thread', postId: 'abc123', limit: 5 });

  const postPlan = (await worker.plans(postRequest, {})).find((candidate) => candidate.backend === 'rdt-cli');
  const threadPlan = (await worker.plans(threadRequest, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(postPlan !== undefined && threadPlan !== undefined);

  const postPage = pageOk(worker.normalize(postRequest, postPlan, rdtReadFixture()));
  assert.equal(postPage.entities.length, 1);
  assert.equal(postPage.entities[0]!.kind, 'social_post');

  const threadPage = pageOk(worker.normalize(threadRequest, threadPlan, rdtReadFixture()));
  assert.deepEqual(threadPage.entities.map((entity) => entity.kind), ['social_post', 'social_comment', 'social_comment']);
  const reply = threadPage.entities[2]!;
  assert.equal(reply.id, 'reddit:social_comment:t1_efgh5678');
  if (reply.kind === 'social_comment') {
    assert.equal(reply.depth, 1);
    assert.equal(reply.parentCommentId, 't1_cdef1234');
    assert.equal(reply.postId, 't3_abc123');
  } else {
    assert.fail('expected social_comment');
  }
});

test('get_thread with includeReplies false keeps top-level comments only and flags the truncation', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtReadFixture() });
  const request = req({ platform: 'reddit', action: 'get_thread', postId: 'abc123', limit: 5, includeReplies: false });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(plan !== undefined);
  const result = pageOk(worker.normalize(request, plan, rdtReadFixture()));
  assert.deepEqual(result.entities.map((entity) => entity.kind), ['social_post', 'social_comment']);
  assert.ok(result.warnings.some((warning) => warning.includes('includeReplies is false')));
});

test('get_post over an empty listing is not_found, never an empty success', async () => {
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' } });
  const request = req({ platform: 'reddit', action: 'get_post', postId: 'abc123', limit: 5 });
  const plan = firstPlan(await worker.plans(request, {}));
  assert.throws(
    () => worker.normalize(request, plan, rawListing([])),
    (error: unknown) => socialError('not_found', () => { throw error; }) === error,
  );
});

test('malformed payload fails closed as malformed_upstream without synthetic entities', () => {
  const worker = createRedditWorker({ env: {} });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan: SocialBackendPlan = {
    backend: 'rdt-cli',
    authTier: 'anonymous',
    pagination: 'cursor',
    execute: async () => null,
  };
  assert.throws(
    () => worker.normalize(request, plan, 'not a listing'),
    (error: unknown) => socialError('malformed_upstream', () => { throw error; }) === error,
  );
});

test('dropped malformed rows mark the page partial with a warning', async () => {
  const worker = createRedditWorker({ env: { REDDIT_COOKIE: 'a=b' } });
  const request = req({ platform: 'reddit', action: 'search', query: 'test', limit: 5 });
  const plan = firstPlan(await worker.plans(request, {}));
  const payload = rawListing([
    t3Row(),
    { kind: 't3', data: { title: 'no id' } },
    t3Row({ data: { name: 't3_bbbb2222', id: 'bbbb2222', title: 'Second' } }),
  ]);
  const result = pageOk(worker.normalize(request, plan, payload));
  assert.equal(result.entities.length, 2);
  assert.equal(result.partial, true);
  assert.ok(result.warnings.some((warning) => warning.startsWith('dropped')));
});

test('get_comments returns comments only, never the post entity', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtReadFixture() });
  const request = req({ platform: 'reddit', action: 'get_comments', postId: 'abc123', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(plan !== undefined);
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  assert.ok(result.entities.length > 0);
  assert.ok(result.entities.every((entity) => entity.kind === 'social_comment'));
  assert.equal(result.pagination.supported, false);
  assert.equal(result.pagination.hasMore, false);
});

test('subreddit about rows normalize to communities with followers from subscribers', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtCommunityFixture() });
  const request = req({ platform: 'reddit', action: 'get_community', community: 'python', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(plan !== undefined);
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  const community = result.entities[0]!;
  assert.equal(community.kind, 'social_community');
  if (community.kind === 'social_community') {
    assert.equal(community.name, 'Python');
    assert.equal(community.metrics?.followers, 1510558);
  }
});

test('user about rows normalize to accounts without invented metrics', async () => {
  const worker = createRedditWorker({ env: {}, runCli: async () => rdtUserFixture() });
  const request = req({ platform: 'reddit', action: 'get_profile', user: 'spez', limit: 5 });
  const plan = (await worker.plans(request, {})).find((candidate) => candidate.backend === 'rdt-cli');
  assert.ok(plan !== undefined);
  const payload = await plan.execute();
  const result = pageOk(worker.normalize(request, plan, payload));
  const account = result.entities[0]!;
  assert.equal(account.kind, 'social_account');
  if (account.kind === 'social_account') {
    assert.equal(account.handle, 'spez');
    assert.equal(account.displayName, 'spez');
    assert.equal(account.metrics, undefined);
  }
});

test('worker declares only the reddit platform', async () => {
  const worker = createRedditWorker({ env: {} });
  assert.deepEqual(worker.platforms, ['reddit']);
});

// ── CLI positional safety (no-spawn) ──

test('opencli search rejects option-shaped query without spawning', async () => {
  const { calls, runCli } = cliRecorder();
  const worker = createRedditWorker({ env: {}, runCli });
  const request = req({ platform: 'reddit', action: 'search', query: '--limit', limit: 5 });
  await assert.rejects(
    () => worker.plans(request, {}),
    (error: unknown) => {
      assert.ok(error instanceof SocialError && error.code === 'invalid_request');
      assert.ok(!error.message.includes('--limit'), 'rejection echoed the positional value');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test('rdt-cli search rejects option-shaped query without spawning', async () => {
  const { calls, runCli } = cliRecorder();
  const worker = createRedditWorker({ env: {}, runCli });
  const request = req({ platform: 'reddit', action: 'search', query: '--json', limit: 5 });
  const pinned = { ...request, cursor: cursorFor(request, 'rdt-cli') };
  await assert.rejects(
    () => worker.plans(pinned, {}),
    (error: unknown) => {
      assert.ok(error instanceof SocialError && error.code === 'invalid_request');
      assert.ok(!error.message.includes('--json'), 'rejection echoed the positional value');
      return true;
    },
  );
  assert.equal(calls.length, 0);
});
