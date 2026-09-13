import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SocialError,
  canonicalActionsFor,
  validateSocialPage,
  validateSocialRequest,
  type SocialBackendPlan,
  type SocialRequest,
} from '../../src/social/social-contract.js';
import {
  OPENCLI_FACEBOOK_CAPABILITY,
  OPENCLI_INSTAGRAM_CAPABILITY,
  OPENCLI_LINKEDIN_CAPABILITY,
  OPENCLI_SOCIAL_CAPABILITIES,
  OPENCLI_VERSION,
  buildOpenCliArgs,
  createOpenCliSocialWorker,
  openCliChildEnv,
  type OpenCliExec,
  type OpenCliRunResult,
} from '../../src/social/social-opencli.js';

function ok(result: OpenCliRunResult = { code: 0, stdout: '[]', stderr: '' }): OpenCliExec {
  return async () => result;
}

function okJson(payload: unknown): OpenCliExec {
  return async () => ({ code: 0, stdout: JSON.stringify(payload), stderr: '' });
}

function makeRequest(overrides: Record<string, unknown> = {}): SocialRequest {
  const request = {
    platform: 'facebook',
    action: 'search',
    query: 'software engineer',
    limit: 20,
    ...overrides,
  } as unknown as SocialRequest;
  for (const key of Object.keys(request)) {
    if ((request as unknown as Record<string, unknown>)[key] === undefined) {
      delete (request as unknown as Record<string, unknown>)[key];
    }
  }
  return request;
}

async function plansFor(request: SocialRequest, exec: OpenCliExec): Promise<readonly SocialBackendPlan[]> {
  return createOpenCliSocialWorker(exec).plans(request, {});
}

// ── Capability invariants ──

test('worker covers exactly the three assigned platforms', () => {
  assert.deepEqual(createOpenCliSocialWorker(ok()).platforms, ['facebook', 'instagram', 'linkedin']);
});

const CAPABILITY_BY_PLATFORM = {
  facebook: OPENCLI_FACEBOOK_CAPABILITY,
  instagram: OPENCLI_INSTAGRAM_CAPABILITY,
  linkedin: OPENCLI_LINKEDIN_CAPABILITY,
} as const;

for (const platform of ['facebook', 'instagram', 'linkedin'] as const) {
  test(`${platform}: advertised actions and capability operations match exactly`, () => {
    const capability = CAPABILITY_BY_PLATFORM[platform];
    const advertised = canonicalActionsFor(platform) as readonly string[];
    const operationActions: readonly string[] = capability.operations.map((op) => op.action);
    for (const action of advertised) {
      assert.ok(operationActions.includes(action), `${platform} missing operation for ${action}`);
    }
    for (const action of operationActions) {
      assert.ok(advertised.includes(action), `${platform} operation ${action} is not advertised`);
    }
    assert.equal(capability.name, 'opencli');
    assert.equal(capability.type, 'external');
    assert.equal(capability.verifiedVersion, OPENCLI_VERSION);
  });
}

test('instagram capability has no post-detail, feed, or notification action', () => {
  const actions = OPENCLI_INSTAGRAM_CAPABILITY.operations.map((op) => op.action);
  for (const action of ['get_post', 'get_thread', 'get_comments', 'get_feed', 'get_notifications', 'get_community']) {
    assert.ok(!actions.includes(action as never), `instagram must not advertise ${action}`);
  }
});

test('linkedin search operation is people-search capped at 10 (CUL)', () => {
  const search = OPENCLI_LINKEDIN_CAPABILITY.operations.find((op) => op.action === 'search');
  assert.ok(search);
  assert.deepEqual(search.upstreamAction, ['people-search']);
  assert.equal(search.maxLimit, 10);
});

test('all opencli operations are cookie-authenticated and non-pageable', () => {
  for (const capability of OPENCLI_SOCIAL_CAPABILITIES) {
    for (const operation of capability.operations) {
      assert.deepEqual(operation.auth, ['cookie']);
      assert.equal(operation.pagination, 'none');
    }
  }
});

// ── Argv mapping ──

