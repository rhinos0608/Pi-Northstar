// Tests for the Stage 2 Twitter social worker (src/social-twitter.ts).
// Covers: closed argv mapping (no download/write/file-output/mutation
// tokens), backend plan ordering and capability coverage, sanitized Python
// child environment, execution error mapping, and fixture normalization for
// twitter-cli 0.8.5 and OpenCLI 1.8.6 output shapes.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SOCIAL_CANONICAL_ACTIONS,
  SocialError,
  backendSupportsAction,
  validateSocialRequest,
  type SocialBackendPlan,
  type SocialAction,
} from '../../src/social/social-contract.js';
import {
  SocialTwitterWorker,
  TWITTER_BACKEND_CAPABILITIES,
  openCliTwitterArgs,
  twitterCliArgs,
  type SocialCliInvocation,
  type SocialTwitterWorkerOptions,
} from '../../src/social/social-twitter.js';

// ── Helpers ──

function request(action: SocialAction, overrides: Record<string, unknown> = {}) {
  return validateSocialRequest({ platform: 'twitter', action, limit: 20, ...overrides }).request;
}

function cliPlan(): SocialBackendPlan {
  return { backend: 'twitter-cli', authTier: 'cookie', pagination: 'none', execute: async () => undefined };
}

function openCliPlan(): SocialBackendPlan {
  return { backend: 'opencli-twitter', authTier: 'cookie', pagination: 'none', execute: async () => undefined };
}

