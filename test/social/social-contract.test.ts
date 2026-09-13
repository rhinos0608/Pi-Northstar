import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_SOCIAL_LIMIT,
  SOCIAL_ACTIONS,
  SOCIAL_CANONICAL_ACTIONS,
  SOCIAL_ENTITY_KINDS,
  SOCIAL_MAX_CURSOR_LENGTH,
  SOCIAL_MAX_LIMIT,
  SOCIAL_PLATFORMS,
  SocialError,
  backendSupportsAction,
  canonicalActionsFor,
  decodeSocialCursor,
  encodeSocialCursor,
  extractSelectorsFromUrl,
  isAdvertisedAction,
  parseSocialDate,
  renderSocialEntity,
  renderSocialPage,
  resolveSocialAction,
  resolveSocialLimit,
  selectorSpecFor,
  socialCursorFingerprint,
  socialEntityId,
  validateSocialEntity,
  validateSocialPage,
  validateSocialRequest,
  type BackendCapability,
  type SocialBackendPlan,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialPostV1,
} from '../../src/social/social-contract.js';
import * as facade from '../../src/social/social-contract.js';
import * as socialCore from '../../src/social/social-core.js';
import * as socialEntityContract from '../../src/social/social-entity-contract.js';

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

function postEntity(overrides: Partial<SocialPostV1> = {}): SocialPostV1 {
  return {
    version: 1,
    kind: 'social_post',
    id: 'reddit:social_post:abc',
    platform: 'reddit',
    backend: 'reddit-cookie',
    contentType: 'post',
    title: 'Hello',
    text: 'Body text',
    publishedAt: '2024-05-01T10:00:00.000Z',
    url: 'https://reddit.com/r/x/comments/abc',
    metrics: { score: 12, comments: 3 },
    ...overrides,
  };
}

// ── Canonical action registry ──

test('every platform advertises only actions from the canonical vocabulary', () => {
  for (const platform of SOCIAL_PLATFORMS) {
    for (const action of SOCIAL_CANONICAL_ACTIONS[platform]) {
      assert.ok((SOCIAL_ACTIONS as readonly string[]).includes(action));
      assert.ok(isAdvertisedAction(platform, action));
    }
  }
});

test('canonical actions match the Stage 2 capability table exactly', () => {
  assert.deepEqual(canonicalActionsFor('twitter'), [
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
    'get_profile', 'get_user_posts', 'get_followers', 'get_following',
    'get_feed', 'get_trending', 'get_saved', 'get_notifications',
  ]);
  assert.deepEqual(canonicalActionsFor('reddit'), [
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
    'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
    'get_trending', 'get_saved', 'get_community', 'get_community_posts',
  ]);
  assert.deepEqual(canonicalActionsFor('xiaohongshu'), [
    'search', 'get_post', 'get_comments', 'get_profile', 'get_user_posts',
    'get_followers', 'get_following', 'get_feed', 'get_saved', 'get_notifications',
  ]);
  assert.deepEqual(canonicalActionsFor('facebook'), [
    'search', 'get_profile', 'get_feed', 'get_notifications', 'get_community',
  ]);
  assert.deepEqual(canonicalActionsFor('instagram'), [
    'search', 'get_profile', 'get_user_posts', 'get_followers', 'get_following',
    'get_trending', 'get_saved',
  ]);
  assert.deepEqual(canonicalActionsFor('v2ex'), [
    'get_topic', 'get_thread', 'get_comments', 'get_profile', 'get_trending',
    'get_community', 'get_community_posts', 'get_notifications',
  ]);
  assert.deepEqual(canonicalActionsFor('linkedin'), [
    'search', 'get_profile', 'get_user_posts', 'get_feed',
  ]);
});

test('instagram never advertises get_post, get_thread, get_comments, or feed', () => {
  const instagram = canonicalActionsFor('instagram');
  for (const forbidden of ['get_post', 'get_thread', 'get_comments', 'get_feed', 'get_notifications']) {
    assert.ok(!instagram.includes(forbidden as never), `instagram must not advertise ${forbidden}`);
  }
});

// ── Canonical-only action resolution (no aliases) ──

test('resolveSocialAction accepts advertised canonical actions', () => {
  assert.equal(resolveSocialAction('twitter', 'get_thread'), 'get_thread');
  assert.equal(resolveSocialAction('v2ex', 'get_topic'), 'get_topic');
  assert.equal(resolveSocialAction('instagram', 'get_trending'), 'get_trending');
});