test('argv always runs the opencli binary and requests json output', async () => {
  const calls: string[][] = [];
  const exec: OpenCliExec = async (_command, args) => {
    calls.push(args);
    return { code: 0, stdout: '[]', stderr: '' };
  };
  const worker = createOpenCliSocialWorker(exec);
  const cases = [
    makeRequest(),
    makeRequest({ action: 'get_profile', query: undefined, user: 'zuck' }),
    makeRequest({ action: 'get_feed', query: undefined }),
    makeRequest({ action: 'get_notifications', query: undefined }),
    makeRequest({ action: 'get_community', query: undefined, community: 'some-group' }),
    makeRequest({ platform: 'instagram', action: 'search', query: 'coffee' }),
    makeRequest({ platform: 'instagram', action: 'get_profile', query: undefined, user: 'instagram' }),
    makeRequest({ platform: 'instagram', action: 'get_user_posts', query: undefined, user: 'instagram' }),
    makeRequest({ platform: 'instagram', action: 'get_followers', query: undefined, user: 'instagram' }),
    makeRequest({ platform: 'instagram', action: 'get_following', query: undefined, user: 'instagram' }),
    makeRequest({ platform: 'instagram', action: 'get_trending', query: undefined }),
    makeRequest({ platform: 'instagram', action: 'get_saved', query: undefined }),
    makeRequest({ platform: 'linkedin', action: 'search', query: 'sre berlin', limit: 5 }),
    makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: 'satyanadella' }),
    makeRequest({ platform: 'linkedin', action: 'get_user_posts', query: undefined, user: 'satyanadella' }),
    makeRequest({ platform: 'linkedin', action: 'get_feed', query: undefined }),
  ];
  for (const request of cases) {
    const [plan] = await worker.plans(request, {});
    assert.ok(plan, `${request.platform} ${request.action} should produce a plan`);
    await plan.execute();
  }
  assert.equal(calls.length, cases.length);
  for (const args of calls) {
    assert.equal(args[args.length - 2], '-f');
    assert.equal(args[args.length - 1], 'json');
  }
});

test('argv snapshot per action matches the verified command table', () => {
  const CASES: Array<[Record<string, unknown>, string[]]> = [
    [{}, ['opencli', 'facebook', 'search', 'software engineer', '--limit', '20', '-f', 'json']],
    [{ action: 'get_profile', query: undefined, user: 'zuck' }, ['opencli', 'facebook', 'profile', 'zuck', '-f', 'json']],
    [{ action: 'get_feed', query: undefined }, ['opencli', 'facebook', 'feed', '--limit', '20', '-f', 'json']],
    [{ action: 'get_notifications', query: undefined }, ['opencli', 'facebook', 'notifications', '--limit', '20', '-f', 'json']],
    [{ action: 'get_community', query: undefined, community: 'g' }, ['opencli', 'facebook', 'groups', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'search', query: 'coffee' }, ['opencli', 'instagram', 'search', 'coffee', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_profile', query: undefined, user: 'ig' }, ['opencli', 'instagram', 'profile', 'ig', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_user_posts', query: undefined, user: 'ig' }, ['opencli', 'instagram', 'user', 'ig', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_followers', query: undefined, user: 'ig' }, ['opencli', 'instagram', 'followers', 'ig', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_following', query: undefined, user: 'ig' }, ['opencli', 'instagram', 'following', 'ig', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_trending', query: undefined }, ['opencli', 'instagram', 'explore', '--limit', '20', '-f', 'json']],
    [{ platform: 'instagram', action: 'get_saved', query: undefined }, ['opencli', 'instagram', 'saved', '--limit', '20', '-f', 'json']],
    [{ platform: 'linkedin', action: 'search', query: 'sre', limit: 5 }, ['opencli', 'linkedin', 'people-search', 'sre', '--limit', '5', '-f', 'json']],
    [{ platform: 'linkedin', action: 'get_profile', query: undefined, user: 'janedoe' }, ['opencli', 'linkedin', 'profile-read', '--profile-url', 'https://www.linkedin.com/in/janedoe/', '-f', 'json']],
    [{ platform: 'linkedin', action: 'get_user_posts', query: undefined, user: 'janedoe' }, ['opencli', 'linkedin', 'posts', '--profile-url', 'https://www.linkedin.com/in/janedoe/', '--limit', '20', '-f', 'json']],
    [{ platform: 'linkedin', action: 'get_feed', query: undefined }, ['opencli', 'linkedin', 'timeline', '--limit', '20', '-f', 'json']],
  ];
  for (const [overrides, expected] of CASES) {
    assert.deepEqual(buildOpenCliArgs(makeRequest(overrides)), expected, JSON.stringify(overrides));
  }
});

test('linkedin search argv never contains the job-search command', () => {
  const argv = buildOpenCliArgs(makeRequest({ platform: 'linkedin', action: 'search', query: 'sre', limit: 5 })) ?? [];
  const withoutPeopleSearch = argv.filter((token) => token !== 'people-search');
  assert.ok(!withoutPeopleSearch.includes('search'), 'job search command must never appear');
});

test('no generated argv contains mutation, download, or file-output tokens', () => {
  const forbidden = ['download', '--output', '--out=', ' -o ', 'write', 'mkdir', 'cookie', 'xsec_token'];
  const cases: SocialRequest[] = [
    makeRequest(),
    makeRequest({ action: 'get_profile', query: undefined, user: 'zuck' }),
    makeRequest({ action: 'get_feed', query: undefined }),
    makeRequest({ action: 'get_notifications', query: undefined }),
    makeRequest({ action: 'get_community', query: undefined, community: 'g' }),
    makeRequest({ platform: 'instagram', action: 'search', query: 'x' }),
    makeRequest({ platform: 'instagram', action: 'get_profile', query: undefined, user: 'u' }),
    makeRequest({ platform: 'instagram', action: 'get_user_posts', query: undefined, user: 'u' }),
    makeRequest({ platform: 'instagram', action: 'get_followers', query: undefined, user: 'u' }),
    makeRequest({ platform: 'instagram', action: 'get_following', query: undefined, user: 'u' }),
    makeRequest({ platform: 'instagram', action: 'get_trending', query: undefined }),
    makeRequest({ platform: 'instagram', action: 'get_saved', query: undefined }),
    makeRequest({ platform: 'linkedin', action: 'search', query: 'q' }),
    makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: 'abc' }),
    makeRequest({ platform: 'linkedin', action: 'get_user_posts', query: undefined, user: 'abc' }),
    makeRequest({ platform: 'linkedin', action: 'get_feed', query: undefined }),
  ];
  for (const request of cases) {
    const argv = buildOpenCliArgs(request) ?? [];
    const joined = argv.join(' ');
    for (const token of forbidden) {
      assert.ok(!joined.includes(token), `${request.platform}/${request.action} argv must not contain "${token}": ${joined}`);
    }
  }
});