function socialErrorOf(code: string, run: () => unknown): void {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

interface RecordedInvocation {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
}

function workerWithRunner(
  runner: (invocation: SocialCliInvocation) => Promise<{ code: number; stdout: string; stderr: string }>,
  options: { parentEnv?: Record<string, string | undefined> } = {},
): { worker: SocialTwitterWorker; recorded: RecordedInvocation[] } {
  const recorded: RecordedInvocation[] = [];
  const workerOptions: SocialTwitterWorkerOptions = {
    runner: async (invocation) => {
      recorded.push({ command: invocation.command, args: invocation.args, env: invocation.env });
      return runner(invocation);
    },
  };
  if (options.parentEnv !== undefined) workerOptions.parentEnv = options.parentEnv;
  return { worker: new SocialTwitterWorker(workerOptions), recorded };
}

// ── Fixture shapes (pinned to twitter-cli 0.8.5 / OpenCLI 1.8.6) ──

const TWITTER_CLI_TWEET = {
  id: '1001',
  text: 'root tweet body',
  author: {
    id: 'ua',
    name: 'Author A',
    screenName: 'authora',
    profileImageUrl: 'https://pbs.twimg.com/a.jpg',
    verified: false,
  },
  metrics: { likes: 100, retweets: 10, replies: 2, quotes: 1, views: 8000, bookmarks: 8 },
  createdAt: 'Sat Mar 08 12:10:00 +0000 2026',
  createdAtISO: '2026-03-08T12:10:00.000Z',
  media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/a.jpg', width: 1280, height: 720 }],
  isRetweet: false,
  lang: 'en',
};

const TWITTER_CLI_REPLY = { ...TWITTER_CLI_TWEET, id: '1002', text: 'reply body' };

const TWITTER_CLI_USER = {
  id: 'u1',
  name: 'Author A',
  screenName: 'authora',
  bio: 'hello world',
  location: 'Earth',
  url: '',
  followers: 1234,
  following: 42,
  tweets: 77,
  likes: 7,
  verified: true,
  profileImageUrl: 'https://pbs.twimg.com/a.jpg',
  createdAt: 'Sat Mar 08 10:00:00 +0000 2026',
  createdAtISO: '2026-03-08T10:00:00.000Z',
};

const OPENCLI_TWEET = {
  id: '2002',
  author: 'authorb',
  bio: '',
  name: 'Author B',
  text: 'opencli tweet body',
  likes: 12,
  retweets: 4,
  replies: 1,
  views: 4321,
  created_at: 'Sat Mar 08 13:00:00 +0000 2026',
  url: 'https://x.com/authorb/status/2002',
  has_media: true,
  media_urls: ['https://video-high.mp4'],
  media_posters: ['https://pbs.twimg.com/thumb.jpg'],
};

const OPENCLI_PROFILE = [{
  screen_name: 'authora',
  name: 'Author A',
  bio: 'hello world',
  location: 'Earth',
  url: 'https://example.com/site',
  followers: 555,
  following: 6,
  tweets: 77,
  likes: 8,
  verified: true,
  created_at: 'Sat Mar 08 10:00:00 +0000 2026',
}];

const OPENCLI_TREND = [
  { rank: 1, topic: 'TypeScript', category: 'Technology · Trending' },
  { rank: 2, topic: 'Pi Agent', category: '' },
];

const OPENCLI_NOTIFICATION = [
  { id: 'n1', action: 'Mention', author: 'authorb', text: 'mentioned you', url: 'https://x.com/i/status/2002' },
  { id: 'n2', action: 'Follow', author: 'authorc', text: '', url: 'https://x.com/notifications' },
];

// ── Capability coverage ──

test('every advertised twitter action has at least one verified backend operation', () => {
  for (const action of SOCIAL_CANONICAL_ACTIONS.twitter) {
    const supported = TWITTER_BACKEND_CAPABILITIES.some((capability) => backendSupportsAction(capability, action));
    assert.ok(supported, `${action} has no backend operation`);
  }
});

test('every backend operation references an advertised twitter action', () => {
  for (const capability of TWITTER_BACKEND_CAPABILITIES) {
    for (const operation of capability.operations) {
      assert.ok(
        (SOCIAL_CANONICAL_ACTIONS.twitter as readonly string[]).includes(operation.action),
        `${capability.name} advertises unlisted action ${operation.action}`,
      );
    }
  }
});

test('twitter-cli has no trending or notifications read operation', () => {
  const capability = TWITTER_BACKEND_CAPABILITIES[0]!;
  assert.equal(capability.operations.some((operation) => operation.action === 'get_trending'), false);
  assert.equal(capability.operations.some((operation) => operation.action === 'get_notifications'), false);
});

test('plans order twitter-cli before OpenCLI with cookie tier and pagination none', async () => {
  const worker = new SocialTwitterWorker();
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  assert.deepEqual(plans.map((plan) => plan.backend), ['twitter-cli', 'opencli-twitter']);
  assert.ok(plans.every((plan) => plan.authTier === 'cookie'));
  assert.ok(plans.every((plan) => plan.pagination === 'none'));
});

test('plans omit backends that cannot serve the action', async () => {
  const worker = new SocialTwitterWorker();
  const plans = await worker.plans(request('get_trending'), {});
  assert.deepEqual(plans.map((plan) => plan.backend), ['opencli-twitter']);
});

// ── Closed argv mapping ──

test('twitter-cli argv comes from the closed mapping', () => {
  const cases: Array<[SocialAction, Record<string, unknown>, string[]]> = [
    ['search', { query: 'pi agent' }, ['search', 'pi agent', '-n', '20', '--json']],
    ['search', { query: 'pi', sort: 'latest' }, ['search', 'pi', '-n', '20', '-t', 'latest', '--json']],
    ['search', { query: 'pi', timeRange: '2026-01-01' }, ['search', 'pi', '-n', '20', '--since', '2026-01-01', '--json']],
    ['get_post', { postId: '1001' }, ['tweet', '1001', '--json']],
    ['get_thread', { postId: '1001' }, ['tweet', '1001', '-n', '20', '--json']],
    ['get_comments', { postId: '1001' }, ['tweet', '1001', '-n', '20', '--json']],
    ['get_comment_replies', { commentId: '1002' }, ['tweet', '1002', '-n', '20', '--json']],
    ['get_profile', { user: '@authora' }, ['user', 'authora', '--json']],
    ['get_user_posts', { user: 'authora' }, ['user-posts', 'authora', '-n', '20', '--json']],
    ['get_followers', { user: 'authora' }, ['followers', 'authora', '-n', '20', '--json']],
    ['get_following', { user: 'authora' }, ['following', 'authora', '-n', '20', '--json']],
    ['get_feed', {}, ['feed', '-n', '20', '--json']],
    ['get_feed', { feedVariant: 'following' }, ['feed', '-n', '20', '-t', 'following', '--json']],
    ['get_saved', {}, ['bookmarks', '-n', '20', '--json']],
  ];
  for (const [action, overrides, expected] of cases) {
    assert.deepEqual(twitterCliArgs(request(action, overrides)), expected, `${action} argv mismatch`);
  }
});

test('opencli twitter argv always ends with -f json and never yaml', () => {
  const selectorFor: Partial<Record<SocialAction, Record<string, unknown>>> = {
    search: { query: 'pi' },
    get_post: { postId: '1001' },
    get_thread: { postId: '1001' },
    get_comments: { postId: '1001' },
    get_comment_replies: { commentId: '1002' },
    get_profile: { user: 'authora' },
    get_user_posts: { user: 'authora' },
    get_followers: { user: 'authora' },
    get_following: { user: 'authora' },
  };
  for (const action of SOCIAL_CANONICAL_ACTIONS.twitter) {
    const args = openCliTwitterArgs(request(action, selectorFor[action] ?? {}));
    assert.deepEqual(args.slice(-2), ['-f', 'json'], `${action}: opencli must use -f json`);
    assert.equal(args.some((arg) => arg === 'yaml'), false, `${action}: yaml leaked into argv`);
    if (action !== 'get_profile') {
      assert.ok(args.includes('--limit'), `${action}: limit not passed`);
    }
  }
});

const FORBIDDEN_ARGV_TOKENS: readonly string[] = [
  'download', '-o', '--output', '--markdown', '-m', 'login', 'post', 'like',
  'unlike', 'retweet', 'follow', 'unfollow', 'bookmark', 'delete', 'block',
  'hide-reply', 'list-create', 'list-delete',
];

test('no mutation/download/file-output token appears in generated argv', () => {
  const selectorFor: Partial<Record<SocialAction, Record<string, unknown>>> = {
    search: { query: 'pi' },
    get_post: { postId: '1001' },
    get_thread: { postId: '1001' },
    get_comments: { postId: '1001' },
    get_comment_replies: { commentId: '1002' },
    get_profile: { user: 'authora' },
    get_user_posts: { user: 'authora' },
    get_followers: { user: 'authora' },
    get_following: { user: 'authora' },
  };
  for (const action of SOCIAL_CANONICAL_ACTIONS.twitter) {
    let twitterArgv: string[];
    try {
      twitterArgv = twitterCliArgs(request(action, selectorFor[action] ?? {}));
    } catch (error) {
      // twitter-cli declares no operation for some actions (trending,
      // notifications): refusing before spawn is the correct closed behavior.
      assert.ok(error instanceof SocialError && error.code === 'backend_unavailable');
      twitterArgv = [];
    }
    const openCliArgv = openCliTwitterArgs(request(action, selectorFor[action] ?? {}));
    for (const token of FORBIDDEN_ARGV_TOKENS) {
      assert.equal(twitterArgv.includes(token), false, `${action}: forbidden token "${token}" in twitter-cli argv`);
      assert.equal(openCliArgv.includes(token), false, `${action}: forbidden token "${token}" in opencli argv`);
    }
    assert.equal(twitterArgv.some((arg) => arg.startsWith('--output')), false, `${action}: file-output flag in argv`);
    assert.equal(openCliArgv.some((arg) => arg.startsWith('--output')), false, `${action}: file-output flag in argv`);
  }
});

test('non-numeric tweet ids and bad handles are rejected before dispatch', () => {
  socialErrorOf('invalid_request', () => twitterCliArgs(request('get_thread', { postId: 'not-numeric' })));
  socialErrorOf('invalid_request', () => openCliTwitterArgs(request('get_profile', { user: 'bad handle!' })));
});

test('option-shaped search queries are rejected before spawn without echoing the value', async () => {
  for (const query of ['--limit', '-f json', '  --json ']) {
    const shaped = request('search', { query });
    try {
      twitterCliArgs(shaped);
      throw new Error(`twitterCliArgs accepted option-shaped query ${JSON.stringify(query)}`);
    } catch (error) {
      assert.ok(error instanceof SocialError && error.code === 'invalid_request');
      assert.equal(error.message.includes(query.trim()), false, 'twitter-cli rejection echoed the value');
    }
    try {
      openCliTwitterArgs(shaped);
      throw new Error(`openCliTwitterArgs accepted option-shaped query ${JSON.stringify(query)}`);
    } catch (error) {
      assert.ok(error instanceof SocialError && error.code === 'invalid_request');
      assert.equal(error.message.includes(query.trim()), false, 'opencli rejection echoed the value');
    }
  }
  const { worker, recorded } = workerWithRunner(() =>
    Promise.resolve({ code: 0, stdout: '[]', stderr: '' }),
  );
  await assert.rejects(worker.plans(request('search', { query: '--limit' }), {}), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'invalid_request');
    assert.equal(error.message.includes('--limit'), false, 'plans rejection echoed the value');
    return true;
  });
  assert.equal(recorded.length, 0, 'injected executor must not run for option-shaped queries');
});

