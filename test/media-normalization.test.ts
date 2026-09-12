import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeMediaPage } from '../src/media-normalization.js';
import { decodeMediaCursor, mediaCursorFingerprint } from '../src/media-contract.js';
import type { MediaBackendPlan, MediaRequest } from '../src/media-contract.js';

function youtubeSearchRequest(limit = 10): MediaRequest {
  return { channel: 'youtube', action: 'search', query: 'cats', limit };
}

function testPlan(backend: string): MediaBackendPlan {
  return {
    backend,
    authTier: 'anonymous',
    pagination: 'cursor',
    degraded: false,
    quality: 'full',
    execute: async () => ({}),
  };
}

// Warning order: search rows drop in item order, invalid-row messages first.
test('youtube search preserves warning order and marks partial', () => {
  const payload = {
    items: [
      { id: {}, snippet: { title: 'no id' } },
      { id: { videoId: 'v1' }, snippet: { title: 'Good', channelTitle: 'c' } },
      'junk',
    ],
    nextPageToken: 'TOKEN2',
  };
  const page = normalizeMediaPage(youtubeSearchRequest(), testPlan('youtube-data-api'), payload);
  assert.equal(page.entities.length, 1);
  const first = page.entities[0];
  assert.equal(first?.kind, 'video');
  if (first?.kind === 'video') assert.equal(first.id, 'youtube:video:v1');
  assert.equal(page.partial, true);
  assert.deepEqual(page.warnings, [
    'dropped search row without videoId',
    'dropped non-object search row',
  ]);
  assert.equal(page.pagination.hasMore, true);
});

// Cursor accounting: nextCursor decodes to the upstream pageToken with pinned selectors.
test('youtube search cursor round-trips pageToken and selector fingerprint', () => {
  const request = youtubeSearchRequest();
  const page = normalizeMediaPage(request, testPlan('youtube-data-api'), { items: [], nextPageToken: 'TOKEN2' });
  assert.equal(page.pagination.hasMore, true);
  assert.ok(page.pagination.nextCursor);
  const decoded = decodeMediaCursor(page.pagination.nextCursor as string, {
    channel: request.channel,
    action: request.action,
    backend: 'youtube-data-api',
    fingerprint: mediaCursorFingerprint({ channel: request.channel, action: request.action, query: 'cats', limit: request.limit }),
  });
  assert.deepEqual(decoded?.state, { pageToken: 'TOKEN2' });
  // No token -> no further pages, no cursor.
  const last = normalizeMediaPage(request, testPlan('youtube-data-api'), { items: [] });
  assert.equal(last.pagination.hasMore, false);
  assert.equal(last.pagination.nextCursor, undefined);
  assert.equal(last.partial, false);
});

// Partial status: details rows drop invalid entries but keep valid ones.
test('youtube details drops invalid rows and stays partial', () => {
  const request: MediaRequest = { channel: 'youtube', action: 'details', id: 'v1', limit: 10 };
  const page = normalizeMediaPage(request, testPlan('youtube-data-api'), {
    items: [
      { id: 'v1', snippet: { title: 'Ok' }, contentDetails: { duration: 'PT10S' }, statistics: { viewCount: '7' } },
      { snippet: { title: 'missing id' } },
    ],
  });
  assert.equal(page.entities.length, 1);
  const first = page.entities[0];
  assert.equal(first?.kind, 'video');
  if (first?.kind === 'video') assert.equal(first.durationSeconds, 10);
  assert.equal(page.partial, true);
  assert.deepEqual(page.warnings, ['dropped video row without id']);
});

// Bilibili: rows truncate to limit with the truncation warning first.
test('bilibili truncates rows to limit and warns first', () => {
  const request: MediaRequest = { channel: 'bilibili', action: 'hot', limit: 1 };
  const page = normalizeMediaPage(
    request,
    testPlan('bili-cli'),
    { items: [{ bvid: 'BV1xx411x7xA', title: 'One' }, { bvid: 'BV1xx411x7xB', title: 'Two' }] },
  );
  assert.equal(page.entities.length, 1);
  assert.equal(page.partial, true);
  assert.equal(page.warnings[0], 'bilibili rows truncated to limit 1');
});

// RSS: entries without any url are dropped with index-ordered warnings.
test('rss drops entries without url in order', () => {
  const request: MediaRequest = { channel: 'rss', action: 'feed', url: 'https://example.com/feed.xml', limit: 10 };
  const page = normalizeMediaPage(
    request,
    { ...testPlan('native-rss-atom'), pagination: 'unsupported' },
    {
      feedUrl: '',
      items: [
        { title: 'lost', url: '' },
        { title: 'kept', url: 'https://example.com/p1' },
      ],
    },
  );
  assert.equal(page.entities.length, 1);
  assert.equal(page.entities[0]?.kind, 'feed_entry');
  assert.deepEqual(page.warnings, ['dropped feed entry 0 without url']);
  assert.equal(page.partial, true);
});