test('linkedin profile handles are validated before URL construction', () => {
  assert.throws(
    () => buildOpenCliArgs(makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: '../etc/passwd' })),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
  assert.throws(
    () => buildOpenCliArgs(makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: 'a b' })),
    (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
  );
});

// ── Instagram read/post binding ──

test('instagram post-detail actions throw unsupported_action with no child process', async () => {
  let spawned = 0;
  const exec: OpenCliExec = async () => {
    spawned += 1;
    return { code: 0, stdout: '[]', stderr: '' };
  };
  const worker = createOpenCliSocialWorker(exec);
  for (const action of ['get_post', 'get_thread', 'get_comments'] as const) {
    await assert.rejects(
      () => worker.plans(makeRequest({ platform: 'instagram', action }), {}),
      (error: unknown) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, 'unsupported_action');
        assert.equal(
          error.message,
          'instagram read/post is unavailable: no verified read-only post-detail adapter exists; OpenCLI download is intentionally disabled',
        );
        return true;
      },
    );
  }
  assert.equal(spawned, 0, 'no child process may be launched');
});

test('instagram read/post legacy spellings are rejected before dispatch', () => {
  for (const action of ['read', 'post']) {
    assert.throws(
      () => validateSocialRequest({ platform: 'instagram', action }),
      (error: unknown) => error instanceof SocialError && error.code === 'unsupported_action',
    );
  }
  // Defense in depth: a forged canonical post-detail request produces no argv.
  assert.equal(buildOpenCliArgs(makeRequest({ platform: 'instagram', action: 'get_post' })), null);
});

// ── Execution error mapping ──

async function executeExpectingError(request: SocialRequest, result: OpenCliRunResult): Promise<SocialError> {
  const [plan] = await plansFor(request, ok(result));
  assert.ok(plan);
  await assert.rejects(() => plan.execute());
  try {
    await plan.execute();
  } catch (error) {
    assert.ok(error instanceof SocialError);
    return error;
  }
  throw new Error('expected execute() to reject');
}