test('opencli failure diagnostics redact labeled and exact token echoes', async () => {
  const token = 'operator-token-sentinel-9z8x';
  const worker = new SocialTwitterWorker({
    parentEnv: {
      PATH: '/usr/bin',
      OPENCLI_HOST: 'http://opencli.local',
      OPENCLI_PORT: '4567',
      OPENCLI_TOKEN: token,
    },
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: `boom: OPENCLI_TOKEN=${token} then unlabeled echo ${token} end`,
    }),
  });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  assert.equal(plans.length, 2);
  await assert.rejects(plans[1]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'upstream_error');
    assert.equal(error.message.includes(token), false, 'exact token echo leaked');
    assert.match(error.message, /\*\*\*/);
    return true;
  });
});

test('twitter-cli failure diagnostics redact labeled secret echoes', async () => {
  const worker = new SocialTwitterWorker({
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: 'boom: auth_token=topsecret-abc123; Cookie: session-secret-xyz',
    }),
  });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'upstream_error');
    assert.equal(error.message.includes('topsecret-abc123'), false, 'labeled auth_token leaked');
    assert.equal(error.message.includes('session-secret-xyz'), false, 'cookie echo leaked');
    assert.match(error.message, /\*\*\*/);
    return true;
  });
});

// ── Sanitized child environment ──

