// Media payload normalization (pure mapping: backend payload -> MediaPageV1).
//
// Extracted from src/media.ts. Backend planning, credential routing,
// execution, and the northstar envelope stay in media.ts. This module owns
// only payload mapping: row shaping, warning order, partial status, and
// cursor accounting (nextCursor generation). No fetch, no child processes,
// no envelope rendering.

import {
  encodeMediaCursor,
  mediaCursorFingerprint,
  mediaEntityId,
  parseMediaDate,
  validateMediaEntity,
  type MediaBackendPlan,
  type MediaChannel,
  type MediaEntityV1,
  type MediaPageV1,
  type MediaRequest,
  type MediaVideoTranscriptV1,
} from './media-contract.js';
import { SocialError, type SocialPlatform } from '../social/social-contract.js';

export const YOUTUBE_TRANSCRIPT_BACKEND = 'youtube-transcript';

export const YOUTUBE_HOME = 'https://www.youtube.com/';
const BILIBILI_HOME = 'https://www.bilibili.com/';

// Transcript bounds: total caption text and segment count caps.
const MAX_TRANSCRIPT_CHARS = 100_000;
const MAX_TRANSCRIPT_SEGMENTS = 3_000;

function mediaPlatform(value: MediaChannel): SocialPlatform {
  return value as unknown as SocialPlatform;
}

function optString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value.replace(/[,+\s]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function validHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseIsoDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value.trim());
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  if (match[1] === undefined && match[2] === undefined && match[3] === undefined && match[4] === undefined) return undefined;
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function thumbnailFrom(row: Record<string, unknown>): string | undefined {
  const thumbnails = row['thumbnails'] as Record<string, { url?: unknown } | undefined> | undefined;
  if (typeof thumbnails !== 'object' || thumbnails === null) return undefined;
  for (const quality of ['maxres', 'high', 'medium', 'default']) {
    const url = thumbnails[quality]?.url;
    const valid = validHttpUrl(typeof url === 'string' ? url : undefined);
    if (valid !== undefined) return valid;
  }
  return undefined;
}

export function nextCursorFor(request: MediaRequest, backend: string, pageToken: string): string {
  return encodeMediaCursor({
    channel: request.channel,
    action: request.action,
    backend,
    fingerprint: mediaCursorFingerprint({
      channel: request.channel,
      action: request.action,
      ...(request.query !== undefined ? { query: request.query } : {}),
      ...(request.id !== undefined ? { id: request.id } : {}),
      ...(request.url !== undefined ? { url: request.url } : {}),
      limit: request.limit,
    }),
    state: { pageToken },
  });
}

function normalizeYoutubeSearchRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null) {
    warnings.push('dropped non-object search row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const snippet = (row['snippet'] ?? {}) as Record<string, unknown>;
  const idObject = row['id'] as { videoId?: unknown } | undefined;
  const videoId = typeof idObject?.videoId === 'string' ? idObject.videoId : undefined;
  if (!videoId) {
    warnings.push('dropped search row without videoId');
    return undefined;
  }
  const title = optString(snippet['title']);
  const author = optString(snippet['channelTitle']);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('youtube', 'video', videoId),
    channel: 'youtube',
    backend: 'youtube-data-api',
    url: `https://www.youtube.com/watch?v=${videoId}`,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(snippet['publishedAt']) !== undefined ? { publishedAt: parseMediaDate(snippet['publishedAt']) as string } : {}),
    ...(optString(snippet['description']) !== undefined ? { description: optString(snippet['description']) as string } : {}),
    ...((author !== undefined ? { author: { name: author } } : {})),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid search row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

function normalizeYoutubeVideoRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null) {
    warnings.push('dropped non-object video row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const snippet = (row['snippet'] ?? {}) as Record<string, unknown>;
  const details = (row['contentDetails'] ?? {}) as Record<string, unknown>;
  const statistics = (row['statistics'] ?? {}) as Record<string, unknown>;
  const id = optString(row['id']);
  if (id === undefined) {
    warnings.push('dropped video row without id');
    return undefined;
  }
  const title = optString(snippet['title']);
  const author = optString(snippet['channelTitle']);
  const duration = parseIsoDuration(details['duration']);
  const views = optNumber(statistics['viewCount']);
  const thumbnail = thumbnailFrom(snippet);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('youtube', 'video', id),
    channel: 'youtube',
    backend: 'youtube-data-api',
    url: `https://www.youtube.com/watch?v=${id}`,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(snippet['publishedAt']) !== undefined ? { publishedAt: parseMediaDate(snippet['publishedAt']) as string } : {}),
    ...(optString(snippet['description']) !== undefined ? { description: optString(snippet['description']) as string } : {}),
    ...(duration !== undefined ? { durationSeconds: duration } : {}),
    ...(views !== undefined ? { viewCount: views } : {}),
    ...(author !== undefined ? { author: { name: author } } : {}),
    ...(thumbnail !== undefined ? { thumbnailUrl: thumbnail } : {}),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid video row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

export function youtubeItemsOf(payload: unknown): { items: unknown[]; nextPageToken?: string } {
  if (typeof payload !== 'object' || payload === null) return { items: [] };
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record['items']) ? record['items'] as unknown[] : [];
  const nextPageToken = typeof record['nextPageToken'] === 'string' && record['nextPageToken'].length > 0
    ? record['nextPageToken'] as string
    : undefined;
  return { items, ...(nextPageToken !== undefined ? { nextPageToken } : {}) };
}

