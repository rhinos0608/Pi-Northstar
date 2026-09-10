// Stage 2 worker tests for the V2EX social worker (fixture-driven, no network).
//
// Covers: plan declaration and auth-tier ordering (anonymous → api_key; no
// cookie tier for V2EX), K-only gating (get_notifications, get_community),
// fixed-host URL construction, page cursors only where upstream metadata
// exists, cursor backend pinning, entity normalization rules (no synthesized
// fields), truncation warnings, malformed-payload rejection, and read-only
// guarantees (GET-only, fixed host, PAT header-only, no subprocess surface).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalActionsFor,
  decodeSocialCursor,
  encodeSocialCursor,
  socialCursorFingerprint,
  SocialError,
  validateSocialPage,
  validateSocialRequest,
  type SocialRequest,
} from '../src/social-contract.js';
import {
  createV2exWorker,
  V2EX_BACKEND_LEGACY,
  V2EX_BACKEND_V2,
  V2EX_HOST,
  V2EX_PAT_ENV,
  v2exBackendCapabilities,
  v2exWorker,
  type V2exBackendPlan,
  type V2exOperation,
} from '../src/social-v2ex.js';

const PAT = '11111111-2222-3333-4444-555555555555';

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
}

function workerWithFetch(
  respond: (url: string, headers: Record<string, string>) => unknown | Promise<unknown>,
  options?: { pat?: string },
): { worker: ReturnType<typeof createV2exWorker>; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const worker = createV2exWorker({
    env: options?.pat === undefined ? {} : { [V2EX_PAT_ENV]: options.pat },
    fetchJson: async (url, headers, signal) => {
      calls.push({ url, headers, ...(signal !== undefined ? { signal } : {}) });
      return await respond(url, headers);
    },
  });
  return { worker, calls };
}

/** Test plan carrying the internal operation discriminator, like real worker plans. */
function testPlan(operation: V2exOperation, backend: string = V2EX_BACKEND_LEGACY): V2exBackendPlan {
  return {
    backend,
    authTier: backend === V2EX_BACKEND_V2 ? 'api_key' : 'anonymous',
    pagination: backend === V2EX_BACKEND_V2 ? 'page' : 'none',
    operation,
    execute: async () => undefined,
  };
}

function req(action: string, selectors: Record<string, unknown> = {}): SocialRequest {
  const { request } = validateSocialRequest({ platform: 'v2ex', action, ...selectors });
  return request;
}

const TOPIC_FIXTURE = {
  id: 1102233,
  title: 'Async patterns in Node',
  content: 'Which pattern do you prefer?',
  replies: 7,
  member: { id: 42, username: 'lh', tagline: 'creator', avatar_normal: 'https://cdn.v2ex.com/avatar/42.png' },
  node: { id: 2, name: 'programmer', title: '程序员' },
  created: 1570798152,
};

const REPLY_FIXTURE = {
  id: 556677,
  thanks: 3,
  content: 'I prefer queues.',
  member: { id: 99, username: 'replyguy' },
  created: 1570798300,
};

async function expectSocialError(code: string, run: () => unknown | Promise<unknown>): Promise<void> {
  try {
    await run();
    assert.fail(`expected SocialError ${code}`);
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal((error as SocialError).code, code);
  }
}

// ── Plan declaration and auth ordering ──

test('every advertised v2ex action has at least one plan with a PAT present', async () => {
  const selectors: Record<string, Record<string, unknown>> = {
    get_topic: { topic: '1102233' },
    get_thread: { postId: '1102233' },
    get_comments: { postId: '1102233' },
    get_profile: { user: 'lh' },
    get_trending: {},
    get_community: { community: 'programmer' },
    get_community_posts: { community: 'programmer' },
    get_notifications: {},
  };
  const { worker, calls } = workerWithFetch(() => [], { pat: PAT });
  for (const action of canonicalActionsFor('v2ex')) {
    const plans = await worker.plans(req(action, selectors[action] ?? {}), {});
    assert.ok(plans.length >= 1, `${action} must declare at least one plan`);
    for (const plan of plans) {
      assert.ok([V2EX_BACKEND_LEGACY, V2EX_BACKEND_V2].includes(plan.backend));
      assert.ok(['anonymous', 'api_key'].includes(plan.authTier));
      assert.equal(typeof plan.execute, 'function');
    }
  }
  assert.equal(calls.length, 0, 'plans() must not fetch');
});