test('twitter-cli runs with buildPythonChildEnvironment: secrets stripped', async () => {
  const { worker, recorded } = workerWithRunner(
    () => Promise.resolve({ code: 0, stdout: JSON.stringify(TWITTER_CLI_USER), stderr: '' }),
    {
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/tester',
        TWITTER_AUTH_TOKEN: 'secret-token-value',
        TWITTER_CT0: 'secret-ct0-value',
        MY_API_KEY: 'leaky',
      },
    },
  );
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await plans[0]!.execute();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.command, 'twitter');
  const env = recorded[0]!.env;
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.TWITTER_AUTH_TOKEN, undefined);
  assert.equal(env.TWITTER_CT0, undefined);
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(JSON.stringify(env).toLowerCase().includes('secret'), false);
});

test('opencli-twitter passes OPENCLI_* through openCliChildEnv while secrets stay stripped', async () => {
  const { worker, recorded } = workerWithRunner(
    () => Promise.resolve({ code: 0, stdout: JSON.stringify(OPENCLI_PROFILE), stderr: '' }),
    {
      parentEnv: {
        PATH: '/usr/bin',
        OPENCLI_HOST: 'http://opencli.local',
        OPENCLI_PORT: '4567',
        OPENCLI_TOKEN: 'operator-token',
        MY_API_KEY: 'leaky',
        TWITTER_AUTH_TOKEN: 'secret-token-value',
        COOKIE: 'secret-cookie',
      },
    },
  );
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  assert.equal(plans.length, 2);
  await plans[1]!.execute();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.command, 'opencli');
  const env = recorded[0]!.env;
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.OPENCLI_HOST, 'http://opencli.local');
  assert.equal(env.OPENCLI_PORT, '4567');
  assert.equal(env.OPENCLI_TOKEN, 'operator-token');
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.TWITTER_AUTH_TOKEN, undefined);
  assert.equal(env.COOKIE, undefined);
  assert.equal(JSON.stringify(env).toLowerCase().includes('secret'), false);
  assert.equal(JSON.stringify(env).toLowerCase().includes('leaky'), false);
});