test('legacy alias names are rejected, never mapped', () => {
  const legacyNames = ['tweet', 'note', 'topic', 'hot', 'popular', 'comments', 'subreddit', 'subreddit_info', 'all', 'explore', 'profile', 'user', 'node', 'replies', 'article', 'groups', 'feed', 'saved', 'read', 'post'];
  for (const name of legacyNames) {
    for (const platform of SOCIAL_PLATFORMS) {
      // Every platform rejects every legacy spelling — no alias mapping.
      socialError('unsupported_action', () => resolveSocialAction(platform, name));
    }
  }
});

test('instagram read and post deterministically return unsupported_action and never resolve to a dispatchable action', () => {
  for (const action of ['read', 'post']) {
    const error = socialError('unsupported_action', () => resolveSocialAction('instagram', action));
    assert.ok(!/download/.test(error.message));
  }
  // And the request validator rejects them before plan building too.
  socialError('unsupported_action', () => validateSocialRequest({ platform: 'instagram', action: 'read' }));
  socialError('unsupported_action', () => validateSocialRequest({ platform: 'instagram', action: 'post', postId: 'abc' }));
});

test('unknown platform actions throw unsupported_action before any dispatch', () => {
  socialError('unsupported_action', () => resolveSocialAction('twitter', 'post_tweet'));
  socialError('unsupported_action', () => resolveSocialAction('reddit', 'unvote'));
});

// ── Selector / limit validation ──

test('validateSocialRequest normalizes a valid listing request', () => {
  const { request, warnings } = validateSocialRequest({
    platform: 'twitter',
    action: 'search',
    query: '  rust lang  ',
    limit: 30,
  });
  assert.equal(request.platform, 'twitter');
  assert.equal(request.action, 'search');
  assert.equal(request.query, 'rust lang');
  assert.equal(request.limit, 30);
  assert.deepEqual(warnings, []);
  assert.ok(!('requestedAction' in request));
});

test('selector requirements are platform-aware', () => {
  assert.deepEqual(selectorSpecFor('twitter', 'search').required, ['query']);
  assert.deepEqual(selectorSpecFor('v2ex', 'get_topic').required, ['topic']);
  assert.deepEqual(selectorSpecFor('facebook', 'get_feed').required ?? [], []);
  assert.ok((selectorSpecFor('twitter', 'get_post').anyOf ?? []).includes('postId'));

  socialError('invalid_request', () => validateSocialRequest({ platform: 'twitter', action: 'search' }));
  socialError('invalid_request', () => validateSocialRequest({ platform: 'twitter', action: 'get_profile' }));
  socialError('invalid_request', () => validateSocialRequest({ platform: 'reddit', action: 'get_community_posts' }));
  socialError('invalid_request', () => validateSocialRequest({ platform: 'v2ex', action: 'get_topic' }));
  socialError('invalid_request', () => validateSocialRequest({ platform: 'facebook', action: 'get_community' }));
});

test('anyOf selectors accept postId or commentId', () => {
  const viaPost = validateSocialRequest({ platform: 'twitter', action: 'get_post', postId: '1234' });
  assert.equal(viaPost.request.postId, '1234');
  const viaComment = validateSocialRequest({ platform: 'twitter', action: 'get_comment_replies', commentId: '99' });
  assert.equal(viaComment.request.commentId, '99');
});

test('empty selector strings are rejected, not silently dropped', () => {
  socialError('invalid_request', () => validateSocialRequest({ platform: 'twitter', action: 'search', query: '   ' }));
  socialError('invalid_request', () => validateSocialRequest({ platform: 'twitter', action: 'get_post', postId: '' }));
});

test('unsupported platform is invalid_request', () => {
  socialError('invalid_request', () => validateSocialRequest({ platform: 'gab', action: 'search', query: 'x' }));
});

test('limit defaults, clamps, and rejects garbage', () => {
  assert.equal(resolveSocialLimit(undefined).limit, DEFAULT_SOCIAL_LIMIT);
  assert.deepEqual(resolveSocialLimit(undefined), { limit: DEFAULT_SOCIAL_LIMIT, warnings: [] });
  const clamped = resolveSocialLimit(500);
  assert.equal(clamped.limit, SOCIAL_MAX_LIMIT);
  assert.deepEqual(clamped.warnings, ['limit clamped to 100']);
  assert.equal(resolveSocialLimit(7).limit, 7);
  for (const bad of [0, -1, 1.5, '5', NaN, Number.POSITIVE_INFINITY]) {
    socialError('invalid_request', () => resolveSocialLimit(bad));
  }
  socialError('invalid_request', () => validateSocialRequest({ platform: 'twitter', action: 'get_feed', limit: 0 }));
});

