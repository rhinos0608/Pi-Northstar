import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOCIAL_CANONICAL_ACTIONS,
  SocialError,
  backendSupportsAction,
  selectorSpecFor,
  validateSocialRequest,
  validateSocialPage,
  canonicalActionsFor,
  type SocialAction,
} from '../../src/social/social-contract.js';
import { buildPythonChildEnvironment } from '../../src/process/python-child-env.js';
import {
  OPENCLI_BACKEND,
  OPENCLI_XIAOHONGSHU_CAPABILITY,
  XHS_BACKEND,
  XHS_CLI_CAPABILITY,
  createXiaohongshuWorker,
  xiaohongshuWorker,
  xhsCliArgvFor,
  opencliArgvFor,
  type SocialProcessResult,
  type SocialProcessRunner,
} from '../../src/social/social-xiaohongshu.js';
import { stripXsecToken } from '../../src/social/social-xiaohongshu-normalize.js';
import type { SocialRequest } from '../../src/social/social-contract.js';

// ── Harness ──

interface FakeRun {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  signal: AbortSignal | undefined;
}

interface FakeStep {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

function fakeRunner(steps: FakeStep[]): { runner: SocialProcessRunner; runs: FakeRun[] } {
  const runs: FakeRun[] = [];
  const queue = [...steps];
  const runner: SocialProcessRunner = async (run) => {
    runs.push(run);
    const step = queue.shift() ?? { code: 0, stdout: '[]', stderr: '' };
    if (step.error !== undefined) throw step.error;
    return { code: step.code ?? 0, stdout: step.stdout ?? '', stderr: step.stderr ?? '' } satisfies SocialProcessResult;
  };
  return { runner, runs };
}

function request(input: Partial<SocialRequest> & { action: SocialAction }): SocialRequest {
  return validateSocialRequest({
    platform: 'xiaohongshu',
    action: input.action,
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.postId !== undefined ? { postId: input.postId } : {}),
    ...(input.user !== undefined ? { user: input.user } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.includeReplies !== undefined ? { includeReplies: input.includeReplies } : {}),
    ...(input.feedVariant !== undefined ? { feedVariant: input.feedVariant } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
  }).request;
}

const SENTINEL_ENV: Record<string, string | undefined> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  XHS_COOKIE: 'a1=secret; web_session=secret',
  A1_COOKIE: 'secret',
  WEB_SESSION_COOKIE: 'secret',
  MY_API_KEY: 'sk-secret',
  ACCESS_TOKEN: 'tok',
  NPM_CONFIG_TOKEN: 'leak',
};

// ── Capability registry invariants ──

test('every opencli-xiaohongshu operation references an advertised canonical action', () => {
  for (const operation of OPENCLI_XIAOHONGSHU_CAPABILITY.operations) {
    assert.ok(
      (SOCIAL_CANONICAL_ACTIONS.xiaohongshu as readonly string[]).includes(operation.action),
      `opencli operation ${operation.action} is not advertised`,
    );
    assert.ok(backendSupportsAction(OPENCLI_XIAOHONGSHU_CAPABILITY, operation.action));
    assert.equal(operation.pagination, 'none');
    assert.deepEqual(operation.auth, ['cookie']);
  }
});

test('every xhs-cli operation references an advertised canonical action', () => {
  for (const operation of XHS_CLI_CAPABILITY.operations) {
    assert.ok(
      (SOCIAL_CANONICAL_ACTIONS.xiaohongshu as readonly string[]).includes(operation.action),
      `xhs-cli operation ${operation.action} is not advertised`,
    );
    assert.equal(operation.pagination, 'none');
  }
});

test('every advertised xiaohongshu action has at least one verified backend operation', () => {
  for (const action of SOCIAL_CANONICAL_ACTIONS.xiaohongshu) {
    const opencli = OPENCLI_XIAOHONGSHU_CAPABILITY.operations.some((operation) => operation.action === action);
    const xhs = XHS_CLI_CAPABILITY.operations.some((operation) => operation.action === action);
    assert.ok(opencli || xhs, `no backend operation for ${action}`);
  }
});

test('capabilities carry verified versions and commands', () => {
  assert.equal(OPENCLI_XIAOHONGSHU_CAPABILITY.verifiedVersion, '1.8.6');
  assert.equal(OPENCLI_XIAOHONGSHU_CAPABILITY.command, 'opencli');
  assert.equal(XHS_CLI_CAPABILITY.verifiedVersion, '0.1.4');
  assert.equal(XHS_CLI_CAPABILITY.command, 'xhs');
});

test('every operation maps to a real installed CLI subcommand', () => {
  const opencliCommands = new Set([
    'search', 'note', 'comments', 'user', 'feed', 'saved', 'notifications',
  ]);
  for (const operation of OPENCLI_XIAOHONGSHU_CAPABILITY.operations) {
    assert.ok(opencliCommands.has(operation.upstreamAction[0]!), operation.action);
  }
  for (const operation of XHS_CLI_CAPABILITY.operations) {
    assert.ok(xhsCliReadSubcommands.has(operation.upstreamAction[0]!), operation.action);
  }
});

const xhsCliReadSubcommands = new Set([
  'search', 'read', 'user', 'user-posts', 'followers', 'following', 'feed', 'favorites',
]);