test('twitter-cli still uses the Python allowlist: OPENCLI_* and secrets stripped', async () => {
  const { worker, recorded } = workerWithRunner(
    () => Promise.resolve({ code: 0, stdout: JSON.stringify(TWITTER_CLI_USER), stderr: '' }),
    {
      parentEnv: {
        PATH: '/usr/bin',
        HOME: '/home/tester',
        OPENCLI_HOST: 'http://opencli.local',
        OPENCLI_PORT: '4567',
        OPENCLI_TOKEN: 'operator-token',
        MY_API_KEY: 'leaky',
        TWITTER_AUTH_TOKEN: 'secret-token-value',
      },
    },
  );
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await plans[0]!.execute();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.command, 'twitter');
  const env = recorded[0]!.env;
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.HOME, '/home/tester');
  assert.equal(env.OPENCLI_HOST, undefined);
  assert.equal(env.OPENCLI_PORT, undefined);
  assert.equal(env.OPENCLI_TOKEN, undefined);
  assert.equal(env.MY_API_KEY, undefined);
  assert.equal(env.TWITTER_AUTH_TOKEN, undefined);
  assert.equal(JSON.stringify(env).toLowerCase().includes('secret'), false);
});

// ── Execution error mapping ──

test('exit 127 maps to backend_unavailable', async () => {
  const worker = new SocialTwitterWorker({ runner: async () => ({ code: 127, stdout: '', stderr: '' }) });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'backend_unavailable');
    return true;
  });
});

test('rate-limited stderr maps to rate_limited with secrets scrubbed', async () => {
  const worker = new SocialTwitterWorker({
    runner: async () => ({
      code: 1,
      stdout: '',
      stderr: 'Rate limit exceeded; auth_token=SECRETVAL; ct0=OTHERSECRET',
    }),
  });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.message.includes('SECRETVAL'), false);
    assert.equal(error.message.includes('OTHERSECRET'), false);
    assert.ok(error.message.includes('***'));
    return true;
  });
});

test('generic nonzero exit maps to upstream_error', async () => {
  const worker = new SocialTwitterWorker({ runner: async () => ({ code: 1, stdout: '', stderr: 'boom' }) });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'upstream_error');
    return true;
  });
});

test('non-JSON output maps to malformed_upstream', async () => {
  const worker = new SocialTwitterWorker({ runner: async () => ({ code: 0, stdout: 'not json', stderr: '' }) });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof SocialError);
    assert.equal(error.code, 'malformed_upstream');
    return true;
  });
});

test('abort propagates as AbortError and never falls through', async () => {
  const worker = new SocialTwitterWorker({
    runner: async () => {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      throw error;
    },
  });
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  await assert.rejects(plans[0]!.execute(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    return true;
  });
});

test('successful execute returns the parsed JSON payload', async () => {
  const { worker, recorded } = workerWithRunner(
    () => Promise.resolve({ code: 0, stdout: JSON.stringify(TWITTER_CLI_USER), stderr: '' }),
  );
  const plans = await worker.plans(request('get_profile', { user: 'authora' }), {});
  assert.deepEqual(await plans[0]!.execute(), TWITTER_CLI_USER);
  assert.equal(recorded[0]!.command, 'twitter');
  assert.deepEqual(recorded[0]!.args, ['user', 'authora', '--json']);
});

// ── Normalization: twitter-cli fixtures ──

test('twitter-cli get_thread: root post first, then comments in source order', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_thread', { postId: '1001' }), cliPlan(), [
    TWITTER_CLI_TWEET,
    TWITTER_CLI_REPLY,
  ]);
  assert.equal(page.entities.length, 2);
  const root = page.entities[0]!;
  assert.equal(root.kind, 'social_post');
  assert.equal(root.id, 'twitter:social_post:1001');
  assert.equal(root.platformId, '1001');
  assert.equal(root.url, 'https://x.com/authora/status/1001');
  assert.equal(root.publishedAt, '2026-03-08T12:10:00.000Z');
  assert.equal((root as { threadId?: string }).threadId, '1001');
  const metrics = (root as { metrics?: { reposts?: number; saves?: number; views?: number } }).metrics;
  assert.equal(metrics?.reposts, 10);
  assert.equal(metrics?.saves, 8);
  assert.equal(metrics?.views, 8000);
  const comment = page.entities[1]!;
  assert.equal(comment.kind, 'social_comment');
  assert.equal(comment.id, 'twitter:social_comment:1002');
  assert.equal((comment as { postId: string }).postId, '1001');
  assert.equal((comment as { text: string }).text, 'reply body');
  assert.equal(page.pagination.supported, false);
  assert.equal(page.pagination.hasMore, false);
  assert.equal('nextCursor' in page.pagination, false);
});