test('over-limit requests clamp with a warning', () => {
  const { request, warnings } = validateSocialRequest({
    platform: 'reddit', action: 'search', query: 'x', limit: 250,
  });
  assert.equal(request.limit, SOCIAL_MAX_LIMIT);
  assert.ok(warnings.includes('limit clamped to 100'));
});

// ── URL extraction ──

test('canonical URLs extract selectors and satisfy requirements', () => {
  const twitter = validateSocialRequest({
    platform: 'twitter', action: 'get_post', url: 'https://x.com/i/web/status/123456',
  });
  assert.equal(twitter.request.postId, '123456');
  assert.ok(twitter.warnings.includes('postId derived from url'));

  const twitterUser = extractSelectorsFromUrl('twitter', 'https://www.twitter.com/naval');
  assert.deepEqual(twitterUser, { user: 'naval' });

  const redditThread = validateSocialRequest({
    platform: 'reddit', action: 'get_comments',
    url: 'https://reddit.com/r/typescript/comments/abc123/some_slug/def456',
  });
  assert.equal(redditThread.request.community, 'typescript');
  assert.equal(redditThread.request.postId, 'abc123');
  assert.equal(redditThread.request.commentId, 'def456');

  const v2ex = validateSocialRequest({ platform: 'v2ex', action: 'get_thread', url: 'https://v2ex.com/t/1102233' });
  assert.equal(v2ex.request.postId, '1102233');
  assert.equal(v2ex.request.topic, '1102233');

  const v2exNode = extractSelectorsFromUrl('v2ex', 'https://v2ex.com/go/programmer');
  assert.deepEqual(v2exNode, { community: 'programmer' });

  const instagram = extractSelectorsFromUrl('instagram', 'https://instagram.com/p/CdefGhiJklm');
  assert.deepEqual(instagram, { postId: 'CdefGhiJklm' });

  const linkedin = extractSelectorsFromUrl('linkedin', 'https://linkedin.com/in/ada-lovelace/');
  assert.deepEqual(linkedin, { user: 'ada-lovelace' });

  const xhs = validateSocialRequest({
    platform: 'xiaohongshu', action: 'get_post', url: 'https://xiaohongshu.com/explore/65f0a1b2c3d4e5f6a7b8c9d0',
  });
  assert.equal(xhs.request.postId, '65f0a1b2c3d4e5f6a7b8c9d0');
});

test('explicit selectors win over URL-derived ones', () => {
  const { request, warnings } = validateSocialRequest({
    platform: 'twitter', action: 'get_post', postId: '111', url: 'https://x.com/user/status/222',
  });
  assert.equal(request.postId, '111');
  assert.ok(!warnings.some((warning) => warning.includes('derived from url')));
});

test('hostile URLs are rejected before path parsing', () => {
  const cases: Array<[string, string]> = [
    ['lookalike host', 'https://twitter.com.evil.com/user/status/1'],
    ['lookalike prefix', 'https://evil-twitter.com/user/status/1'],
    ['wrong platform host', 'https://reddit.com/r/x/comments/abc'],
    ['credentials', 'https://user:pass@twitter.com/user/status/1'],
    ['non-http scheme', 'ftp://twitter.com/user/status/1'],
    ['non-default port', 'https://twitter.com:8080/user/status/1'],
    ['unparseable', 'not a url'],
  ];
  for (const [label, url] of cases) {
    const error = socialError('invalid_request', () => extractSelectorsFromUrl('twitter', url));
    assert.ok(error.message.length > 0, `${label} should produce a message`);
  }
});

test('unrecognized URL shapes throw instead of guessing', () => {
  socialError('invalid_request', () => extractSelectorsFromUrl('twitter', 'https://twitter.com/search?q=x'));
  socialError('invalid_request', () => extractSelectorsFromUrl('reddit', 'https://reddit.com/rising'));
  socialError('invalid_request', () => extractSelectorsFromUrl('v2ex', 'https://v2ex.com/t/notanumber'));
  socialError('invalid_request', () => extractSelectorsFromUrl('xhs' as never, 'https://xhslink.com/abc'));
  socialError('invalid_request', () => extractSelectorsFromUrl('xiaohongshu', 'https://xiaohongshu.com/explore/short'));
});

// ── Cursors ──

function makeCursor(overrides: Partial<Parameters<typeof encodeSocialCursor>[0]> = {}): string {
  return encodeSocialCursor({
    platform: 'reddit',
    action: 'get_trending',
    backend: 'rdt-cli',
    fingerprint: socialCursorFingerprint({ platform: 'reddit', action: 'get_trending', query: 'rust', limit: 20 }),
    state: { after: 't3_abc' },
    ...overrides,
  });
}