test('missing executable maps to backend_unavailable', async () => {
  const error = await executeExpectingError(
    makeRequest(),
    { code: 127, stdout: '', stderr: 'command not found' },
  );
  assert.equal(error.code, 'backend_unavailable');
});

test('timed-out command maps to backend_unavailable', async () => {
  const error = await executeExpectingError(makeRequest(), { code: 124, stdout: '', stderr: '', timedOut: true });
  assert.equal(error.code, 'backend_unavailable');
});

test('nonzero exit maps to upstream_error', async () => {
  const error = await executeExpectingError(makeRequest(), { code: 1, stdout: '', stderr: 'not logged in' });
  assert.equal(error.code, 'upstream_error');
});

test('invalid JSON stdout maps to malformed_upstream', async () => {
  const error = await executeExpectingError(makeRequest(), { code: 0, stdout: 'not json', stderr: '' });
  assert.equal(error.code, 'malformed_upstream');
});

test('pre-aborted signal never spawns a child', async () => {
  let spawned = 0;
  const exec: OpenCliExec = async () => {
    spawned += 1;
    return { code: 0, stdout: '[]', stderr: '' };
  };
  const [plan] = await plansFor(makeRequest(), exec);
  assert.ok(plan);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => plan.execute(controller.signal));
  assert.equal(spawned, 0);
});

// ── Sanitized environment ──

test('child env allowlist drops secrets and keeps only operator-owned vars', () => {
  const source: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    HOME: '/home/u',
    OPENCLI_HOST: 'localhost',
    OPENCLI_PORT: '9999',
    OPENCLI_TOKEN: 'operator-token',
    TWITTER_AUTH_TOKEN: 'secret-a',
    REDDIT_CLIENT_SECRET: 'secret-b',
    MY_APP_COOKIE: 'secret-c',
    AWS_SECRET_ACCESS_KEY: 'secret-d',
    GITHUB_TOKEN: 'secret-e',
    NODE_OPTIONS: '--inspect',
  };
  const env = openCliChildEnv(source);
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN', 'PATH']);
  for (const secret of ['secret-a', 'secret-b', 'secret-c', 'secret-d', 'secret-e']) {
    assert.ok(!JSON.stringify(env).includes(secret), `secret ${secret} must not reach the child env`);
  }
});

test('empty env values are dropped', () => {
  const env = openCliChildEnv({ PATH: '/usr/bin', OPENCLI_TOKEN: '' });
  assert.deepEqual(Object.keys(env), ['PATH']);
});

// ── Normalization fixtures (columns pinned to OpenCLI 1.8.6) ──

async function normalizeWith(request: SocialRequest, payload: unknown) {
  let argv: string[] = [];
  const worker = createOpenCliSocialWorker(async (_command, args) => {
    argv = args;
    return { code: 0, stdout: JSON.stringify(payload), stderr: '' };
  });
  const [plan] = await worker.plans(request, {});
  assert.ok(plan);
  const page = worker.normalize(request, plan, await plan.execute());
  return { worker, plan, page, argv };
}

test('facebook search rows normalize to references; empty row marks partial', async () => {
  const { page } = await normalizeWith(makeRequest(), [
    { index: 1, title: 'ACME careers', text: 'We are hiring', url: 'https://www.facebook.com/acme' },
    { index: 2, title: '', text: '', url: '' },
  ]);
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]!.kind, 'social_reference');
  assert.equal(page.partial, true, 'dropped row must mark the page partial');
  assert.ok(page.warnings.length >= 1);
  assert.equal(validateSocialPage(page).ok, true);
});

test('facebook feed rows normalize to posts with metrics', async () => {
  const { page } = await normalizeWith(makeRequest({ action: 'get_feed', query: undefined }), [
    { index: 1, author: 'someone', content: 'Hello world', likes: '1,204', comments: 12, shares: 3 },
  ]);
  assert.equal(page.entities.length, 1);
  const post = page.entities[0]!;
  assert.equal(post.kind, 'social_post');
  if (post.kind !== 'social_post') return;
  assert.equal(post.text, 'Hello world');
  assert.equal(post.author?.handle, 'someone');
  assert.equal(post.metrics?.likes, 1204);
  assert.equal(post.metrics?.comments, 12);
  assert.equal(validateSocialPage(page).ok, true);
});