test('twitter-cli media type photo maps to image with dimensions', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), [TWITTER_CLI_TWEET]);
  const post = page.entities[0] as { media?: Array<{ type?: string; url?: string; width?: number }> };
  assert.equal(post.media?.[0]?.type, 'image');
  assert.equal(post.media?.[0]?.url, 'https://pbs.twimg.com/media/a.jpg');
  assert.equal(post.media?.[0]?.width, 1280);
});

test('twitter-cli get_comments returns comments only, anchored to postId', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_comments', { postId: '1001' }), cliPlan(), [
    TWITTER_CLI_TWEET,
    TWITTER_CLI_REPLY,
  ]);
  assert.equal(page.entities.length, 1);
  const comment = page.entities[0] as { postId: string; text: string };
  assert.equal(comment.postId, '1001');
  assert.equal(comment.text, 'reply body');
});

test('twitter-cli get_comment_replies anchors parentCommentId to commentId', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_comment_replies', { commentId: '1002' }), cliPlan(), [
    { ...TWITTER_CLI_TWEET, id: '1002', text: 'the comment' },
    { ...TWITTER_CLI_TWEET, id: '1003', text: 'reply to comment' },
  ]);
  assert.equal(page.entities.length, 1);
  const comment = page.entities[0] as { parentCommentId?: string; postId: string };
  assert.equal(comment.parentCommentId, '1002');
  assert.equal(comment.postId, '1002');
});

test('twitter-cli get_post requires exactly one entity; empty payload is not_found', () => {
  const worker = new SocialTwitterWorker();
  const one = worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), [TWITTER_CLI_TWEET]);
  assert.equal(pageEntityCount(one), 1);
  socialErrorOf('not_found', () => worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), []));
});

function pageEntityCount(page: { entities: unknown[] }): number {
  return page.entities.length;
}

test('twitter-cli get_profile normalizes single user dict into one account', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_profile', { user: 'authora' }), cliPlan(), TWITTER_CLI_USER);
  assert.equal(page.entities.length, 1);
  const profile = page.entities[0] as { kind: string; id: string; handle?: string; url?: string; metrics?: { followers?: number; following?: number } };
  assert.equal(profile.kind, 'social_account');
  assert.equal(profile.id, 'twitter:social_account:authora');
  assert.equal(profile.handle, 'authora');
  assert.equal(profile.metrics?.followers, 1234);
  assert.equal(profile.metrics?.following, 42);
});

test('twitter-cli get_followers maps rows to account entities', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_followers', { user: 'authora' }), cliPlan(), [
    TWITTER_CLI_USER,
    { ...TWITTER_CLI_USER, id: 'u2', screenName: 'authorb' },
  ]);
  assert.equal(page.entities.length, 2);
  assert.ok(page.entities.every((entity) => entity.kind === 'social_account'));
});

test('twitter-cli search drops malformed rows and flags partial with warnings', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('search', { query: 'pi' }), cliPlan(), [
    TWITTER_CLI_TWEET,
    { text: 'no id here' },
    { id: '1002' },
  ]);
  assert.equal(page.entities.length, 1);
  assert.equal(page.partial, true);
  assert.ok(page.warnings.length >= 2);
});

test('twitter-cli article rows become article content type with title', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), [{
    ...TWITTER_CLI_TWEET,
    articleTitle: 'Long read',
    articleText: 'article body',
  }]);
  const post = page.entities[0] as { contentType: string; title?: string };
  assert.equal(post.contentType, 'article');
  assert.equal(post.title, 'Long read');
});

test('twitter-cli get_saved and get_feed normalize tweet lists', () => {
  const worker = new SocialTwitterWorker();
  const saved = worker.normalize(request('get_saved'), cliPlan(), [TWITTER_CLI_TWEET]);
  assert.equal(saved.entities.length, 1);
  const feed = worker.normalize(request('get_feed'), cliPlan(), [TWITTER_CLI_TWEET]);
  assert.equal(feed.entities.length, 1);
  assert.equal(feed.entities[0]!.kind, 'social_post');
});