test('cursors round-trip and bind to platform/action/backend/fingerprint', () => {
  const fingerprint = socialCursorFingerprint({ platform: 'reddit', action: 'get_trending', query: 'rust', limit: 20 });
  const cursor = encodeSocialCursor({
    platform: 'reddit', action: 'get_trending', backend: 'rdt-cli', fingerprint, state: { after: 't3_abc', page: 2 },
  });
  const decoded = decodeSocialCursor(cursor, {
    platform: 'reddit', action: 'get_trending', backend: 'rdt-cli', fingerprint,
  });
  assert.deepEqual(decoded.state, { after: 't3_abc', page: 2 });
  assert.equal(decoded.platform, 'reddit');
  assert.equal(decoded.action, 'get_trending');
  assert.equal(decoded.backend, 'rdt-cli');
});

test('cursor fingerprint covers selectors, sort, time range, and limit', () => {
  const base = socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'rust', limit: 20 });
  assert.notEqual(base, socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'rust', limit: 21 }));
  assert.notEqual(base, socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'golang', limit: 20 }));
  assert.notEqual(base, socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'rust', limit: 20, sort: 'top' }));
  assert.notEqual(base, socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'rust', limit: 20, timeRange: 'week' }));
  assert.notEqual(base, socialCursorFingerprint({ platform: 'twitter', action: 'search', query: 'rust', limit: 20 }));
  assert.equal(base, socialCursorFingerprint({ platform: 'reddit', action: 'search', query: 'rust', limit: 20 }));
});

test('cursor mismatch rejects platform/action/backend/fingerprint changes', () => {
  const good = makeCursor();
  const expected = {
    platform: 'reddit' as const, action: 'get_trending' as const, backend: 'rdt-cli',
    fingerprint: socialCursorFingerprint({ platform: 'reddit', action: 'get_trending', query: 'rust', limit: 20 }),
  };
  decodeSocialCursor(good, expected); // ok

  const changedPlatform = { ...expected, platform: 'twitter' as const };
  socialError('cursor_mismatch', () => decodeSocialCursor(good, changedPlatform));
  const changedAction = { ...expected, action: 'search' as const };
  socialError('cursor_mismatch', () => decodeSocialCursor(good, changedAction));
  const changedBackend = { ...expected, backend: 'reddit-cookie' };
  socialError('cursor_mismatch', () => decodeSocialCursor(good, changedBackend));
  const changedFingerprint = { ...expected, fingerprint: 'deadbeef' };
  socialError('cursor_mismatch', () => decodeSocialCursor(good, changedFingerprint));
});

test('malformed and oversized cursors are cursor_invalid', () => {
  socialError('cursor_invalid', () => decodeSocialCursor('not-base64-json!!', {
    platform: 'reddit', action: 'get_trending', backend: 'rdt-cli', fingerprint: 'x',
  }));
  socialError('cursor_invalid', () => decodeSocialCursor('', {
    platform: 'reddit', action: 'get_trending', backend: 'rdt-cli', fingerprint: 'f',
  }));
  const wrongVersion = Buffer.from(JSON.stringify({ v: 2, platform: 'reddit', action: 'get_trending', backend: 'b', fingerprint: 'f', state: {} })).toString('base64url');
  socialError('cursor_invalid', () => decodeSocialCursor(wrongVersion, {
    platform: 'reddit', action: 'get_trending', backend: 'b', fingerprint: 'f',
  }));
  const oversized = 'A'.repeat(SOCIAL_MAX_CURSOR_LENGTH + 1);
  socialError('cursor_invalid', () => decodeSocialCursor(oversized, {
    platform: 'reddit', action: 'get_trending', backend: 'b', fingerprint: 'f',
  }));
  socialError('cursor_invalid', () => encodeSocialCursor({
    platform: 'reddit', action: 'get_trending', backend: 'b', fingerprint: 'f',
    state: { nested: 'https://example.com' },
  }));
});