test('xhs-cli get_comments is read --comments, never a mutation command', () => {
  const operation = XHS_CLI_CAPABILITY.operations.find((entry) => entry.action === 'get_comments');
  assert.deepEqual(operation?.upstreamAction, ['read', '--comments', '--json']);
});

test('get_comments includeReplies:false skips xhs-cli instead of ignoring the flag', async () => {
  const { runner } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  const plain = await worker.plans(request({ action: 'get_comments', postId: 'a'.repeat(24) }), {});
  assert.equal(plain.length, 2);
  const narrowed = await worker.plans(request({ action: 'get_comments', postId: 'a'.repeat(24), includeReplies: false }), {});
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0]!.backend, OPENCLI_BACKEND);
});

// ── Plans ──

test('search declares OpenCLI first, xhs-cli second, both cookie tier', async () => {
  const { runner } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: '咖啡' }), {});
  assert.equal(plans.length, 2);
  assert.equal(plans[0]!.backend, OPENCLI_BACKEND);
  assert.equal(plans[1]!.backend, XHS_BACKEND);
  for (const plan of plans) {
    assert.equal(plan.authTier, 'cookie');
    assert.equal(plan.pagination, 'none');
  }
});

test('get_profile, get_followers, get_following only declare xhs-cli', async () => {
  const { runner } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  for (const action of ['get_profile', 'get_followers', 'get_following'] as const) {
    const plans = await worker.plans(request({ action, user: 'user-1' }), {});
    assert.equal(plans.length, 1, action);
    assert.equal(plans[0]!.backend, XHS_BACKEND, action);
  }
});

test('get_notifications only declares opencli-xiaohongshu', async () => {
  const { runner } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'get_notifications' }), {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.backend, OPENCLI_BACKEND);
});