test('anonymous legacy plan precedes api_key plan when both exist', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  for (const action of ['get_topic', 'get_comments', 'get_community_posts'] as const) {
    const plans = await worker.plans(req(action, { postId: '1', topic: '1', community: 'programmer' }), {});
    assert.equal(plans.length, 2, `${action} should declare legacy + v2 plans`);
    assert.equal(plans[0]!.backend, V2EX_BACKEND_LEGACY);
    assert.equal(plans[0]!.authTier, 'anonymous');
    assert.equal(plans[1]!.backend, V2EX_BACKEND_V2);
    assert.equal(plans[1]!.authTier, 'api_key');
  }
});

test('no PAT: get_notifications and get_community are authentication_required with zero fetches', async () => {
  for (const action of ['get_notifications', 'get_community'] as const) {
    const { worker, calls } = workerWithFetch(() => []);
    await expectSocialError('authentication_required', () =>
      worker.plans(req(action, action === 'get_community' ? { community: 'programmer' } : {}), {}));
    assert.equal(calls.length, 0, `${action} must not fetch without a PAT`);
  }
});

test('no PAT: legacy-covered actions still declare the anonymous plan', async () => {
  const { worker } = workerWithFetch(() => []);
  const plans = await worker.plans(req('get_trending'), {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.backend, V2EX_BACKEND_LEGACY);
  assert.equal(plans[0]!.authTier, 'anonymous');
});

// ── Fixed-host URLs and credential containment ──

test('legacy trending executes a GET against the fixed host with no Authorization header', async () => {
  const { worker, calls } = workerWithFetch(() => [TOPIC_FIXTURE], { pat: PAT });
  const [plan] = await worker.plans(req('get_trending'), {});
  await plan!.execute();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, `${V2EX_HOST}/api/topics/hot.json`);
  assert.equal(calls[0]!.headers.authorization, undefined);
  assert.equal(new URL(calls[0]!.url).host, 'www.v2ex.com');
});

test('legacy node topics URL carries node_name and page', async () => {
  const { worker, calls } = workerWithFetch(() => [TOPIC_FIXTURE], { pat: PAT });
  const [plan] = await worker.plans(req('get_community_posts', { community: 'programmer' }), {});
  await plan!.execute();
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, `${V2EX_HOST}/api/topics/show.json`);
  assert.equal(url.searchParams.get('node_name'), 'programmer');
  assert.equal(url.searchParams.get('page'), '1');
});

test('api v2 plan sends the PAT only in the Authorization header, never in a URL', async () => {
  const { worker, calls } = workerWithFetch(() => ({ result: [TOPIC_FIXTURE], page: 1, total: 1, per_page: 20 }), { pat: PAT });
  const [legacy, v2] = await worker.plans(req('get_community_posts', { community: 'programmer' }), {});
  assert.ok(legacy !== undefined && v2 !== undefined);
  await v2.execute();
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, `${V2EX_HOST}/api/v2/nodes/programmer/topics`);
  assert.equal(url.searchParams.get('p'), '1');
  assert.ok(!calls[0]!.url.includes(PAT), 'PAT must never appear in any URL');
  assert.equal(calls[0]!.headers.authorization, `Bearer ${PAT}`);
});