test('facebook profile object normalizes to exactly one profile entity', async () => {
  const request = makeRequest({ action: 'get_profile', query: undefined, user: 'zuck' });
  const { page } = await normalizeWith(request, {
    name: 'Mark', username: 'zuck', friends: 100, followers: '5M', url: 'https://www.facebook.com/zuck',
  });
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]!.kind, 'social_account');
  assert.equal(page.pagination.returned, 1);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.supported, false);
  assert.equal(validateSocialPage(page).ok, true);
});

test('facebook notification rows carry platformId, type, and parsed time', async () => {
  const request = makeRequest({ action: 'get_notifications', query: undefined });
  const { page } = await normalizeWith(request, [
    {
      index: 1, unread: true, text: 'X mentioned you', time: '2024-05-01T10:00:00.000Z',
      url: 'https://www.facebook.com/notifications/x', notif_id: 'n1', notif_type: 'mention',
    },
  ]);
  const notification = page.entities[0]!;
  assert.equal(notification.kind, 'social_notification');
  if (notification.kind !== 'social_notification') return;
  assert.equal(notification.platformId, 'n1');
  assert.equal(notification.type, 'mention');
  assert.equal(notification.publishedAt, '2024-05-01T10:00:00.000Z');
  assert.equal(validateSocialPage(page).ok, true);
});

test('instagram follower rows normalize to profiles', async () => {
  const request = makeRequest({ platform: 'instagram', action: 'get_followers', query: undefined, user: 'instagram' });
  const { page } = await normalizeWith(request, [
    { rank: 1, username: 'ada', name: 'Ada', verified: 'true', private: 'false' },
    { rank: 2, username: 'bob', name: 'Bob', verified: 'false', private: 'true' },
  ]);
  assert.equal(page.entities.length, 2);
  assert.ok(page.entities.every((entity) => entity.kind === 'social_account'));
  const first = page.entities[0]!;
  if (first.kind !== 'social_account') return;
  assert.equal(first.handle, 'ada');
  assert.equal(validateSocialPage(page).ok, true);
});

test('instagram user posts rows normalize to posts with caption and media type', async () => {
  const request = makeRequest({ platform: 'instagram', action: 'get_user_posts', query: undefined, user: 'instagram' });
  const { page } = await normalizeWith(request, [
    { index: 1, caption: 'sunset', likes: 500, comments: 40, type: 'image', date: '2024-06-01' },
  ]);
  const post = page.entities[0]!;
  assert.equal(post.kind, 'social_post');
  if (post.kind !== 'social_post') return;
  assert.equal(post.text, 'sunset');
  assert.deepEqual(post.media, [{ type: 'image' }]);
  assert.equal(post.metrics?.likes, 500);
  assert.equal(validateSocialPage(page).ok, true);
});

test('instagram explore rows keep the author handle', async () => {
  const request = makeRequest({ platform: 'instagram', action: 'get_trending', query: undefined });
  const { page } = await normalizeWith(request, [
    { rank: 1, user: 'creator', caption: 'big one', likes: 9000, comments: 100, type: 'video' },
  ]);
  const post = page.entities[0]!;
  assert.equal(post.kind, 'social_post');
  if (post.kind !== 'social_post') return;
  assert.equal(post.author?.handle, 'creator');
  assert.equal(validateSocialPage(page).ok, true);
});

test('linkedin people-search rows normalize to profiles with headline as bio', async () => {
  const request = makeRequest({ platform: 'linkedin', action: 'search', query: 'sre berlin', limit: 5 });
  const { page } = await normalizeWith(request, [
    { rank: 1, name: 'Jane Doe', headline: 'SRE at ACME', location: 'Berlin', profile_url: 'https://www.linkedin.com/in/janedoe/' },
  ]);
  const profile = page.entities[0]!;
  assert.equal(profile.kind, 'social_account');
  if (profile.kind !== 'social_account') return;
  assert.equal(profile.handle, 'janedoe');
  assert.equal(profile.bio, 'SRE at ACME');
  assert.equal(validateSocialPage(page).ok, true);
});