test('cursors never carry secrets, cookies, tokens, or authenticated URLs', () => {
  const badStates: Array<Record<string, string>> = [
    { cookie: 'session=1' },
    { token: 'xsec_token=abc' },
    { next: 'xsec_token%3Ddeadbeef' },
    { after: 'https://reddit.com/api/listing?after=t3_x&auth=secret' },
    { authorization: 'Bearer xyz' },
    { ct0: 'abcdef' },
  ];
  for (const state of badStates) {
    socialError('cursor_invalid', () => encodeSocialCursor({
      platform: 'reddit', action: 'get_trending', backend: 'rdt-cli',
      fingerprint: 'f', state,
    }));
  }
  // Allowed pagination state round-trips cleanly.
  const cursor = makeCursor();
  const decoded = decodeSocialCursor(cursor, {
    platform: 'reddit', action: 'get_trending', backend: 'rdt-cli',
    fingerprint: socialCursorFingerprint({ platform: 'reddit', action: 'get_trending', query: 'rust', limit: 20 }),
  });
  assert.deepEqual(decoded.state, { after: 't3_abc' });
});

// ── SocialError ──

test('SocialError retryable defaults follow the code', () => {
  assert.equal(new SocialError('rate_limited', 'x').retryable, true);
  assert.equal(new SocialError('backend_unavailable', 'x').retryable, true);
  assert.equal(new SocialError('upstream_error', 'x').retryable, true);
  assert.equal(new SocialError('malformed_upstream', 'x').retryable, true);
  assert.equal(new SocialError('invalid_request', 'x').retryable, false);
  assert.equal(new SocialError('unsupported_action', 'x').retryable, false);
  assert.equal(new SocialError('not_found', 'x').retryable, false);
  assert.equal(new SocialError('permission_denied', 'x').retryable, false);
  assert.equal(new SocialError('cursor_invalid', 'x').retryable, false);
  assert.equal(new SocialError('cursor_mismatch', 'x').retryable, false);
  const forced = new SocialError('not_found', 'x', { retryable: true });
  assert.equal(forced.retryable, true);
  assert.equal(new SocialError('invalid_request', 'x', { platform: 'twitter' }).platform, 'twitter');
  assert.equal(new SocialError('rate_limited', 'x', { backend: 'twitter-cli' }).backend, 'twitter-cli');
});

// ── Entity types and envelope validation ──