test('legacy thread executes exactly two GETs: topic detail and replies', async () => {
  const { worker, calls } = workerWithFetch((url) => {
    if (url.includes('/api/replies/show.json')) return [REPLY_FIXTURE];
    return [TOPIC_FIXTURE];
  }, { pat: PAT });
  const [plan] = await worker.plans(req('get_thread', { postId: '1102233' }), {});
  await plan!.execute();
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${V2EX_HOST}/api/topics/show.json?id=1102233`);
  assert.equal(calls[1]!.url, `${V2EX_HOST}/api/replies/show.json?topic_id=1102233&page=1`);
});

// ── Normalization: entities ──

test('get_trending normalizes topics with only upstream-present fields', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_trending'), testPlan('legacy_hot'), [TOPIC_FIXTURE]);
  assert.ok(validateSocialPage(page).ok, JSON.stringify(validateSocialPage(page)));
  assert.equal(page.entities.length, 1);
  const post = page.entities[0]!;
  assert.equal(post.kind, 'social_post');
  assert.equal(post.id, 'v2ex:social_post:1102233');
  assert.equal(post.platformId, '1102233');
  assert.equal(post.backend, V2EX_BACKEND_LEGACY);
  assert.equal((post as { title?: string }).title, 'Async patterns in Node');
  assert.equal((post as { url?: string }).url, `${V2EX_HOST}/t/1102233`);
  assert.equal(post.publishedAt, new Date(1570798152 * 1000).toISOString());
  const author = (post as { author?: { handle?: string; id?: string; displayName?: string; avatarUrl?: string } }).author;
  assert.equal(author?.handle, 'lh');
  assert.equal(author?.id, '42');
  assert.equal(author?.displayName, 'creator');
  assert.equal(author?.avatarUrl, 'https://cdn.v2ex.com/avatar/42.png');
  assert.deepEqual((post as unknown as { metrics?: Record<string, number> }).metrics, { replies: 7 });
  assert.equal((post as { communityId?: string }).communityId, 'programmer');
});

test('missing upstream fields are omitted, never synthesized', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_trending'), testPlan('legacy_hot'), [{ id: 1, title: 't' }]);
  assert.equal(page.entities.length, 1);
  const post = page.entities[0]!;
  assert.equal((post as { author?: unknown }).author, undefined);
  assert.equal((post as { metrics?: unknown }).metrics, undefined);
  assert.equal(post.publishedAt, undefined);
  assert.equal((post as { text?: unknown }).text, undefined);
  assert.ok(validateSocialPage(page).ok);
});

test('legacy profile normalizes to social_account without synthesized metrics', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_profile', { user: 'lh' }), testPlan('legacy_member'), {
    id: 42,
    username: 'lh',
    tagline: 'creator',
    created: 1264419360,
  });
  assert.ok(validateSocialPage(page).ok, JSON.stringify(validateSocialPage(page)));
  const profile = page.entities[0]!;
  assert.equal(profile.kind, 'social_account');
  assert.equal(profile.id, 'v2ex:social_account:lh');
  assert.equal((profile as { handle?: string }).handle, 'lh');
  assert.equal((profile as { displayName?: string }).displayName, 'creator');
  assert.equal((profile as { metrics?: unknown }).metrics, undefined);
  assert.equal(profile.url, `${V2EX_HOST}/member/lh`);
});

test('legacy replies normalize to social_comment rows with likes mapped from thanks', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_comments', { postId: '1102233' }), testPlan('legacy_replies'), [REPLY_FIXTURE]);
  assert.ok(validateSocialPage(page).ok, JSON.stringify(validateSocialPage(page)));
  const comment = page.entities[0]!;
  assert.equal(comment.kind, 'social_comment');
  assert.equal(comment.id, 'v2ex:social_comment:556677');
  assert.equal((comment as { postId: string }).postId, '1102233');
  assert.equal((comment as { text: string }).text, 'I prefer queues.');
  assert.deepEqual((comment as unknown as { metrics?: Record<string, number> }).metrics, { likes: 3 });
  assert.equal((comment as { author?: { handle?: string } }).author?.handle, 'replyguy');
});

test('api v2 node normalizes to social_community; notifications drop malformed rows', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const plan = testPlan('v2_notifications', V2EX_BACKEND_V2);
  const nodePage = worker.normalize(req('get_community', { community: 'python' }), testPlan('v2_node', V2EX_BACKEND_V2), {
    result: { id: 14, name: 'python', title: 'Python', header: 'Discuss Python here', created: 1272205200 },
  });
  assert.ok(validateSocialPage(nodePage).ok, JSON.stringify(validateSocialPage(nodePage)));
  const community = nodePage.entities[0]!;
  assert.equal(community.kind, 'social_community');
  assert.equal(community.id, 'v2ex:social_community:python');
  assert.equal((community as { name?: string }).name, 'Python');
  assert.equal((community as { description?: string }).description, 'Discuss Python here');

  const notificationPage = worker.normalize(req('get_notifications'), plan, {
    result: [
      { id: 9, member: { id: 99, username: 'replyguy' }, topic_id: 1102233, body: 'mentioned you', created: 1570798300 },
      { topic_title: 'no id row' },
    ],
    page: 1,
    total: 2,
    per_page: 20,
  });
  assert.ok(validateSocialPage(notificationPage).ok, JSON.stringify(validateSocialPage(notificationPage)));
  assert.equal(notificationPage.partial, true, 'malformed rows must set partial');
  assert.equal(notificationPage.entities.length, 1);
  const notification = notificationPage.entities[0]!;
  assert.equal(notification.kind, 'social_notification');
  assert.equal(notification.id, 'v2ex:social_notification:9');
  assert.equal((notification as { relatedEntityId?: string }).relatedEntityId, '1102233');
  assert.equal((notification as { text?: string }).text, 'mentioned you');
  assert.equal((notification as { actor?: { handle?: string } }).actor?.handle, 'replyguy');
});

test('get_thread root topic precedes comments in source order', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_thread', { postId: '1102233' }), testPlan('legacy_thread'), {
    topic: [TOPIC_FIXTURE],
    replies: [
      REPLY_FIXTURE,
      { id: 556678, content: 'second', member: { id: 100, username: 'b' }, created: 1570798400 },
    ],
  });
  assert.ok(validateSocialPage(page).ok, JSON.stringify(validateSocialPage(page)));
  assert.equal(page.entities[0]!.kind, 'social_post');
  assert.equal(page.entities[1]!.kind, 'social_comment');
  assert.equal(page.entities[1]!.id, 'v2ex:social_comment:556677');
  assert.equal(page.entities[2]!.id, 'v2ex:social_comment:556678');
});

// ── Pagination truthfulness ──

test('legacy list endpoints never fabricate hasMore or cursors', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_trending'), testPlan('legacy_hot'), [TOPIC_FIXTURE]);
  assert.equal(page.pagination.supported, false);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, undefined);
});

test('client-side truncation without metadata sets partial plus warning, no cursor', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const request = req('get_trending');
  request.limit = 2;
  const rows = Array.from({ length: 3 }, (_, index) => ({ ...TOPIC_FIXTURE, id: index + 1 }));
  const page = worker.normalize(request, testPlan('legacy_hot'), rows);
  assert.equal(page.entities.length, 2);
  assert.equal(page.partial, true);
  assert.equal(page.pagination.hasMore, false);
  assert.ok(page.warnings.some((warning) => warning.includes('truncated')));
});

test('valid empty listing is a successful page with zero entities', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_trending'), testPlan('legacy_hot'), []);
  assert.equal(page.entities.length, 0);
  assert.equal(page.partial, false);
  assert.ok(validateSocialPage(page).ok);
});

test('api v2 page metadata produces hasMore plus a decodable page cursor without the PAT', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const request = req('get_community_posts', { community: 'programmer' });
  const rows = Array.from({ length: 20 }, (_, index) => ({ ...TOPIC_FIXTURE, id: index + 1 }));
  const page = worker.normalize(request, testPlan('v2_node_topics', V2EX_BACKEND_V2), {
    result: rows,
    page: 1,
    total: 45,
    per_page: 20,
  });
  assert.equal(page.pagination.supported, true);
  assert.equal(page.pagination.hasMore, true);
  assert.ok(typeof page.pagination.nextCursor === 'string' && page.pagination.nextCursor.length > 0);
  assert.equal(page.partial, false);
  const decoded = decodeSocialCursor(page.pagination.nextCursor!, {
    platform: 'v2ex',
    action: 'get_community_posts',
    backend: V2EX_BACKEND_V2,
    fingerprint: socialCursorFingerprint(request),
  });
  assert.equal(decoded.state.page, 2);
  assert.ok(!page.pagination.nextCursor!.includes(PAT));
});

test('metadata-exhausted page has hasMore false and no cursor', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_community_posts', { community: 'programmer' }), testPlan('v2_node_topics', V2EX_BACKEND_V2), {
    result: [TOPIC_FIXTURE],
    page: 3,
    total: 45,
    per_page: 20,
  });
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, undefined);
});

test('api v2 list without metadata: no fabricated cursor plus warning', () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const page = worker.normalize(req('get_notifications'), testPlan('v2_notifications', V2EX_BACKEND_V2), [TOPIC_FIXTURE]);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, undefined);
  assert.ok(page.warnings.some((warning) => warning.includes('pagination metadata')));
});

// ── Cursor backend pinning ──

test('legacy-issued cursor for a page action is cursor_mismatch with zero fetches', async () => {
  const request = req('get_community_posts', { community: 'programmer' });
  const legacyCursor = encodeSocialCursor({
    platform: 'v2ex',
    action: 'get_community_posts',
    backend: V2EX_BACKEND_LEGACY,
    fingerprint: socialCursorFingerprint(request),
    state: { page: 2 },
  });
  const { worker, calls } = workerWithFetch(() => [], { pat: PAT });
  await expectSocialError('cursor_mismatch', () => worker.plans({ ...request, cursor: legacyCursor }, {}));
  assert.equal(calls.length, 0);
});

test('cursor from a different action, or a changed limit fingerprint, is cursor_mismatch', async () => {
  const request = req('get_community_posts', { community: 'programmer' });
  const otherActionCursor = encodeSocialCursor({
    platform: 'v2ex',
    action: 'get_comments',
    backend: V2EX_BACKEND_V2,
    fingerprint: socialCursorFingerprint(request),
    state: { page: 2 },
  });
  const changedLimit: SocialRequest = { ...request, limit: request.limit + 1 };
  const changedLimitCursor = encodeSocialCursor({
    platform: 'v2ex',
    action: 'get_community_posts',
    backend: V2EX_BACKEND_V2,
    fingerprint: socialCursorFingerprint(changedLimit),
    state: { page: 2 },
  });
  const { worker, calls } = workerWithFetch(() => [], { pat: PAT });
  await expectSocialError('cursor_mismatch', () => worker.plans({ ...request, cursor: otherActionCursor }, {}));
  await expectSocialError('cursor_mismatch', () => worker.plans({ ...request, cursor: changedLimitCursor }, {}));
  assert.equal(calls.length, 0);
});

test('valid cursor returns only the pinned page plan and drives the p= URL parameter', async () => {
  const request = req('get_community_posts', { community: 'programmer' });
  const cursor = encodeSocialCursor({
    platform: 'v2ex',
    action: 'get_community_posts',
    backend: V2EX_BACKEND_V2,
    fingerprint: socialCursorFingerprint(request),
    state: { page: 3 },
  });
  const { worker, calls } = workerWithFetch(() => ({ result: [TOPIC_FIXTURE], page: 3, total: 45, per_page: 20 }), { pat: PAT });
  const plans = await worker.plans({ ...request, cursor }, {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.backend, V2EX_BACKEND_V2);
  await plans[0]!.execute();
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, '/api/v2/nodes/programmer/topics');
  assert.equal(url.searchParams.get('p'), '3');
});

test('cursor on a non-pageable action is cursor_mismatch', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const request = req('get_trending');
  const cursor = encodeSocialCursor({
    platform: 'v2ex',
    action: 'get_trending',
    backend: V2EX_BACKEND_LEGACY,
    fingerprint: socialCursorFingerprint(request),
    state: { page: 2 },
  });
  await expectSocialError('cursor_mismatch', () => worker.plans({ ...request, cursor }, {}));
});

test('malformed cursor token is cursor_invalid', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  await expectSocialError('cursor_invalid', () =>
    worker.plans({ ...req('get_community_posts', { community: 'programmer' }), cursor: 'not-a-cursor' }, {}));
});

// ── Failure semantics ──

test('malformed payloads throw malformed_upstream without synthetic entities', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const plan = testPlan('legacy_hot');
  await expectSocialError('malformed_upstream', () => worker.normalize(req('get_trending'), plan, { oops: true }));
  await expectSocialError('malformed_upstream', () => worker.normalize(req('get_trending'), plan, 'not json at all'));
});

test('get_topic: zero matches throws not_found; single and result-wrapped payloads return one entity', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  const plan = testPlan('legacy_topic');
  await expectSocialError('not_found', () => worker.normalize(req('get_topic', { topic: '1102233' }), plan, []));
  await (async () => {
      const page = worker.normalize(req('get_topic', { topic: '1102233' }), plan, [TOPIC_FIXTURE]);
      assert.equal(page.entities.length, 1);
      const wrapped = worker.normalize(req('get_topic', { topic: '1102233' }), plan, { result: [TOPIC_FIXTURE] });
      assert.equal(wrapped.entities.length, 1);
      const bare = worker.normalize(req('get_topic', { topic: '1102233' }), plan, TOPIC_FIXTURE);
      assert.equal(bare.entities.length, 1);
      assert.ok(validateSocialPage(bare).ok);
    })();
});

test('profile null payload is not_found', async () => {
  const { worker } = workerWithFetch(() => [], { pat: PAT });
  await expectSocialError('not_found', () =>
    worker.normalize(req('get_profile', { user: 'ghost' }), testPlan('legacy_member'), null));
});

test('upstream HTTP failures map to SocialError codes without leaking the PAT', async () => {
  const unauthorized = workerWithFetch(() => {
    throw new Error('HTTP 401 for https://www.v2ex.com/api/v2/notifications?p=1');
  }, { pat: PAT });
  const [unauthorizedPlan] = await unauthorized.worker.plans(req('get_notifications'), {});
  await expectSocialError('authentication_required', () => unauthorizedPlan!.execute());

  const limited = workerWithFetch(() => {
    throw new Error('HTTP 429 for https://www.v2ex.com/api/v2/notifications?p=1');
  }, { pat: PAT });
  const [limitedPlan] = await limited.worker.plans(req('get_notifications'), {});
  await expectSocialError('rate_limited', () => limitedPlan!.execute());
});

// ── Read-only guarantees ──

test('all advertised actions execute as GET-only requests to the fixed host with no subprocess surface', async () => {
  const { worker, calls } = workerWithFetch(() => [TOPIC_FIXTURE], { pat: PAT });
  const selectors: Record<string, Record<string, unknown>> = {
    get_topic: { topic: '1102233' },
    get_thread: { postId: '1102233' },
    get_comments: { postId: '1102233' },
    get_profile: { user: 'lh' },
    get_trending: {},
    get_community: { community: 'programmer' },
    get_community_posts: { community: 'programmer' },
    get_notifications: {},
  };
  for (const action of canonicalActionsFor('v2ex')) {
    const plans = await worker.plans(req(action, selectors[action] ?? {}), {});
    for (const plan of plans) {
      await plan.execute();
      assert.equal((plan as { command?: unknown }).command, undefined, 'worker must never declare a subprocess command');
    }
  }
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const url = new URL(call.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.host, 'www.v2ex.com', 'all requests must target the fixed V2EX host');
    assert.ok(!call.url.includes(PAT), 'PAT must never appear in any URL');
  }
});

// ── Capability invariant ──

test('v2exBackendCapabilities cover exactly the advertised canonical actions with correct auth tiers', () => {
  const advertised = new Set(canonicalActionsFor('v2ex'));
  const covered = new Set<string>();
  for (const capability of v2exBackendCapabilities) {
    assert.ok([V2EX_BACKEND_LEGACY, V2EX_BACKEND_V2].includes(capability.name));
    for (const operation of capability.operations) {
      assert.ok(advertised.has(operation.action), `operation ${operation.action} must be advertised`);
      covered.add(operation.action);
    }
  }
  for (const action of advertised) {
    assert.ok(covered.has(action), `advertised action ${action} must have a backend operation`);
  }
  const legacy = v2exBackendCapabilities.find((capability) => capability.name === V2EX_BACKEND_LEGACY)!;
  for (const operation of legacy.operations) {
    assert.deepEqual(operation.auth, ['anonymous']);
    assert.equal(operation.pagination, 'none');
  }
  const v2 = v2exBackendCapabilities.find((capability) => capability.name === V2EX_BACKEND_V2)!;
  for (const operation of v2.operations) {
    assert.deepEqual(operation.auth, ['api_key']);
  }
});

// ── Default worker export ──

test('default v2exWorker export exposes the platform seam', () => {
  assert.deepEqual(v2exWorker.platforms, ['v2ex']);
  assert.equal(typeof v2exWorker.plans, 'function');
  assert.equal(typeof v2exWorker.normalize, 'function');
});