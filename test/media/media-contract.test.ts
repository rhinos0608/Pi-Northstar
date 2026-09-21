import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEDIA_CANONICAL_ACTIONS,
  decodeMediaCursor,
  encodeMediaCursor,
  mediaCursorFingerprint,
  orderMediaPlans,
  resolveMediaAction,
  resolveMediaLimit,
  validateMediaEntity,
  validateMediaPage,
  validateMediaRequest,
  type MediaAuthTier,
  type MediaBackendPlan,
  type MediaChannel,
  type MediaFeedEntryV1,
  type MediaPaginationMode,
  type MediaVideoTranscriptV1,
  type MediaVideoV1,
} from '../../src/media/media-contract.js';
import { SocialError } from '../../src/social/social-contract.js';

function mediaError(code: string, run: () => unknown): SocialError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof SocialError, `expected SocialError, got ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  throw new Error(`expected SocialError(${code}) but nothing was thrown`);
}

function plan(overrides: Partial<MediaBackendPlan> & { backend: string }): MediaBackendPlan {
  return {
    authTier: 'api_key' satisfies MediaAuthTier as MediaAuthTier,
    pagination: 'cursor' satisfies MediaPaginationMode as MediaPaginationMode,
    degraded: false,
    quality: 'full',
    execute: async () => undefined,
    ...overrides,
  };
}

function videoEntity(overrides: Partial<MediaVideoV1> = {}): MediaVideoV1 {
  return {
    version: 1,
    kind: 'video',
    id: 'youtube:video:abc123',
    channel: 'youtube',
    backend: 'youtube-data-api',
    url: 'https://www.youtube.com/watch?v=abc123',
    title: 'Hello',
    ...overrides,
  };
}

function feedEntity(overrides: Partial<MediaFeedEntryV1> = {}): MediaFeedEntryV1 {
  return {
    version: 1,
    kind: 'feed_entry',
    id: 'rss:feed_entry:1',
    channel: 'rss',
    backend: 'native-rss-atom',
    url: 'https://example.com/posts/1',
    title: 'Post',
    ...overrides,
  };
}

function transcriptEntity(overrides: Partial<MediaVideoTranscriptV1> = {}): MediaVideoTranscriptV1 {
  return {
    version: 1,
    kind: 'video_transcript',
    videoId: 'abc123',
    channel: 'youtube',
    backend: 'youtube-data-api',
    segments: [{ start: 0, duration: 2.5, text: 'hello' }],
    ...overrides,
  };
}

// ── Canonical vocabulary ──

test('canonical actions mirror the capability registry exactly', () => {
  assert.deepEqual(MEDIA_CANONICAL_ACTIONS.youtube, ['search', 'details', 'hot', 'transcript']);
  assert.deepEqual(MEDIA_CANONICAL_ACTIONS.bilibili, ['search', 'details', 'transcript', 'hot']);
  assert.deepEqual(MEDIA_CANONICAL_ACTIONS.rss, ['feed']);
});

test('legacy video spelling rejected on youtube and bilibili', () => {
  for (const channel of ['youtube', 'bilibili'] as const satisfies readonly MediaChannel[]) {
    const error = mediaError('unsupported_action', () => resolveMediaAction(channel, 'video'));
    assert.match(error.message, new RegExp(channel));
  }
});

test('legacy subtitle spelling rejected on youtube and bilibili', () => {
  for (const channel of ['youtube', 'bilibili'] as const satisfies readonly MediaChannel[]) {
    mediaError('unsupported_action', () => resolveMediaAction(channel, 'subtitle'));
  }
});

test('unsupported action and channel echoes are capped at 32 chars', () => {
  const longAction = `subtitle-${'x'.repeat(100)}`;
  const actionError = mediaError('unsupported_action', () => resolveMediaAction('youtube', longAction));
  assert.ok(!actionError.message.includes(longAction), `message must not echo unbounded action: ${actionError.message}`);
  assert.ok(actionError.message.includes(longAction.slice(0, 32)), 'message keeps the capped 32-char prefix');
  const longChannel = `youtube-${'y'.repeat(100)}`;
  const channelError = mediaError('invalid_request', () =>
    validateMediaRequest({ channel: longChannel, action: 'search', query: 'cats' }),
  );
  assert.ok(!channelError.message.includes(longChannel), `message must not echo unbounded channel: ${channelError.message}`);
  assert.ok(channelError.message.includes(longChannel.slice(0, 32)), 'message keeps the capped 32-char prefix');
});

test('unknown actions rejected with no pass-through', () => {
  mediaError('unsupported_action', () => resolveMediaAction('youtube', 'feed'));
  mediaError('unsupported_action', () => resolveMediaAction('rss', 'search'));
  mediaError('unsupported_action', () => resolveMediaAction('bilibili', 'feed'));
});

test('advertised actions resolve', () => {
  assert.equal(resolveMediaAction('youtube', 'search'), 'search');
  assert.equal(resolveMediaAction('youtube', 'transcript'), 'transcript');
  assert.equal(resolveMediaAction('bilibili', 'hot'), 'hot');
  assert.equal(resolveMediaAction('rss', 'feed'), 'feed');
});

// ── Request validation ──

test('search requires query; details/transcript require url or id; hot requires none', () => {
  mediaError('invalid_request', () => validateMediaRequest({ channel: 'youtube', action: 'search' }));
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'details' }),
  );
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'bilibili', action: 'transcript' }),
  );
  const { request: hot } = validateMediaRequest({ channel: 'youtube', action: 'hot' });
  assert.equal(hot.limit, 20);
  const { request: byId } = validateMediaRequest({
    channel: 'youtube',
    action: 'details',
    id: 'abc123',
  });
  assert.equal(byId.id, 'abc123');
  const { request: byUrl } = validateMediaRequest({
    channel: 'bilibili',
    action: 'transcript',
    url: 'https://www.bilibili.com/video/BV1xx',
  });
  assert.equal(byUrl.url, 'https://www.bilibili.com/video/BV1xx');
  mediaError('invalid_request', () => validateMediaRequest({ channel: 'rss', action: 'feed' }));
  const { request: feed } = validateMediaRequest({
    channel: 'rss',
    action: 'feed',
    url: 'https://example.com/feed.xml',
  });
  assert.equal(feed.url, 'https://example.com/feed.xml');
});

test('limit clamps include upper bounds', () => {
  const youtube = validateMediaRequest({
    channel: 'youtube',
    action: 'search',
    query: 'cats',
    limit: 100,
  });
  assert.equal(youtube.request.limit, 50);
  assert.ok(youtube.warnings.some((warning) => warning.includes('50')));

  const general = validateMediaRequest({
    channel: 'bilibili',
    action: 'search',
    query: 'cats',
    limit: 100,
  });
  assert.equal(general.request.limit, 25);
  assert.ok(general.warnings.some((warning) => warning.includes('25')));

  const rss = validateMediaRequest({
    channel: 'rss',
    action: 'feed',
    url: 'https://example.com/feed.xml',
    limit: 100,
  });
  assert.equal(rss.request.limit, 50);

  const { limit } = resolveMediaLimit(10, 25);
  assert.equal(limit, 10);
  mediaError('invalid_request', () => resolveMediaLimit(0, 25));
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'search', query: 'cats', limit: 0 }),
  );
});

test('selector length caps enforced', () => {
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'search', query: 'x'.repeat(201) }),
  );
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'details', id: 'x'.repeat(65) }),
  );
});

test('option-shaped query rejected without echo', () => {
  const query = '--limit=50';
  const error = mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'search', query }),
  );
  assert.ok(!error.message.includes(query), `message must not echo rejected value: ${error.message}`);
});

test('option-shaped id rejected without echo', () => {
  const id = '--output=json';
  const error = mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'details', id }),
  );
  assert.ok(!error.message.includes(id), `message must not echo rejected value: ${error.message}`);
});

// ── Entity validators ──

test('video entity accepts valid and rejects unknown shapes', () => {
  assert.equal(validateMediaEntity(videoEntity()).ok, true);
  const missing = validateMediaEntity({ ...videoEntity(), id: undefined });
  assert.equal(missing.ok, false);
  const raw = validateMediaEntity({ ...videoEntity(), backend_text: 'raw dump' });
  assert.equal(raw.ok, false);
  assert.ok(raw.issues.some((issue) => issue.includes('backend_text')));
  const unknown = validateMediaEntity({ ...videoEntity(), bogus: 1 });
  assert.equal(unknown.ok, false);
});

test('feed_entry entity accepts valid and rejects unknown shapes', () => {
  assert.equal(validateMediaEntity(feedEntity()).ok, true);
  const missing = validateMediaEntity({ ...feedEntity(), title: 42 });
  assert.equal(missing.ok, false);
  const unknown = validateMediaEntity({ ...feedEntity(), backendText: 'raw' });
  assert.equal(unknown.ok, false);
});

test('video_transcript entity accepts valid segments and rejects bad shapes', () => {
  assert.equal(validateMediaEntity(transcriptEntity()).ok, true);
  const missing = validateMediaEntity({ ...transcriptEntity(), segments: undefined });
  assert.equal(missing.ok, false);
  const badSegment = validateMediaEntity({
    ...transcriptEntity(),
    segments: [{ start: -1, duration: 0, text: '' }],
  });
  assert.equal(badSegment.ok, false);
  const unknownKind = validateMediaEntity({ ...transcriptEntity(), kind: 'subtitle' });
  assert.equal(unknownKind.ok, false);
});

test('media page rejects backend_text and mismatched pagination', () => {
  const page = {
    entities: [videoEntity()],
    pagination: { supported: true, limit: 20, returned: 1, hasMore: false },
    partial: false,
    warnings: [],
  };
  const check = validateMediaPage(page);
  assert.equal(check.ok, true);
  assert.equal(check.page?.entities.length, 1);

  const raw = validateMediaPage({ ...page, backend_text: 'dump' });
  assert.equal(raw.ok, false);

  const mismatched = validateMediaPage({
    ...page,
    pagination: { supported: false, limit: 20, returned: 1, hasMore: true },
  });
  assert.equal(mismatched.ok, false);
});

// ── Cursors ──

function cursorInput() {
  return {
    channel: 'youtube' as const,
    action: 'search' as const,
    backend: 'youtube-data-api',
    fingerprint: mediaCursorFingerprint({
      channel: 'youtube',
      action: 'search',
      query: 'cats',
      limit: 20,
    }),
    state: { pageToken: 'CAUQAA' },
  };
}

test('cursor round-trip preserves pageToken state', () => {
  const input = cursorInput();
  const cursor = encodeMediaCursor(input);
  const decoded = decodeMediaCursor(cursor, {
    channel: input.channel,
    action: input.action,
    backend: input.backend,
    fingerprint: input.fingerprint,
  });
  assert.deepEqual(decoded.state, { pageToken: 'CAUQAA' });
  assert.equal(decoded.backend, 'youtube-data-api');
});

test('cursor fingerprint pins selectors; mismatch rejected', () => {
  const input = cursorInput();
  const cursor = encodeMediaCursor(input);
  const otherFingerprint = mediaCursorFingerprint({
    channel: 'youtube',
    action: 'search',
    query: 'dogs',
    limit: 20,
  });
  mediaError('cursor_mismatch', () =>
    decodeMediaCursor(cursor, {
      channel: input.channel,
      action: input.action,
      backend: input.backend,
      fingerprint: otherFingerprint,
    }),
  );
  mediaError('cursor_mismatch', () =>
    decodeMediaCursor(cursor, {
      channel: input.channel,
      action: input.action,
      backend: 'youtube-oembed',
      fingerprint: input.fingerprint,
    }),
  );
});

test('invalid cursor rejected', () => {
  const input = cursorInput();
  mediaError('cursor_invalid', () =>
    decodeMediaCursor('!!!not-a-cursor!!!', {
      channel: input.channel,
      action: input.action,
      backend: input.backend,
      fingerprint: input.fingerprint,
    }),
  );
  mediaError('cursor_invalid', () =>
    encodeMediaCursor({ ...input, state: { pageToken: 'https://evil.example/x' } }),
  );
});

// ── Plan ordering ──

test('plan ordering prefers complete full-quality cursor-capable plans', () => {
  const ordered = orderMediaPlans('youtube', [
    plan({ backend: 'youtube-oembed', authTier: 'anonymous', pagination: 'unsupported', degraded: true, quality: 'degraded' }),
    plan({ backend: 'youtube-data-api', authTier: 'api_key', pagination: 'cursor' }),
    plan({ backend: 'other', authTier: 'anonymous', pagination: 'page' }),
  ]);
  assert.equal(ordered[0]?.backend, 'other');
  assert.equal(ordered[1]?.backend, 'youtube-data-api');
  assert.equal(ordered[ordered.length - 1]?.backend, 'youtube-oembed');
});

// ── Phase 4 Slice 1: reject-before-dispatch hardening ──

test('validateMediaRequest rejects unknown fields instead of silently dropping them', () => {
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'search', query: 'cats', cursor: 'abc' } as unknown as never),
  );
  mediaError('invalid_request', () =>
    validateMediaRequest({ channel: 'youtube', action: 'search', query: 'cats', backend: 'b' } as unknown as never),
  );
});

test('validateMediaRequest rejects non-object input with invalid_request', () => {
  for (const bad of [null, undefined, 'x', 42, []] as unknown as never[]) {
    mediaError('invalid_request', () => validateMediaRequest(bad as never));
  }
});