// ── Normalization: OpenCLI fixtures ──

test('opencli get_user_posts normalizes tweet rows with metrics, url, and media', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_user_posts', { user: 'authorb' }), openCliPlan(), [OPENCLI_TWEET]);
  assert.equal(page.entities.length, 1);
  const post = page.entities[0] as {
    id: string;
    platformId?: string;
    url?: string;
    metrics?: { likes?: number; reposts?: number };
    media?: Array<{ url?: string; thumbnailUrl?: string }>;
    author?: { handle?: string };
  };
  assert.equal(post.id, 'twitter:social_post:2002');
  assert.equal(post.platformId, '2002');
  assert.equal(post.url, 'https://x.com/authorb/status/2002');
  assert.equal(post.metrics?.likes, 12);
  assert.equal(post.metrics?.reposts, 4);
  assert.equal(post.media?.[0]?.thumbnailUrl, 'https://pbs.twimg.com/thumb.jpg');
  assert.equal(post.author?.handle, 'authorb');
});

test('opencli get_thread splits root and replies; get_comments strips the root', () => {
  const worker = new SocialTwitterWorker();
  const thread = worker.normalize(request('get_thread', { postId: '2002' }), openCliPlan(), [
    OPENCLI_TWEET,
    { ...OPENCLI_TWEET, id: '2003', text: 'a reply' },
  ]);
  assert.equal(thread.entities.length, 2);
  assert.equal(thread.entities[0]!.kind, 'social_post');
  assert.equal(thread.entities[1]!.kind, 'social_comment');

  const comments = worker.normalize(request('get_comments', { postId: '2002' }), openCliPlan(), [
    OPENCLI_TWEET,
    { ...OPENCLI_TWEET, id: '2003', text: 'a reply' },
  ]);
  assert.equal(comments.entities.length, 1);
  assert.equal(comments.entities[0]!.kind, 'social_comment');
});

test('opencli get_profile maps the profile row with follower metrics', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_profile', { user: 'authora' }), openCliPlan(), OPENCLI_PROFILE);
  assert.equal(page.entities.length, 1);
  const profile = page.entities[0] as { kind: string; id: string; handle?: string; metrics?: { followers?: number } };
  assert.equal(profile.kind, 'social_account');
  assert.equal(profile.id, 'twitter:social_account:authora');
  assert.equal(profile.handle, 'authora');
  assert.equal(profile.metrics?.followers, 555);
});

test('opencli follower rows without screen_name are dropped as partial', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_followers', { user: 'authora' }), openCliPlan(), [
    { screen_name: 'authorb', name: 'Author B' },
    { name: 'no handle' },
  ]);
  assert.equal(page.entities.length, 1);
  assert.equal(page.partial, true);
  assert.ok(page.warnings.length >= 1);
});

test('opencli get_trending returns topic entities and flags rank-derived ids', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_trending'), openCliPlan(), OPENCLI_TREND);
  assert.equal(page.entities.length, 2);
  const topic = page.entities[0] as { name?: string; description?: string };
  assert.equal(topic.name, 'TypeScript');
  assert.equal(topic.description, 'Technology · Trending');
  assert.ok(page.warnings.some((warning) => warning.includes('rank-derived')));
});

test('opencli notifications map to notification entities with actor handles', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_notifications'), openCliPlan(), OPENCLI_NOTIFICATION);
  assert.equal(page.entities.length, 2);
  const first = page.entities[0] as { type?: string; actor?: { handle?: string }; url?: string };
  assert.equal(first.type, 'Mention');
  assert.equal(first.actor?.handle, 'authorb');
  assert.equal(first.url, 'https://x.com/i/status/2002');
});

test('opencli empty listing is a valid success page with zero entities', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('search', { query: 'pi' }), openCliPlan(), []);
  assert.equal(page.entities.length, 0);
  assert.equal(page.pagination.returned, 0);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.partial, false);
});

test('opencli get_post throws not_found on empty payload', () => {
  const worker = new SocialTwitterWorker();
  socialErrorOf('not_found', () => worker.normalize(request('get_post', { postId: '2002' }), openCliPlan(), []));
});