function youtubePage(
  request: MediaRequest,
  backend: string,
  entities: MediaEntityV1[],
  warnings: string[],
  nextPageToken?: string,
): MediaPageV1 {
  const paginated = request.action === 'search' || request.action === 'hot';
  const hasMore = paginated && nextPageToken !== undefined;
  return {
    entities,
    pagination: {
      supported: paginated,
      limit: request.limit,
      returned: entities.length,
      hasMore,
      ...(hasMore ? { nextCursor: nextCursorFor(request, backend, nextPageToken as string) } : {}),
    },
    partial: warnings.length > 0,
    warnings,
  };
}

export function decodeCaptionText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface TranscriptDraft {
  start: number;
  duration: number;
  text: string;
}

export function draftFromXml(xml: string): TranscriptDraft[] {
  const drafts: TranscriptDraft[] = [];
  for (const match of xml.matchAll(/<text\s+([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attrs = match[1] ?? '';
    const start = Number(/start="([^"]*)"/.exec(attrs)?.[1]);
    const duration = Number(/dur="([^"]*)"/.exec(attrs)?.[1]);
    const text = decodeCaptionText(match[2] ?? '');
    if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || text.length === 0) continue;
    drafts.push({ start, duration, text });
  }
  return drafts;
}

export function draftFromJson3(payload: unknown): TranscriptDraft[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const events = (payload as Record<string, unknown>)['events'];
  if (!Array.isArray(events)) return [];
  const drafts: TranscriptDraft[] = [];
  for (const event of events) {
    if (typeof event !== 'object' || event === null) continue;
    const row = event as Record<string, unknown>;
    const startMs = typeof row['tStartMs'] === 'number' ? row['tStartMs'] : undefined;
    const durationMs = typeof row['dDurationMs'] === 'number' ? row['dDurationMs'] : undefined;
    const segs = Array.isArray(row['segs']) ? row['segs'] : [];
    const text = decodeCaptionText(
      segs.map((seg) => (typeof seg === 'object' && seg !== null ? String((seg as Record<string, unknown>)['utf8'] ?? '') : '')).join(''),
    );
    if (startMs === undefined || !Number.isFinite(startMs) || startMs < 0 || text.length === 0) continue;
    const duration = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 2;
    drafts.push({ start: startMs / 1000, duration, text });
  }
  return drafts;
}

function boundTranscriptDrafts(drafts: TranscriptDraft[], warnings: string[]): MediaVideoTranscriptV1['segments'] {
  const segments: MediaVideoTranscriptV1['segments'] = [];
  let chars = 0;
  for (const draft of drafts) {
    if (segments.length >= MAX_TRANSCRIPT_SEGMENTS) {
      warnings.push(`transcript truncated to ${MAX_TRANSCRIPT_SEGMENTS} segments`);
      break;
    }
    if (chars + draft.text.length > MAX_TRANSCRIPT_CHARS) {
      warnings.push(`transcript truncated to ${MAX_TRANSCRIPT_CHARS} characters`);
      break;
    }
    chars += draft.text.length;
    segments.push(draft);
  }
  return segments;
}

function payloadRows(payload: unknown): unknown[] | undefined {
  if (Array.isArray(payload)) return payload as unknown[];
  if (typeof payload === 'object' && payload !== null) {
    const record = payload as Record<string, unknown>;
    for (const key of ['items', 'videos', 'list', 'data', 'results']) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    return [payload];
  }
  return undefined;
}

function parseBiliDuration(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parts = value.trim().split(':').map(Number);
    if (parts.length > 0 && parts.every((part) => Number.isFinite(part))) {
      return parts.reduce((total, part) => total * 60 + part, 0);
    }
  }
  return undefined;
}