test('unadvertised actions are rejected before dispatch, at both layers', async () => {
  const { runner } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  // Contract layer: validateSocialRequest rejects unadvertised names.
  assert.throws(
    () => validateSocialRequest({ platform: 'xiaohongshu', action: 'get_thread' }),
    (error: unknown) => error instanceof SocialError && error.code === 'unsupported_action',
  );
  // Worker layer: defensively rejects a valid SocialAction it does not advertise.
  const raw: SocialRequest = { platform: 'xiaohongshu', action: 'get_topic', limit: 20, topic: 'x' };
  await assert.rejects(
    worker.plans(raw, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'unsupported_action',
  );
});

// ── Closed argv mappings ──

test('opencli argv matches the verified 1.8.6 command shapes and always uses -f json', () => {
  const base = request({ action: 'search', query: '咖啡', postId: 'a'.repeat(24), user: 'u1' });
  assert.deepEqual(opencliArgvFor('search', base, 20), ['xiaohongshu', 'search', '咖啡', '--limit', '20', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_post', base, 20), ['xiaohongshu', 'note', `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`, '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_comments', base, 20), ['xiaohongshu', 'comments', `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`, '--limit', '20', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_comments', base, 100), ['xiaohongshu', 'comments', `https://www.xiaohongshu.com/explore/${'a'.repeat(24)}`, '--limit', '50', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_user_posts', base, 20), ['xiaohongshu', 'user', 'u1', '--limit', '20', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_feed', base, 20), ['xiaohongshu', 'feed', '--limit', '20', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_saved', base, 20), ['xiaohongshu', 'saved', '--limit', '20', '-f', 'json']);
  assert.deepEqual(opencliArgvFor('get_notifications', base, 20), ['xiaohongshu', 'notifications', '--limit', '20', '-f', 'json']);
  for (const action of SOCIAL_CANONICAL_ACTIONS.xiaohongshu) {
    const argv = opencliArgvFor(action, base, 20);
    if (argv === undefined) continue;
    assert.deepEqual(argv.slice(-2), ['-f', 'json'], action);
  }
});

test('opencli get_post and get_comments pass the request URL when supplied', () => {
  const withUrl = request({ action: 'get_post', url: 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=tok123&source=web' });
  assert.equal(opencliArgvFor('get_post', withUrl, 20)?.[2], 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=tok123&source=web');
});

test('opencli get_notifications maps feedVariant to the closed --type enum', () => {
  const base = request({ action: 'get_notifications' });
  assert.deepEqual(opencliArgvFor('get_notifications', { ...base, feedVariant: 'likes' }, 20), ['xiaohongshu', 'notifications', '--type', 'likes', '--limit', '20', '-f', 'json']);
  // Unknown values reject instead of silently dropping the --type flag.
  assert.throws(
    () => opencliArgvFor('get_notifications', { ...base, feedVariant: 'bogus' }, 20),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  // The contract validator rejects them before argv building too.
  assert.throws(
    () => validateSocialRequest({ platform: 'xiaohongshu', action: 'get_notifications', feedVariant: 'bogus' }),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
});

test('opencli get_comments includeReplies adds --with-replies', () => {
  const base = request({ action: 'get_comments', postId: 'a'.repeat(24), includeReplies: true });
  assert.ok(opencliArgvFor('get_comments', base, 20)?.includes('--with-replies'));
});

test('xhs-cli argv matches the verified 0.1.4 command shapes', () => {
  const base = request({ action: 'search', query: '咖啡', postId: 'a'.repeat(24), user: 'u1' });
  assert.deepEqual(xhsCliArgvFor('search', base, 20), ['search', '咖啡', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_post', base, 20), ['read', 'a'.repeat(24), '--json']);
  assert.deepEqual(xhsCliArgvFor('get_comments', base, 20), ['read', 'a'.repeat(24), '--comments', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_profile', base, 20), ['user', 'u1', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_user_posts', base, 20), ['user-posts', 'u1', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_followers', base, 20), ['followers', 'u1', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_following', base, 20), ['following', 'u1', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_feed', base, 20), ['feed', '--json']);
  assert.deepEqual(xhsCliArgvFor('get_saved', base, 100), ['favorites', '--max', '100', '--json']);
});

test('xhs-cli get_comments never dispatches xhs comments or xhs hot', () => {
  const base = request({ action: 'get_comments', query: 'q', postId: 'a'.repeat(24), user: 'u1' });
  const argv = xhsCliArgvFor('get_comments', base, 20)!;
  assert.equal(argv[0], 'read');
  assert.ok(argv.includes('--comments'));
  assert.ok(!argv.includes('comments'));
  assert.ok(!argv.includes('hot'));
  for (const action of SOCIAL_CANONICAL_ACTIONS.xiaohongshu) {
    const candidate = xhsCliArgvFor(action, { ...base, action }, 20);
    if (candidate === undefined) continue;
    assert.ok(!candidate.includes('hot'), action);
    assert.ok(!candidate.includes('download'), action);
  }
});

test('no mutation or forbidden subcommand is ever generated for any action', () => {
  const forbidden = new Set([
    'comment', 'post', 'delete', 'like', 'unlike', 'favorite', 'unfavorite',
    'follow', 'unfollow', 'login', 'logout', 'topics', 'hot', 'download',
    'publish', 'drafts', 'draft-open', 'draft-clear', 'draft-delete',
    'ask', 'delete-note', 'creator-note-detail', 'creator-notes', 'creator-stats',
  ]);
  for (const action of SOCIAL_CANONICAL_ACTIONS.xiaohongshu) {
    const req = request({
      action,
      query: 'q',
      postId: 'a'.repeat(24),
      user: 'u1',
    });
    for (const argv of [opencliArgvFor(action, req, 20) ?? [], xhsCliArgvFor(action, req, 20) ?? []]) {
      if (argv.length === 0) continue;
      for (const token of argv) {
        assert.ok(!forbidden.has(token), `forbidden token ${token} in argv for ${action}`);
      }
      if (['search', 'read', 'user', 'user-posts', 'followers', 'following', 'feed', 'favorites'].includes(argv[0]!)) {
        assert.ok(!forbidden.has(argv[0]!), action);
      }
    }
  }
});

test('flag-shaped postId/user selectors are rejected before argv is built', () => {
  const base = request({ action: 'search', query: 'q', postId: 'a'.repeat(24), user: 'u1' });
  for (const postId of ['--xsec-token=tok123', '--dump-cookies', '--json', '-f']) {
    assert.throws(
      () => xhsCliArgvFor('get_post', { ...base, action: 'get_post', postId }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs get_post accepted ${postId}`,
    );
    assert.throws(
      () => xhsCliArgvFor('get_comments', { ...base, action: 'get_comments', postId }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs get_comments accepted ${postId}`,
    );
    assert.throws(
      () => opencliArgvFor('get_post', { ...base, action: 'get_post', postId }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `opencli get_post accepted ${postId}`,
    );
  }
  for (const user of ['--xsec-token=tok123', '--dump-cookies', '--json', '--max']) {
    assert.throws(
      () => xhsCliArgvFor('get_profile', { ...base, action: 'get_profile', user }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs get_profile accepted ${user}`,
    );
    assert.throws(
      () => xhsCliArgvFor('get_user_posts', { ...base, action: 'get_user_posts', user }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs get_user_posts accepted ${user}`,
    );
    assert.throws(
      () => opencliArgvFor('get_user_posts', { ...base, action: 'get_user_posts', user }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `opencli get_user_posts accepted ${user}`,
    );
  }
  for (const url of ['--dump-cookies', '--xsec-token=tok123', 'not a url', 'https://evil.example.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.throws(
      () => opencliArgvFor('get_post', { ...base, action: 'get_post', url }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `opencli get_post accepted url ${url}`,
    );
  }
});

test('malicious selectors never reach the runner: plans rejects with no invocation', async () => {
  const { runner, runs } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  const evil = request({ action: 'get_post', postId: 'a'.repeat(24) });
  await assert.rejects(
    worker.plans({ ...evil, postId: '--dump-cookies' }, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  await assert.rejects(
    worker.plans({ ...request({ action: 'get_profile', user: 'u1' }), user: '--xsec-token=tok123' }, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  assert.equal(runs.length, 0);
});

test('flag-shaped search queries are rejected before argv is built for both backends', () => {
  const base = request({ action: 'search', query: 'q' });
  for (const query of ['--json', '--limit 5', '--dump-cookies', '-f', '-', '--', '  --json']) {
    assert.throws(
      () => opencliArgvFor('search', { ...base, query }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `opencli search accepted ${query}`,
    );
    assert.throws(
      () => xhsCliArgvFor('search', { ...base, query }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs search accepted ${query}`,
    );
  }
});

test('missing/blank search queries are rejected before argv is built for both backends', () => {
  const base = request({ action: 'search', query: 'q' });
  for (const query of ['', '   ', '\t\n ']) {
    assert.throws(
      () => opencliArgvFor('search', { ...base, query }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `opencli search accepted blank ${JSON.stringify(query)}`,
    );
    assert.throws(
      () => xhsCliArgvFor('search', { ...base, query }, 20),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `xhs search accepted blank ${JSON.stringify(query)}`,
    );
  }
  const omitted: SocialRequest = { platform: 'xiaohongshu', action: 'search', limit: 20 };
  assert.throws(
    () => opencliArgvFor('search', omitted, 20),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  assert.throws(
    () => xhsCliArgvFor('search', omitted, 20),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
});

test('ordinary multilingual search queries still build argv for both backends', () => {
  for (const query of ['咖啡', 'hello world', 'coffee-shop', '2025 咖啡 日记', 'free - inside']) {
    const req = request({ action: 'search', query });
    assert.deepEqual(opencliArgvFor('search', req, 20), ['xiaohongshu', 'search', query, '--limit', '20', '-f', 'json']);
    assert.deepEqual(xhsCliArgvFor('search', req, 20), ['search', query, '--json']);
  }
});

test('malicious search queries never reach the runner: plans rejects with no invocation', async () => {
  const { runner, runs } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  await assert.rejects(
    worker.plans({ ...request({ action: 'search', query: 'q' }), query: '--json' }, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  await assert.rejects(
    worker.plans({ ...request({ action: 'search', query: 'q' }), query: '   ' }, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  assert.equal(runs.length, 0);
});

test('verified id shapes still build argv: 24-hex notes and fixture user ids', () => {
  const upper = request({ action: 'get_post', postId: 'AAAAAAAAAAAAAAAAAAAAAAAA', user: 'user-9' });
  assert.deepEqual(xhsCliArgvFor('get_post', upper, 20), ['read', 'AAAAAAAAAAAAAAAAAAAAAAAA', '--json']);
  assert.deepEqual(
    opencliArgvFor('get_post', upper, 20),
    ['xiaohongshu', 'note', 'https://www.xiaohongshu.com/explore/AAAAAAAAAAAAAAAAAAAAAAAA', '-f', 'json'],
  );
  for (const user of ['u1', 'user-1', 'user-9', 'red_id_1']) {
    const req = request({ action: 'get_profile', user });
    assert.deepEqual(xhsCliArgvFor('get_profile', req, 20), ['user', user, '--json']);
    assert.deepEqual(xhsCliArgvFor('get_followers', { ...req, action: 'get_followers' }, 20), ['followers', user, '--json']);
    assert.deepEqual(xhsCliArgvFor('get_following', { ...req, action: 'get_following' }, 20), ['following', user, '--json']);
  }
});

test('opencli run receives openCliChildEnv with OPENCLI_* pass-through and secret filtering', async () => {
  const { runner, runs } = fakeRunner([{ code: 0, stdout: '[]', stderr: '' }]);
  const childEnv = {
    ...SENTINEL_ENV,
    OPENCLI_HOST: 'cli.example',
    OPENCLI_PORT: '9222',
    OPENCLI_TOKEN: 'operator-token-abc',
  };
  const worker = createXiaohongshuWorker({ runner, childEnv });
  const plans = await worker.plans(request({ action: 'get_feed' }), {});
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    await plan.execute();
  }
  const opencliRun = runs.find((run) => run.command === 'opencli' || plans[0]!.backend === OPENCLI_BACKEND && run.args[0] === 'xiaohongshu') ?? runs[0]!;
  assert.equal(opencliRun.env['OPENCLI_HOST'], 'cli.example');
  assert.equal(opencliRun.env['OPENCLI_PORT'], '9222');
  assert.equal(opencliRun.env['OPENCLI_TOKEN'], 'operator-token-abc');
  assert.equal(opencliRun.env['PATH'], '/usr/bin:/bin');
  for (const secret of ['XHS_COOKIE', 'A1_COOKIE', 'WEB_SESSION_COOKIE', 'MY_API_KEY', 'ACCESS_TOKEN', 'NPM_CONFIG_TOKEN']) {
    assert.ok(!(secret in opencliRun.env), `${secret} must not reach opencli env`);
  }
});

test('xhs run keeps the python allowlist and never inherits secret-bearing env', async () => {
  const { runner, runs } = fakeRunner([{ code: 0, stdout: '[]', stderr: '' }]);
  const childEnv = {
    ...SENTINEL_ENV,
    OPENCLI_HOST: 'cli.example',
    OPENCLI_PORT: '9222',
    OPENCLI_TOKEN: 'operator-token-abc',
  };
  const worker = createXiaohongshuWorker({ runner, childEnv });
  const plans = await worker.plans(request({ action: 'get_feed' }), {});
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    await plan.execute();
  }
  const expected = buildPythonChildEnvironment(childEnv);
  for (const secret of ['XHS_COOKIE', 'A1_COOKIE', 'WEB_SESSION_COOKIE', 'MY_API_KEY', 'ACCESS_TOKEN', 'NPM_CONFIG_TOKEN']) {
    assert.ok(!(secret in expected), `${secret} must not pass the allowlist`);
  }
  const xhsRun = runs[runs.length - 1]!;
  assert.deepEqual(xhsRun.env, expected);
  assert.ok(!('OPENCLI_HOST' in xhsRun.env), 'OPENCLI_HOST must not reach xhs env');
  assert.ok(!('OPENCLI_PORT' in xhsRun.env), 'OPENCLI_PORT must not reach xhs env');
  assert.ok(!('OPENCLI_TOKEN' in xhsRun.env), 'OPENCLI_TOKEN must not reach xhs env');
});

test('option-shaped query never spawns: plans rejects with no invocation', async () => {
  const { runner, runs } = fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner });
  await assert.rejects(
    worker.plans({ ...request({ action: 'search', query: 'q' }), query: '--xsec-token=sentinel-cred-1' }, {}),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  assert.equal(runs.length, 0);
});

test('subprocess failure diagnostics redact exact OPENCLI_TOKEN echo plus XHS/xsec labels', async () => {
  const token = 'opencli-exact-token-999';
  const stderr = [
    `auth failed with ${token}`,
    'OPENCLI_TOKEN=opencli-labeled-token-123',
    'XHS_COOKIE=session-secret-abc',
    'xsec_token=xsec-secret-xyz',
  ].join('\n');
  const { runner } = fakeRunner([{ code: 1, stdout: '', stderr }]);
  const worker = createXiaohongshuWorker({ runner, childEnv: { ...SENTINEL_ENV, OPENCLI_TOKEN: token } });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  const error = await plans[0]!.execute().then(
    () => { throw new Error('expected upstream_error'); },
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof SocialError && error.code === 'upstream_error');
  for (const leaked of [token, 'opencli-labeled-token-123', 'session-secret-abc', 'xsec-secret-xyz']) {
    assert.ok(!error.message.includes(leaked), `leaked secret: ${leaked}`);
  }
});

// ── Plan execution ──

test('execute parses exit-0 JSON payloads', async () => {
  const payload = [{ id: 'x' }];
  const { runner } = fakeRunner([{ code: 0, stdout: JSON.stringify(payload), stderr: '' }]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  assert.deepEqual(await plans[1]!.execute(), payload);
});

test('exit 127 maps to backend_unavailable (non-retryable)', async () => {
  const { runner } = fakeRunner([{ code: 127, stdout: '', stderr: 'not found' }]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  await assert.rejects(
    plans[1]!.execute(),
    (error: unknown) => error instanceof SocialError && error.code === 'backend_unavailable' && error.retryable === false,
  );
});

test('non-zero exits map to retryable upstream_error', async () => {
  const { runner } = fakeRunner([{ code: 77, stdout: '', stderr: 'login expired' }]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  await assert.rejects(
    plans[1]!.execute(),
    (error: unknown) => error instanceof SocialError && error.code === 'upstream_error' && error.retryable === true,
  );
});

test('exit 0 with empty stdout maps to malformed_upstream', async () => {
  const { runner } = fakeRunner([{ code: 0, stdout: '', stderr: '' }]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  await assert.rejects(
    plans[1]!.execute(),
    (error: unknown) => error instanceof SocialError && error.code === 'malformed_upstream',
  );
});

test('exit 0 with non-JSON stdout maps to malformed_upstream', async () => {
  const { runner } = fakeRunner([{ code: 0, stdout: 'not json at all', stderr: '' }]);
  const worker = createXiaohongshuWorker({ runner });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  await assert.rejects(
    plans[1]!.execute(),
    (error: unknown) => error instanceof SocialError && error.code === 'malformed_upstream',
  );
});

test('abort propagates and never falls through', async () => {
  const controller = new AbortController();
  fakeRunner([]);
  const worker = createXiaohongshuWorker({ runner: async (run) => {
    run.signal?.addEventListener('abort', () => {
      throw new Error('unused');
    }, { once: true });
    const failure = new Error('aborted during dispatch');
    failure.name = 'AbortError';
    throw failure;
  } });
  const plans = await worker.plans(request({ action: 'search', query: 'q' }), {});
  controller.abort();
  await assert.rejects(
    plans[1]!.execute(controller.signal),
    (error: unknown) => (error as Error).name === 'AbortError',
  );
});

// ── xhs-cli normalization ──

const NOTE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

const XHS_SEARCH_FIXTURE = [
  {
    id: NOTE_ID,
    xsec_token: 'tok123',
    note_card: {
      display_title: '咖啡日记',
      user: { user_id: 'user-1', nickname: '作者一' },
      interact_info: { liked_count: '1.2万' },
      type: 'normal',
    },
  },
  { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', note_card: { display_title: '第二篇' } },
];

function xhsNormalize(action: SocialAction, payload: unknown, input: Partial<SocialRequest> = {}) {
  const worker = createXiaohongshuWorker({ runner: fakeRunner([]).runner });
  const req = request({ action, ...input });
  return worker.normalize(req, { backend: XHS_BACKEND, authTier: 'cookie', pagination: 'none', execute: async () => payload }, payload);
}

test('xhs-cli search normalizes rows into social_reference entities', () => {
  const page = xhsNormalize('search', XHS_SEARCH_FIXTURE, { query: '咖啡' });
  assert.equal(page.entities.length, 2);
  assert.equal(page.entities[0]!.kind, 'social_reference');
  assert.equal(page.entities[0]!.platformId, NOTE_ID);
  assert.equal((page.entities[0] as { title?: string }).title, '咖啡日记');
  const author = (page.entities[0] as { author?: { displayName?: string } }).author;
  assert.equal(author?.displayName, '作者一');
  assert.equal((page.entities[0] as { metrics?: { likes?: number } }).metrics?.likes, 12000);
  assert.ok(page.entities[0]!.url!.includes('explore/aaaaaaaaaaaaaaaaaaaaaaaa'));
  assert.ok(validateSocialPage(page).ok);
});

test('xsec_token never reaches normalized output', () => {
  const page = xhsNormalize('search', XHS_SEARCH_FIXTURE, { query: '咖啡' });
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes('tok123'));
  assert.ok(!serialized.includes('xsec_token'));
  const rowUrl = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?xsec_token=tok123&source=web';
  assert.equal(stripXsecToken(rowUrl), 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa?source=web');
  assert.equal(stripXsecToken('xsec_token=tok123 and plain text'), 'xsec_token=*** and plain text');
});

test('xsec_token embedded in title/desc/nickname is stripped from normalized output', () => {
  const payload = {
    note: {
      note_id: NOTE_ID,
      title: 'deal xsec_token=SECRET-TITLE here',
      desc: 'body with xsec_token=SECRET-DESC inside',
      user: { user_id: 'user-1', nickname: 'nick xsec_token=SECRET-NICK' },
    },
  };
  const page = xhsNormalize('get_post', payload, { postId: NOTE_ID });
  const serialized = JSON.stringify(page);
  for (const secret of ['SECRET-TITLE', 'SECRET-DESC', 'SECRET-NICK']) {
    assert.ok(!serialized.includes(secret), `token leaked into output: ${secret}`);
  }
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli get_post builds exactly one social_post with metrics', () => {
  const payload = {
    note: {
      note_id: NOTE_ID,
      title: '标题',
      desc: '正文内容',
      user: { user_id: 'user-1', nickname: '作者一' },
      interact_info: { liked_count: '42', collected_count: '7', comment_count: 3, share_count: '1' },
      time: 1700000000000,
    },
  };
  const page = xhsNormalize('get_post', payload, { postId: NOTE_ID });
  assert.equal(page.entities.length, 1);
  const post = page.entities[0]! as unknown as { kind: string; contentType: string; metrics?: Record<string, number>; publishedAt?: string };
  assert.equal(post.kind, 'social_post');
  assert.equal(post.contentType, 'note');
  assert.deepEqual(post.metrics, { likes: 42, saves: 7, comments: 3, shares: 1 });
  assert.equal(page.pagination.returned, 1);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.supported, false);
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli get_comments emits post then comments with namespaced ids', () => {
  const payload = {
    note: { note_id: NOTE_ID, title: '标题', desc: '正文' },
    comments: [
      {
        id: 'c1',
        content: '第一评论',
        user_info: { user_id: 'user-2', nickname: '评论者' },
        like_count: '5',
        create_time: 1700000000000,
      },
      { content: 'no id row' },
    ],
  };
  const page = xhsNormalize('get_comments', payload, { postId: NOTE_ID });
  assert.equal(page.entities.length, 2);
  assert.equal(page.entities[0]!.kind, 'social_post');
  assert.equal(page.entities[1]!.kind, 'social_comment');
  assert.equal((page.entities[1] as { postId: string }).postId, page.entities[0]!.id);
  assert.equal(page.partial, true);
  assert.ok(page.warnings.some((warning) => warning.includes('comment')));
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli get_post without note throws not_found', () => {
  assert.throws(
    () => xhsNormalize('get_post', { note: undefined }, { postId: NOTE_ID }),
    (error: unknown) => error instanceof SocialError && error.code === 'not_found',
  );
  assert.throws(
    () => xhsNormalize('get_post', {}, { postId: NOTE_ID }),
    (error: unknown) => error instanceof SocialError && error.code === 'not_found',
  );
});

test('xhs-cli get_profile maps userPageData/basicInfo and interaction stats', () => {
  const payload = {
    userPageData: {
      basicInfo: { nickname: '昵称', redId: 'red_id_1', userId: 'user-9', desc: '简介' },
      interactions: [
        { name: 'fans', count: '1000' },
        { name: 'follows', count: '12' },
        { name: '获赞与收藏', count: 'not-a-number' },
      ],
    },
  };
  const page = xhsNormalize('get_profile', payload, { user: 'user-9' });
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]!.kind, 'social_account');
  const profile = page.entities[0] as unknown as { handle?: string; displayName?: string; metrics?: Record<string, number> };
  assert.equal(profile.handle, 'red_id_1');
  assert.equal(profile.displayName, '昵称');
  assert.deepEqual(profile.metrics, { followers: 1000, following: 12 });
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli followers rows become account entities; rows without id are dropped as partial', () => {
  const payload = [
    { userId: 'user-1', nickname: '甲', redId: 'r1' },
    { nickname: '没有id' },
  ];
  const page = xhsNormalize('get_followers', payload, { user: 'user-9' });
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]!.kind, 'social_account');
  assert.equal(page.partial, true);
  assert.ok(page.warnings.some((warning) => warning.includes('user row without id')));
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli feed rows become social_post entities and malformed rows set partial', () => {
  const payload = [
    { id: NOTE_ID, note_card: { display_title: '第一', interact_info: { liked_count: 9 } } },
    { nope: true },
  ];
  const page = xhsNormalize('get_feed', payload);
  assert.equal(page.entities.length, 1);
  assert.equal(page.partial, true);
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli empty listings return a valid success page with zero entities', () => {
  const page = xhsNormalize('search', [], { query: '无结果' });
  assert.equal(page.entities.length, 0);
  assert.equal(page.pagination.returned, 0);
  assert.equal(page.partial, false);
  assert.ok(validateSocialPage(page).ok);
});

test('xhs-cli results are sliced to the request limit with a truncation warning', () => {
  const payload = [
    { id: 'c'.repeat(24), note_card: { display_title: 'note a' } },
    { id: 'd'.repeat(24), note_card: { display_title: 'note b' } },
    { id: 'e'.repeat(24), note_card: { display_title: 'note c' } },
  ];
  const page = xhsNormalize('get_feed', payload, { limit: 2 });
  assert.equal(page.entities.length, 2);
  assert.ok(page.warnings.some((warning) => warning.includes('truncated')));
  assert.equal(page.pagination.hasMore, true);
  assert.equal(page.partial, true);
});

test('xhs-cli get_post keeps the post when comment entities are also present', () => {
  const payload = {
    note: { note_id: NOTE_ID, title: '标题', desc: '正文' },
    comments: [{ id: 'c1', content: '第一评论' }],
  };
  const page = xhsNormalize('get_post', payload, { postId: NOTE_ID });
  assert.equal(page.entities[0]!.kind, 'social_post');
  assert.equal(page.entities.length, 2);
  assert.ok(validateSocialPage(page).ok);
});

// ── opencli normalization ──

function opencliNormalize(action: SocialAction, payload: unknown, input: Partial<SocialRequest> = {}) {
  const worker = createXiaohongshuWorker({ runner: fakeRunner([]).runner });
  const req = request({ action, ...input });
  return worker.normalize(req, { backend: OPENCLI_BACKEND, authTier: 'cookie', pagination: 'none', execute: async () => payload }, payload);
}

test('opencli feed rows become social_post entities with stripped URLs', () => {
  const payload = [
    { id: NOTE_ID, title: '首页推荐', author: '作者一', likes: '1.5万', type: 'normal', url: `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=zzz` },
    { title: '无id行' },
  ];
  const page = opencliNormalize('get_feed', payload);
  assert.equal(page.entities.length, 2);
  const post = page.entities[0] as { kind: string; url?: string; metrics?: Record<string, number>; platformId?: string };
  assert.equal(post.kind, 'social_post');
  assert.equal(post.platformId, NOTE_ID);
  assert.equal(post.url, `https://www.xiaohongshu.com/explore/${NOTE_ID}`);
  assert.equal(post.metrics?.likes, 15000);
  assert.ok(page.warnings.some((warning) => warning.includes('content hash')));
  assert.ok(validateSocialPage(page).ok);
});

test('opencli search rows become social_reference entities; url-derived ids accepted', () => {
  const payload = [
    { rank: 1, title: '第一条', author: '作者', likes: '10', published_at: '2025-01-01T00:00:00Z', url: `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=secret-token` },
  ];
  const page = opencliNormalize('search', payload, { query: '咖啡' });
  assert.equal(page.entities.length, 1);
  const reference = page.entities[0] as { kind: string; platformId?: string; url?: string; publishedAt?: string };
  assert.equal(reference.kind, 'social_reference');
  assert.equal(reference.platformId, NOTE_ID);
  assert.ok(!reference.url!.includes('secret-token'));
  assert.ok(!reference.url!.includes('xsec_token'));
  assert.equal(reference.publishedAt, '2025-01-01T00:00:00.000Z');
  assert.ok(validateSocialPage(page).ok);
});

test('opencli get_post field/value rows build one post; missing id throws not_found', () => {
  const payload = [
    { field: 'note_id', value: NOTE_ID },
    { field: 'title', value: '标题' },
    { field: 'desc', value: '内容' },
    { field: 'liked_count', value: '5' },
    { field: 'user_id', value: 'user-1' },
    { field: 'nickname', value: '作者' },
    { field: 'time', value: 1700000000 },
  ];
  const page = opencliNormalize('get_post', payload, { postId: NOTE_ID });
  assert.equal(page.entities.length, 1);
  const post = page.entities[0] as { metrics?: Record<string, number>; author?: { id?: string; displayName?: string } };
  assert.deepEqual(post.metrics, { likes: 5 });
  assert.equal(post.author?.id, 'user-1');
  assert.equal(post.author?.displayName, '作者');
  assert.ok(validateSocialPage(page).ok);
  // Missing id with no request.postId: worker-level not_found via a hand-built request.
  const raw: SocialRequest = { platform: 'xiaohongshu', action: 'get_post', limit: 20 };
  assert.throws(
    () => workerForNormalize().normalize(raw, opencliPlan(), [{ field: 'title', value: 'no id here' }]),
    (error: unknown) => error instanceof SocialError && error.code === 'not_found',
  );
});

function workerForNormalize() {
  return createXiaohongshuWorker({ runner: fakeRunner([]).runner });
}

function opencliPlan() {
  return { backend: OPENCLI_BACKEND, authTier: 'cookie' as const, pagination: 'none' as const, execute: async () => undefined };
};

test('opencli get_post malformed field rows set partial', () => {
  const payload = [
    { field: 'note_id', value: NOTE_ID },
    { junk: true },
  ];
  const page = opencliNormalize('get_post', payload, { postId: NOTE_ID });
  assert.equal(page.entities.length, 1);
  assert.equal(page.partial, true);
});

test('opencli comment rows become social_comment entities with parent links', () => {
  const payload = [
    { rank: 1, author: '评论者', userId: 'user-2', profileUrl: 'https://www.xiaohongshu.com/user/profile/user-2', text: '好文', likes: '3', time: '2025-01-02T03:04:05Z', is_reply: false },
    { rank: 2, author: '回复者', userId: 'user-3', text: '回复', reply_to: 'user-2:1' },
    { rank: 3, text: '' },
  ];
  const page = opencliNormalize('get_comments', payload, { postId: NOTE_ID });
  assert.equal(page.entities.length, 2);
  const first = page.entities[0] as { postId: string; author?: { id?: string; profileUrl?: string } };
  assert.equal(first.postId, `xiaohongshu:social_post:${NOTE_ID}`);
  assert.equal(first.author?.id, 'user-2');
  const second = page.entities[1] as { parentCommentId?: string };
  assert.equal(second.parentCommentId, 'xiaohongshu:social_comment:user-2:1');
  assert.equal(page.partial, true);
  assert.ok(validateSocialPage(page).ok);
});

test('opencli notifications rows become notification entities', () => {
  const payload = [
    { rank: 1, user: '某人', action: 'liked', content: '赞了你的笔记', time: '2025-01-01T00:00:00Z' },
  ];
  const page = opencliNormalize('get_notifications', payload);
  assert.equal(page.entities.length, 1);
  const notification = page.entities[0] as { kind: string; type?: string; text?: string; actor?: { displayName?: string } };
  assert.equal(notification.kind, 'social_notification');
  assert.equal(notification.type, 'liked');
  assert.equal(notification.actor?.displayName, '某人');
  assert.ok(page.warnings.length > 0);
  assert.ok(validateSocialPage(page).ok);
});

test('opencli non-array payload throws malformed_upstream', () => {
  assert.throws(
    () => opencliNormalize('search', { oops: true }, { query: 'q' }),
    (error: unknown) => error instanceof SocialError && error.code === 'malformed_upstream',
  );
});

// ── Cross-cutting ──

test('all normalized pages from either backend pass envelope validation', async () => {
  const cases: Array<{ backend: string; action: SocialAction; payload: unknown; input?: Partial<SocialRequest> }> = [
    { backend: XHS_BACKEND, action: 'search', payload: XHS_SEARCH_FIXTURE, input: { query: '咖啡' } },
    { backend: XHS_BACKEND, action: 'get_feed', payload: [{ id: NOTE_ID, note_card: { display_title: 'x' } }] },
    { backend: XHS_BACKEND, action: 'get_followers', payload: [{ userId: 'u1', nickname: 'n' }], input: { user: 'u9' } },
    { backend: OPENCLI_BACKEND, action: 'get_feed', payload: [{ id: NOTE_ID, title: 't' }] },
    { backend: OPENCLI_BACKEND, action: 'search', payload: [{ rank: 1, title: 't' }], input: { query: 'q' } },
  ];
  const worker = xiaohongshuWorker;
  for (const entry of cases) {
    const req = request({ action: entry.action, ...entry.input });
    const page = worker.normalize(req, { backend: entry.backend, authTier: 'cookie', pagination: 'none', execute: async () => entry.payload }, entry.payload);
    const check = validateSocialPage(page);
    assert.equal(check.ok, true, `${entry.backend}/${entry.action}: ${check.issues.join('; ')}`);
  }
});

test('worker platforms declares only xiaohongshu', () => {
  assert.deepEqual(xiaohongshuWorker.platforms, ['xiaohongshu']);
});

test('every advertised xiaohongshu action has a selector spec entry', () => {
  for (const action of SOCIAL_CANONICAL_ACTIONS.xiaohongshu) {
    const spec = selectorSpecFor('xiaohongshu', action);
    assert.ok(spec !== undefined, action);
  }
  assert.deepEqual(canonicalActionsFor('xiaohongshu'), SOCIAL_CANONICAL_ACTIONS.xiaohongshu);
});

test('backendSupportsAction agrees with declared operations', () => {
  assert.equal(backendSupportsAction(XHS_CLI_CAPABILITY, 'get_profile'), true);
  assert.equal(backendSupportsAction(OPENCLI_XIAOHONGSHU_CAPABILITY, 'get_profile'), false);
  assert.equal(backendSupportsAction(OPENCLI_XIAOHONGSHU_CAPABILITY, 'get_notifications'), true);
});

test('invalid/malicious URL input never echoes in the thrown message', () => {
  const base = request({ action: 'get_post', postId: 'a'.repeat(24) });
  for (const url of [
    'https://evil.example.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa',
    'https://evil.example.com.evil.com/?q=1',
    'https://xiaohongshu.com.evil.example.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa',
    'not a url',
    '--dump-cookies',
  ]) {
    assert.throws(
      () => opencliArgvFor('get_post', { ...base, action: 'get_post', url }, 20),
      (error: unknown) => {
        if (!(error instanceof SocialError) || error.code !== 'invalid_request') return false;
        assert.ok(!error.message.includes(url), `echoed input: ${url}`);
        assert.ok(!error.message.includes('evil.example.com'));
        return true;
      },
      `opencli get_post accepted url ${url}`,
    );
  }
});