test('normalize fails closed on non-list payloads', () => {
  const worker = new SocialTwitterWorker();
  socialErrorOf('malformed_upstream', () => worker.normalize(request('search', { query: 'pi' }), openCliPlan(), { nope: true }));
  socialErrorOf('malformed_upstream', () => worker.normalize(request('search', { query: 'pi' }), cliPlan(), 'nope'));
});

test('normalize rejects unknown backends', () => {
  const worker = new SocialTwitterWorker();
  socialErrorOf('backend_unavailable', () =>
    worker.normalize(
      request('search', { query: 'pi' }),
      { backend: 'arctic-shift', authTier: 'anonymous', pagination: 'none', execute: async () => undefined },
      [],
    ));
});

test('normalize rejects non-list twitter-cli list payloads', () => {
  const worker = new SocialTwitterWorker();
  socialErrorOf('malformed_upstream', () => worker.normalize(request('search', { query: 'pi' }), cliPlan(), 'nope'));
});

test('null root rows never crash: detail maps to not_found/malformed, threads warn and keep replies', () => {
  const worker = new SocialTwitterWorker();
  socialErrorOf('not_found', () => worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), [null]));
  socialErrorOf('not_found', () => worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), null));
  socialErrorOf('not_found', () => worker.normalize(request('get_profile', { user: 'authora' }), cliPlan(), null));
  socialErrorOf('malformed_upstream', () => worker.normalize(request('get_post', { postId: '2002' }), openCliPlan(), [null]));
  const thread = worker.normalize(request('get_thread', { postId: '1001' }), cliPlan(), [null, TWITTER_CLI_REPLY]);
  assert.equal(thread.entities.length, 1);
  assert.equal(thread.entities[0]!.kind, 'social_comment');
  assert.ok(thread.warnings.some((warning) => warning.includes('malformed root')));
  const openThread = worker.normalize(request('get_thread', { postId: '2002' }), openCliPlan(), [null, { ...OPENCLI_TWEET, id: '2003' }]);
  assert.equal(openThread.entities.length, 1);
  assert.equal(openThread.entities[0]!.kind, 'social_comment');
});

test('null author never crashes: url falls back to /i/ handle', () => {
  const worker = new SocialTwitterWorker();
  const page = worker.normalize(request('get_post', { postId: '1001' }), cliPlan(), [{ ...TWITTER_CLI_TWEET, author: null }]);
  assert.equal(page.entities.length, 1);
  assert.equal((page.entities[0] as { url: string }).url, 'https://x.com/i/status/1001');
});

// ── Contract invariants ──

test('every normalized page passes validateSocialPage and never fabricates cursors', () => {
  const worker = new SocialTwitterWorker();
  const cases: Array<[SocialAction, Record<string, unknown>, string, unknown]> = [
    ['search', { query: 'pi' }, 'twitter-cli', [TWITTER_CLI_TWEET]],
    ['get_thread', { postId: '2002' }, 'opencli-twitter', [OPENCLI_TWEET, { ...OPENCLI_TWEET, id: '2003' }]],
    ['get_trending', {}, 'opencli-twitter', OPENCLI_TREND],
    ['get_notifications', {}, 'opencli-twitter', OPENCLI_NOTIFICATION],
    ['get_profile', { user: 'authora' }, 'opencli-twitter', OPENCLI_PROFILE],
    ['get_followers', { user: 'authora' }, 'twitter-cli', [TWITTER_CLI_USER]],
    ['get_saved', {}, 'twitter-cli', [TWITTER_CLI_TWEET]],
  ];
  for (const [action, overrides, backend, payload] of cases) {
    const page = worker.normalize(request(action, overrides), { backend, authTier: 'cookie', pagination: 'none', execute: async () => undefined }, payload);
    assert.equal(page.pagination.returned, page.entities.length, `${action}: returned mismatch`);
    assert.equal(page.pagination.hasMore, false, `${action}: twitter never fabricates cursors`);
    assert.equal('nextCursor' in page.pagination, false, `${action}: no cursor expected`);
    assert.ok(page.warnings.every((warning) => typeof warning === 'string'));
  }
});