test('validateSocialPage accepts a valid page', () => {
  const entity: SocialPostV1 = postEntity();
  const page: SocialPageV1 = {
    entities: [entity],
    pagination: { supported: true, limit: 20, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
  };
  const result = validateSocialPage(page);
  assert.equal(result.ok, true, result.issues.join('; '));
});

test('envelope validator rejects NaN metrics, invalid dates, malformed URLs, and unknown fields', () => {
  const nanMetrics = postEntity({ metrics: { score: Number.NaN } });
  assert.ok(!validateSocialEntity(nanMetrics).ok);

  const badDate = postEntity({ publishedAt: 'not a date' });
  assert.ok(!validateSocialEntity(badDate).ok);

  const badUrl = postEntity({ url: 'notaurl' });
  assert.ok(!validateSocialEntity(badUrl).ok);

  const unknownField = postEntity({ ...({ secretEnv: 'x' } as object) });
  const unknownCheck = validateSocialEntity(unknownField);
  assert.ok(!unknownCheck.ok);
  assert.ok(unknownCheck.issues.some((issue) => issue.includes('secretEnv')));

  const unknownMetric = postEntity({ metrics: { stars: 5 } as never });
  assert.ok(!validateSocialEntity(unknownMetric).ok);

  const badActor = postEntity({ author: { verified: 'yes' } as never });
  assert.ok(!validateSocialEntity(badActor).ok);

  const wrongVersion = postEntity({ version: 2 as never });
  assert.ok(!validateSocialEntity(wrongVersion).ok);

  // Comment requires postId and text.
  const comment = {
    version: 1, kind: 'social_comment', id: 'c1', platform: 'reddit', backend: 'b', text: 'hi', postId: 'p1',
  };
  assert.ok(validateSocialEntity(comment).ok);
  assert.ok(!validateSocialEntity({ ...comment, postId: undefined }).ok);
  assert.ok(!validateSocialEntity({ ...comment, text: '' }).ok);

  assert.ok(!validateSocialEntity({ kind: 'social_post' }).ok);
  assert.ok(!validateSocialEntity('not an object').ok);
});

test('page validator enforces pagination consistency', () => {
  const entity = postEntity();
  const base = {
    entities: [entity],
    partial: false,
    warnings: [] as string[],
    pagination: { supported: true, limit: 20, returned: 1, hasMore: false },
  };
  assert.equal(validateSocialPage(base).ok, true);

  assert.ok(!validateSocialPage({ ...base, pagination: { ...base.pagination, returned: 2 } }).ok);
  assert.ok(!validateSocialPage({ ...base, pagination: { ...base.pagination, hasMore: true } }).ok);
  assert.ok(!validateSocialPage({ ...base, pagination: { ...base.pagination, hasMore: true, nextCursor: 'abc', supported: false } }).ok);
  assert.ok(!validateSocialPage({ ...base, pagination: { ...base.pagination, nextCursor: 'abc' } }).ok);
  assert.ok(!validateSocialPage({ ...base, pagination: { ...base.pagination, limit: 'many' as never } }).ok);
  assert.ok(!validateSocialPage({ ...base, partial: 'no' as never }).ok);
  assert.ok(!validateSocialPage({ ...base, warnings: [1] as never }).ok);
  assert.ok(!validateSocialPage({ ...base, entities: 'many' as never }).ok);
  assert.ok(!validateSocialPage(null).ok);

  const emptyOk = validateSocialPage({
    entities: [], partial: false, warnings: [],
    pagination: { supported: false, limit: 20, returned: 0, hasMore: false },
  });
  assert.equal(emptyOk.ok, true);
});

test('hasMore requires supported plus a cursor, per the no-inference rule', () => {
  const cursor = makeCursor();
  const page: SocialPageV1 = {
    entities: [postEntity()],
    pagination: { supported: true, limit: 20, returned: 1, hasMore: true, nextCursor: cursor },
    partial: false,
    warnings: [],
  };
  assert.equal(validateSocialPage(page).ok, true);
});

// ── Dates ──

test('parseSocialDate handles epochs and ISO strings, drops garbage', () => {
  assert.equal(parseSocialDate(1714557600), '2024-05-01T10:00:00.000Z');
  assert.equal(parseSocialDate(1714557600000), '2024-05-01T10:00:00.000Z');
  assert.equal(parseSocialDate('2024-05-01T10:00:00Z'), '2024-05-01T10:00:00.000Z');
  assert.equal(parseSocialDate('garbage'), undefined);
  assert.equal(parseSocialDate(''), undefined);
  assert.equal(parseSocialDate(undefined), undefined);
  assert.equal(parseSocialDate(null), undefined);
});

// ── Worker seam ──

test('SocialPlatformWorker seam is satisfiable and workers declare plans', async () => {
  const plan: SocialBackendPlan = {
    backend: 'twitter-cli',
    authTier: 'cookie',
    pagination: 'none',
    execute: async () => ({ rows: [] }),
  };
  const worker: SocialPlatformWorker = {
    platforms: ['twitter'],
    plans: async () => [plan],
    normalize: () => ({
      entities: [], pagination: { supported: false, limit: 20, returned: 0, hasMore: false }, partial: false, warnings: [],
    }),
  };
  assert.deepEqual(worker.platforms, ['twitter']);
  const plans = await worker.plans(validateSocialRequest({
    platform: 'twitter', action: 'get_post', postId: '1',
  }).request, {});
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.backend, 'twitter-cli');
  await assert.doesNotReject(() => plans[0]!.execute());
});

// ── Backend capability shape ──

test('backendSupportsAction derives support from declared operations only', () => {
  const capability: BackendCapability = {
    name: 'twitter-cli',
    type: 'external',
    command: 'twitter',
    verifiedVersion: '0.8.5',
    operations: [
      { action: 'search', upstreamAction: ['search'], auth: ['cookie', 'anonymous'], pagination: 'none', required: ['query'], maxLimit: 50 },
    ],
  };
  assert.equal(backendSupportsAction(capability, 'search'), true);
  assert.equal(backendSupportsAction(capability, 'get_post'), false);
});

// ── Rendering ──