function normalizeBiliVideoRow(item: unknown, warnings: string[]): MediaEntityV1 | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    warnings.push('dropped non-object bilibili row');
    return undefined;
  }
  const row = item as Record<string, unknown>;
  const nativeId = optString(row['bvid']) ?? optString(row['aid']) ?? optString(row['id']) ?? optString(row['video_id']);
  if (nativeId === undefined) {
    warnings.push('dropped bilibili row without id');
    return undefined;
  }
  const title = optString(row['title']);
  const author = optString(row['author']) ?? optString(row['uploader']) ?? optString(row['username']);
  const link = validHttpUrl(optString(row['url']) ?? optString(row['link']));
  const url = link ?? (/^BV[0-9A-Za-z]{10}$/.test(nativeId) ? `https://www.bilibili.com/video/${nativeId}` : BILIBILI_HOME);
  const entity: MediaEntityV1 = {
    version: 1,
    kind: 'video',
    id: mediaEntityId('bilibili', 'video', nativeId),
    channel: 'bilibili',
    backend: 'bili-cli',
    url,
    ...(title !== undefined ? { title } : {}),
    ...(parseMediaDate(row['publishedAt'] ?? row['pubdate'] ?? row['created']) !== undefined
      ? { publishedAt: parseMediaDate(row['publishedAt'] ?? row['pubdate'] ?? row['created']) as string }
      : {}),
    ...(optString(row['description'] ?? row['desc']) !== undefined
      ? { description: optString(row['description'] ?? row['desc']) as string }
      : {}),
    ...(parseBiliDuration(row['duration'] ?? row['length']) !== undefined
      ? { durationSeconds: parseBiliDuration(row['duration'] ?? row['length']) as number }
      : {}),
    ...(optNumber(row['viewCount'] ?? row['play'] ?? row['views']) !== undefined
      ? { viewCount: optNumber(row['viewCount'] ?? row['play'] ?? row['views']) as number }
      : {}),
    ...(author !== undefined ? { author: { name: author } } : {}),
    ...(validHttpUrl(optString(row['pic'] ?? row['thumbnail'] ?? row['cover'])) !== undefined
      ? { thumbnailUrl: validHttpUrl(optString(row['pic'] ?? row['thumbnail'] ?? row['cover'])) as string }
      : {}),
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    warnings.push(`dropped invalid bilibili row: ${check.issues.join('; ')}`);
    return undefined;
  }
  return entity;
}

function extractBiliId(request: MediaRequest): string | undefined {
  if (request.id !== undefined) return request.id;
  if (request.url === undefined) return undefined;
  const match = /\/(?:video|BV)(BV[0-9A-Za-z]{10}|av\d+)/.exec(request.url);
  return match?.[1];
}