test('linkedin people-search clamps limit above the CUL cap and warns', async () => {
  const request = makeRequest({ platform: 'linkedin', action: 'search', query: 'sre', limit: 50 });
  const { page, argv } = await normalizeWith(request, []);
  assert.deepEqual(page.entities, []);
  assert.ok(page.warnings.some((warning) => warning.includes('Commercial Use Limit')));
  assert.ok(page.warnings.some((warning) => warning.includes('clamped to 10')));
  assert.deepEqual(argv, ['linkedin', 'people-search', 'sre', '--limit', '10', '-f', 'json']);
});

test('linkedin posts rows normalize with reactions, reposts, impressions, and media', async () => {
  const request = makeRequest({ platform: 'linkedin', action: 'get_user_posts', query: undefined, user: 'janedoe' });
  const { page } = await normalizeWith(request, [
    {
      rank: 1, author: 'Jane', posted_at: '2024-05-02', body: 'ship it', reactions: 42, comments: 5,
      reposts: 2, impressions: 1000, media: 1, media_urls: ['https://www.linkedin.com/media/1'],
      url: 'https://www.linkedin.com/posts/janedoe-activity-1',
    },
  ]);
  const post = page.entities[0]!;
  assert.equal(post.kind, 'social_post');
  if (post.kind !== 'social_post') return;
  assert.equal(post.metrics?.likes, 42);
  assert.equal(post.metrics?.reposts, 2);
  assert.equal(post.metrics?.views, 1000);
  assert.deepEqual(post.media, [{ url: 'https://www.linkedin.com/media/1' }]);
  assert.equal(post.publishedAt, '2024-05-02T00:00:00.000Z');
  assert.equal(validateSocialPage(page).ok, true);
});

test('linkedin profile-read single object becomes exactly one profile', async () => {
  const request = makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: 'janedoe' });
  const { page } = await normalizeWith(request, {
    profile_url: 'https://www.linkedin.com/in/janedoe/', name: 'Jane Doe', headline: 'SRE', about: 'Systems person',
  });
  assert.equal(page.entities.length, 1);
  assert.equal(page.pagination.returned, 1);
  assert.equal(validateSocialPage(page).ok, true);
});

test('empty rows are a valid empty page, not an error', async () => {
  const request = makeRequest({ action: 'get_feed', query: undefined });
  const { page } = await normalizeWith(request, []);
  assert.deepEqual(page.entities, []);
  assert.equal(page.pagination.returned, 0);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(validateSocialPage(page).ok, true);
});

test('invalid date strings are omitted with a partial marker', async () => {
  const request = makeRequest({ action: 'get_feed', query: undefined });
  const { page } = await normalizeWith(request, [
    { index: 1, author: 'a', content: 'text', likes: 1, comments: 0, shares: 0, published_at: 'not a date' },
  ]);
  const post = page.entities[0]!;
  if (post.kind !== 'social_post') return assert.fail('expected post');
  assert.equal(post.publishedAt, undefined);
  assert.equal(validateSocialPage(page).ok, true);
});

test('scalar payload fails closed as malformed_upstream', async () => {
  const request = makeRequest({ action: 'get_feed', query: undefined });
  const worker = createOpenCliSocialWorker(okJson('garbage'));
  const [plan] = await worker.plans(request, {});
  assert.ok(plan);
  const payload = await plan.execute();
  assert.throws(
    () => worker.normalize(request, plan, payload),
    (error: unknown) => error instanceof SocialError && error.code === 'malformed_upstream',
  );
});

test('array containing non-object rows fails closed', async () => {
  const request = makeRequest({ action: 'get_feed', query: undefined });
  const worker = createOpenCliSocialWorker(okJson(['nope', 42]));
  const [plan] = await worker.plans(request, {});
  assert.ok(plan);
  const payload = await plan.execute();
  assert.throws(
    () => worker.normalize(request, plan, payload),
    (error: unknown) => error instanceof SocialError && error.code === 'malformed_upstream',
  );
});

test('get_profile with zero rows is not_found', async () => {
  const request = makeRequest({ action: 'get_profile', query: undefined, user: 'ghost' });
  const worker = createOpenCliSocialWorker(okJson([]));
  const [plan] = await worker.plans(request, {});
  assert.ok(plan);
  const payload = await plan.execute();
  assert.throws(
    () => worker.normalize(request, plan, payload),
    (error: unknown) => error instanceof SocialError && error.code === 'not_found',
  );
});