test('renderSocialEntity produces deterministic human-readable text', () => {
  const rendered = renderSocialEntity(postEntity({
    author: { handle: 'ada', displayName: 'Ada' },
    metrics: { score: 12, comments: 3 },
  }));
  assert.ok(rendered.includes('[post] Hello'));
  assert.ok(rendered.includes('@ada'));
  assert.ok(rendered.includes('score 12'));
  assert.ok(rendered.includes('comments 3'));
  assert.ok(rendered.includes('2024-05-01T10:00:00.000Z'));
  assert.equal(renderSocialEntity(postEntity()), renderSocialEntity(postEntity()));

  const comment = renderSocialEntity({
    version: 1, kind: 'social_comment', id: 'c1', platform: 'reddit', backend: 'b',
    postId: 'p1', text: 'first!',
  });
  assert.ok(comment.includes('[comment] first!'));
  assert.ok(comment.includes('on post p1'));

  const account = renderSocialEntity({
    version: 1, kind: 'social_account', id: 'u1', platform: 'twitter', backend: 'b',
    handle: 'ada', metrics: { followers: 10 },
  });
  assert.ok(account.includes('[account] @ada'));
  assert.ok(account.includes('followers 10'));

  const thread = renderSocialEntity({
    version: 1, kind: 'social_thread', id: 't1', platform: 'reddit', backend: 'b',
    rootPostId: 'p1', title: 'Deep dive', postIds: ['p1', 'p2'],
  });
  assert.ok(thread.includes('[thread] Deep dive'));
  assert.ok(thread.includes('root post p1'));
  assert.ok(thread.includes('2 posts'));

  const media = renderSocialEntity({
    version: 1, kind: 'social_media', id: 'm1', platform: 'twitter', backend: 'b',
    postId: 'p1', mediaType: 'image',
  });
  assert.ok(media.includes('[media:image] on post p1'));

  const relationship = renderSocialEntity({
    version: 1, kind: 'social_relationship', id: 'r1', platform: 'twitter', backend: 'b',
    user: 'ada', relatedUser: 'grace', relationship: 'following',
  });
  assert.ok(relationship.includes('[relationship] ada following grace'));

  const engagement = renderSocialEntity({
    version: 1, kind: 'social_engagement', id: 'e1', platform: 'twitter', backend: 'b',
    postId: 'p1', engagementType: 'like',
  });
  assert.ok(engagement.includes('[engagement:like] on post p1'));
});

test('renderSocialPage renders empty, warning, and cursor states', () => {
  const empty = renderSocialPage({
    entities: [],
    pagination: { supported: false, limit: 20, returned: 0, hasMore: false },
    partial: false,
    warnings: [],
  });
  assert.equal(empty, '(no results)');

  const paged = renderSocialPage({
    entities: [],
    pagination: { supported: true, limit: 20, returned: 0, hasMore: true, nextCursor: 'abc' },
    partial: true,
    warnings: ['dropped 1 malformed row'],
  });
  assert.ok(paged.includes('more results available'));
  assert.ok(paged.includes('warning: dropped 1 malformed row'));
  assert.ok(paged.includes('partial'));

  const listing = renderSocialPage({
    entities: [],
    pagination: { supported: true, limit: 20, returned: 0, hasMore: false },
    partial: false,
    warnings: [],
  });
  assert.ok(listing.includes('0 of up to 20 results'));
});

// ── Misc helpers ──

test('socialEntityId namespaces by platform/kind/native id', () => {
  assert.equal(socialEntityId('twitter', 'social_post', '123'), 'twitter:social_post:123');
});

test('thread, media, relationship, and engagement entities validate strictly', () => {
  assert.ok(validateSocialEntity({
    version: 1, kind: 'social_thread', id: 't1', platform: 'reddit', backend: 'b',
    rootPostId: 'p1', title: 'Deep dive', postIds: ['p1'],
  }).ok);
  assert.ok(validateSocialEntity({
    version: 1, kind: 'social_media', id: 'm1', platform: 'twitter', backend: 'b',
    postId: 'p1', mediaType: 'video', url: 'https://example.com/v.mp4',
  }).ok);
  assert.ok(validateSocialEntity({
    version: 1, kind: 'social_relationship', id: 'r1', platform: 'twitter', backend: 'b',
    user: 'ada', relatedUser: 'grace', relationship: 'mutual',
  }).ok);
  assert.ok(validateSocialEntity({
    version: 1, kind: 'social_engagement', id: 'e1', platform: 'twitter', backend: 'b',
    postId: 'p1', engagementType: 'repost',
  }).ok);

  assert.ok(!validateSocialEntity({
    version: 1, kind: 'social_thread', id: 't1', platform: 'reddit', backend: 'b',
  }).ok);
  assert.ok(!validateSocialEntity({
    version: 1, kind: 'social_media', id: 'm1', platform: 'twitter', backend: 'b',
    postId: 'p1', mediaType: 'audio',
  }).ok);
  assert.ok(!validateSocialEntity({
    version: 1, kind: 'social_relationship', id: 'r1', platform: 'twitter', backend: 'b',
    user: 'ada', relatedUser: 'grace', relationship: 'blocks',
  }).ok);
  assert.ok(!validateSocialEntity({
    version: 1, kind: 'social_engagement', id: 'e1', platform: 'twitter', backend: 'b',
    postId: 'p1', engagementType: 'buy',
  }).ok);
  assert.ok(!validateSocialEntity({
    version: 1, kind: 'social_account', id: 'u1', platform: 'twitter', backend: 'b',
    handle: 'ada', synthesized: true,
  }).ok);
});