function normalizeTranscriptPayload(
  channel: MediaChannel,
  backend: string,
  videoId: string,
  payload: unknown,
  warnings: string[],
): MediaVideoTranscriptV1 {
  const rows = payloadRows(payload);
  if (rows === undefined) {
    throw new SocialError('malformed_upstream', `${backend}: transcript payload has no usable rows`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  // Accept plain segment rows or JSON3 event rows.
  const drafts = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (typeof record['text'] === 'string') {
      const start = Number(record['start']);
      const duration = Number(record['duration']);
      const text = decodeCaptionText(record['text']);
      if (!Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration <= 0 || text.length === 0) return [];
      return [{ start, duration, text }];
    }
    return draftFromJson3({ events: [row] });
  });
  if (rows.length > 0 && drafts.length === 0) {
    throw new SocialError('malformed_upstream', `${backend}: transcript rows have no usable segments`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  const segments = boundTranscriptDrafts(drafts, warnings);
  const entity: MediaVideoTranscriptV1 = {
    version: 1,
    kind: 'video_transcript',
    videoId,
    channel,
    backend,
    segments,
  };
  const check = validateMediaEntity(entity);
  if (!check.ok) {
    throw new SocialError('malformed_upstream', `${backend}: transcript failed validation: ${check.issues.join('; ')}`, {
      platform: mediaPlatform(channel),
      backend,
    });
  }
  return entity;
}

function normalizeYoutube(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  if (plan.backend === 'youtube-oembed') {
    const record = (payload ?? {}) as Record<string, unknown>;
    const data = (record['data'] ?? {}) as Record<string, unknown>;
    const target = typeof record['target'] === 'string' ? (record['target'] as string) : YOUTUBE_HOME;
    const videoId = target.startsWith('https://www.youtube.com/watch?') ? (new URL(target).searchParams.get('v') ?? undefined) : undefined;
    const title = optString(data['title']);
    const author = optString(data['author_name']);
    const authorUrl = validHttpUrl(optString(data['author_url']));
    const thumbnail = validHttpUrl(optString(data['thumbnail_url']));
    const entity: MediaEntityV1 = {
      version: 1,
      kind: 'video',
      id: mediaEntityId('youtube', 'video', videoId ?? target),
      channel: 'youtube',
      backend: plan.backend,
      url: target,
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author: { name: author, ...(authorUrl !== undefined ? { id: authorUrl } : {}) } } : {}),
      ...(thumbnail !== undefined ? { thumbnailUrl: thumbnail } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      throw new SocialError('malformed_upstream', `youtube-oembed payload failed validation: ${check.issues.join('; ')}`, {
        platform: mediaPlatform('youtube'),
        backend: plan.backend,
      });
    }
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: false,
      warnings,
    };
  }
  if (plan.backend === YOUTUBE_TRANSCRIPT_BACKEND) {
    const record = (payload ?? {}) as Record<string, unknown>;
    const videoId = typeof record['videoId'] === 'string' && (record['videoId'] as string).length > 0 ? (record['videoId'] as string) : 'unknown';
    const drafts = Array.isArray(record['drafts']) ? (record['drafts'] as TranscriptDraft[]) : [];
    const segments = boundTranscriptDrafts(drafts, warnings);
    const language = typeof record['language'] === 'string' ? (record['language'] as string) : undefined;
    const entity: MediaVideoTranscriptV1 = {
      version: 1,
      kind: 'video_transcript',
      videoId,
      channel: 'youtube',
      backend: plan.backend,
      segments,
      ...(language !== undefined ? { language } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      throw new SocialError('malformed_upstream', `youtube transcript failed validation: ${check.issues.join('; ')}`, {
        platform: mediaPlatform('youtube'),
        backend: plan.backend,
      });
    }
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: warnings.length > 0,
      warnings,
    };
  }
  // youtube-data-api: search/hot/details rows plus pageToken pagination.
  const record = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(record['items']) ? (record['items'] as unknown[]) : [];
  const nextPageToken = typeof record['nextPageToken'] === 'string' ? (record['nextPageToken'] as string) : undefined;
  const entities: MediaEntityV1[] = [];
  for (const item of items) {
    const entity = request.action === 'search'
      ? normalizeYoutubeSearchRow(item, warnings)
      : normalizeYoutubeVideoRow(item, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return youtubePage(request, plan.backend, entities, warnings, nextPageToken);
}

function normalizeBilibili(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  if (plan.backend === 'OpenCLI') {
    const videoId = extractBiliId(request) ?? 'unknown';
    const entity = normalizeTranscriptPayload('bilibili', plan.backend, videoId, payload, warnings);
    return {
      entities: [entity],
      pagination: { supported: false, limit: request.limit, returned: 1, hasMore: false },
      partial: warnings.length > 0,
      warnings,
    };
  }
  const rows = payloadRows(payload);
  if (rows === undefined) {
    throw new SocialError('malformed_upstream', 'bili-cli payload has no usable rows', {
      platform: mediaPlatform(request.channel),
      backend: plan.backend,
    });
  }
  const entities: MediaEntityV1[] = [];
  const capped = rows.slice(0, request.limit);
  if (rows.length > capped.length) warnings.push(`bilibili rows truncated to limit ${request.limit}`);
  for (const row of capped) {
    const entity = normalizeBiliVideoRow(row, warnings);
    if (entity !== undefined) entities.push(entity);
  }
  return {
    entities,
    pagination: { supported: false, limit: request.limit, returned: entities.length, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  };
}

function normalizeRss(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  const warnings: string[] = [];
  const record = (payload ?? {}) as Record<string, unknown>;
  const feedUrl = typeof record['feedUrl'] === 'string' ? (record['feedUrl'] as string) : '';
  const items = Array.isArray(record['items']) ? (record['items'] as Array<{ title: string; url: string; summary?: string }>) : [];
  const entities: MediaEntityV1[] = [];
  for (const [index, item] of items.entries()) {
    const url = validHttpUrl(item.url) ?? (feedUrl ? feedUrl : undefined);
    if (url === undefined) {
      warnings.push(`dropped feed entry ${index} without url`);
      continue;
    }
    const title = typeof item.title === 'string' ? item.title : '';
    const snippet = typeof item.summary === 'string' && item.summary.length > 0 ? item.summary : undefined;
    const entity: MediaEntityV1 = {
      version: 1,
      kind: 'feed_entry',
      id: mediaEntityId('rss', 'feed_entry', item.url || title || `entry-${index}`),
      channel: 'rss',
      backend: plan.backend,
      url,
      ...(title.length > 0 ? { title } : {}),
      ...(snippet !== undefined ? { snippet } : {}),
    };
    const check = validateMediaEntity(entity);
    if (!check.ok) {
      warnings.push(`dropped invalid feed entry ${index}: ${check.issues.join('; ')}`);
      continue;
    }
    entities.push(entity);
  }
  return {
    entities,
    pagination: { supported: false, limit: request.limit, returned: entities.length, hasMore: false },
    partial: warnings.length > 0,
    warnings,
  };
}

export function normalizeMediaPage(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1 {
  switch (request.channel) {
    case 'youtube':
      return normalizeYoutube(request, plan, payload);
    case 'bilibili':
      return normalizeBilibili(request, plan, payload);
    case 'rss':
      return normalizeRss(request, plan, payload);
  }
}