test('facebook groups mapping warns that results are account-owned', async () => {
  const request = makeRequest({ action: 'get_community', query: undefined, community: 'target-group' });
  const { page } = await normalizeWith(request, [
    { index: 1, name: 'My Group', last_post: 'yesterday', url: 'https://www.facebook.com/groups/123' },
  ]);
  assert.equal(page.entities[0]!.kind, 'social_community');
  assert.ok(page.warnings.some((warning) => warning.includes('account-owned')));
  assert.equal(validateSocialPage(page).ok, true);
});

// ── Worker scoping ──

test('worker returns no plans for platforms it does not own', async () => {
  assert.deepEqual(await plansFor(makeRequest({ platform: 'twitter' }), ok()), []);
});

test('unsupported canonical action for a supported platform throws unsupported_action', async () => {
  await assert.rejects(
    () => plansFor(makeRequest({ action: 'get_post', query: undefined, postId: '1' }), ok()),
    (error: unknown) => error instanceof SocialError && error.code === 'unsupported_action',
  );
});

test('feedVariant input is acknowledged as ignored via warning', async () => {
  const request = makeRequest({ action: 'get_feed', query: undefined, feedVariant: 'top' });
  const [plan] = await plansFor(request, ok());
  assert.ok(plan);
  const page = createOpenCliSocialWorker(okJson([])).normalize(request, plan, await plan.execute());
  assert.ok(page.warnings.some((warning) => warning.includes('feedVariant')));
});

// ── Option-injection guard ──

test('option-shaped selectors never reach the executor (facebook/instagram/linkedin)', async () => {
  const cases: SocialRequest[] = [
    makeRequest({ platform: 'facebook', action: 'search', query: '--limit' }),
    makeRequest({ platform: 'facebook', action: 'get_profile', query: undefined, user: '--limit' }),
    makeRequest({ platform: 'instagram', action: 'search', query: '-f' }),
    makeRequest({ platform: 'instagram', action: 'get_profile', query: undefined, user: '--json' }),
    makeRequest({ platform: 'instagram', action: 'get_user_posts', query: undefined, user: '--limit' }),
    makeRequest({ platform: 'linkedin', action: 'search', query: '--limit' }),
    makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user: '--profile-url' }),
    makeRequest({ platform: 'linkedin', action: 'get_user_posts', query: undefined, user: '-f' }),
  ];
  for (const request of cases) {
    assert.throws(
      () => buildOpenCliArgs(request),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
      `${request.platform}/${request.action} option-shaped selector must throw`,
    );
    let spawned = 0;
    const exec: OpenCliExec = async () => {
      spawned += 1;
      return { code: 0, stdout: '[]', stderr: '' };
    };
    await assert.rejects(
      () => createOpenCliSocialWorker(exec).plans(request, {}),
      (error: unknown) => error instanceof SocialError && error.code === 'invalid_request',
    );
    assert.equal(spawned, 0, `${request.platform}/${request.action} must not invoke the executor`);
  }
});

test('linkedin handle validation never echoes attacker-controlled text', () => {
  for (const user of ['../etc/passwd', 'a b', '--profile-url']) {
    assert.throws(
      () => buildOpenCliArgs(makeRequest({ platform: 'linkedin', action: 'get_profile', query: undefined, user })),
      (error: unknown) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, 'invalid_request');
        assert.ok(!error.message.includes(user), `error echoed attacker text: ${user}`);
        return true;
      },
    );
  }
});

// ── Diagnostics redaction ──

test('nonzero exit redacts labeled and unlabeled OPENCLI_TOKEN echoes', async () => {
  const token = 'opencli-token-sentinel-93731';
  const previous = process.env.OPENCLI_TOKEN;
  process.env.OPENCLI_TOKEN = token;
  try {
    for (const stderr of [`OPENCLI_TOKEN=${token}`, `backend said: ${token} (boom)`]) {
      const [plan] = await plansFor(makeRequest(), ok({ code: 1, stdout: '', stderr }));
      assert.ok(plan);
      await assert.rejects(() => plan.execute(), (error: unknown) => {
        assert.ok(error instanceof SocialError);
        assert.equal(error.code, 'upstream_error');
        assert.ok(!error.message.includes(token), `SocialError leaked token from: ${stderr}`);
        assert.ok(!error.message.includes(stderr), 'raw stderr must not reach the caller');
        return true;
      });
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCLI_TOKEN;
    else process.env.OPENCLI_TOKEN = previous;
  }
});