test('entity kinds and platforms are disjoint closed sets', () => {
  assert.equal(SOCIAL_ENTITY_KINDS.size, 11);
  assert.equal(SOCIAL_PLATFORMS.length, 7);
  for (const kind of SOCIAL_ENTITY_KINDS) {
    assert.ok(!SOCIAL_PLATFORMS.includes(kind as never));
  }
});
// ── Seam4 split: vocabulary/error in social-core, entities in social-entity-contract ──

test('social-core owns vocabulary, capability registry, and error contract', () => {
  assert.equal(socialCore.SOCIAL_PLATFORMS, SOCIAL_PLATFORMS);
  assert.equal(socialCore.SOCIAL_ACTIONS, SOCIAL_ACTIONS);
  assert.equal(socialCore.SOCIAL_ENTITY_KINDS, SOCIAL_ENTITY_KINDS);
  assert.equal(socialCore.SOCIAL_CANONICAL_ACTIONS, SOCIAL_CANONICAL_ACTIONS);
  assert.equal(socialCore.SocialError, SocialError);
  assert.equal(socialCore.isSocialPlatform, facade.isSocialPlatform);
  assert.equal(socialCore.isSocialAction, facade.isSocialAction);
  assert.equal(socialCore.canonicalActionsFor, canonicalActionsFor);
  assert.equal(socialCore.isAdvertisedAction, isAdvertisedAction);
  assert.equal(socialCore.resolveSocialAction, resolveSocialAction);
});

test('social-entity-contract owns entity types, validators, and rendering', () => {
  assert.equal(socialEntityContract.validateSocialEntity, validateSocialEntity);
  assert.equal(socialEntityContract.validateSocialPage, validateSocialPage);
  assert.equal(socialEntityContract.renderSocialEntity, renderSocialEntity);
  assert.equal(socialEntityContract.renderSocialPage, renderSocialPage);
  assert.equal(socialEntityContract.socialEntityId, socialEntityId);
  assert.equal(socialEntityContract.parseSocialDate, parseSocialDate);
});

test('facade re-exports the full 64-export surface without drift', () => {
  const coreOwned: readonly (keyof typeof facade)[] = [
    'SOCIAL_PLATFORMS', 'SOCIAL_ACTIONS', 'SOCIAL_ENTITY_KINDS', 'SOCIAL_CANONICAL_ACTIONS',
    'SocialError', 'isSocialPlatform', 'isSocialAction', 'canonicalActionsFor',
    'isAdvertisedAction', 'resolveSocialAction',
  ];
  for (const name of coreOwned) {
    assert.equal(
      (facade as Record<string, unknown>)[name],
      (socialCore as Record<string, unknown>)[name],
      `facade.${name} drifts from social-core`,
    );
  }
  const entityOwned: readonly (keyof typeof facade)[] = [
    'validateSocialEntity', 'validateSocialPage', 'renderSocialEntity', 'renderSocialPage',
    'socialEntityId', 'parseSocialDate',
  ];
  for (const name of entityOwned) {
    assert.equal(
      (facade as Record<string, unknown>)[name],
      (socialEntityContract as Record<string, unknown>)[name],
      `facade.${name} drifts from social-entity-contract`,
    );
  }
  // 28 runtime values: 8 consts + 19 functions + SocialError.
  const runtimeNames = [
    'DEFAULT_SOCIAL_LIMIT', 'MAX_SELECTOR_LENGTH', 'SOCIAL_ACTIONS', 'SOCIAL_CANONICAL_ACTIONS', 'SOCIAL_ENTITY_KINDS',
    'SOCIAL_MAX_CURSOR_LENGTH', 'SOCIAL_MAX_LIMIT', 'SOCIAL_PLATFORMS',
    'SocialError', 'backendSupportsAction', 'canonicalActionsFor', 'decodeSocialCursor',
    'encodeSocialCursor', 'extractSelectorsFromUrl', 'isAdvertisedAction', 'isSocialAction',
    'isSocialPlatform', 'parseSocialDate', 'renderSocialEntity', 'renderSocialPage',
    'resolveSocialAction', 'resolveSocialLimit', 'selectorSpecFor', 'socialCursorFingerprint',
    'socialEntityId', 'validateSocialEntity', 'validateSocialPage', 'validateSocialRequest',
  ];
  assert.equal(Object.keys(facade).length, runtimeNames.length);
  for (const name of runtimeNames) {
    assert.ok(name in facade, `facade missing runtime export ${name}`);
  }
});
