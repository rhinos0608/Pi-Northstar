// Stage 3 media contract: shared media vocabulary, canonical action
// validation, channel-aware selector/limit validation, MediaError (via
// SocialError), normalized entity types, the MediaBackendPlan seam, and
// opaque cursor helpers.
//
// This module owns vocabulary and validation only. Backend selection lives in
// the central media integrator. Canonical capability data stays in the
// capability registry (src/capabilities.ts); media channels mirror it exactly:
// youtube (search/details/hot/transcript), bilibili
// (search/details/transcript/hot), rss (feed).
//
// Canonical-only contract: no legacy aliases exist. Unknown action names
// (including legacy 'video' and 'subtitle' spellings) are rejected with
// unsupported_action before any backend dispatch — no pass-through (contrast
// with the permissive canonicalActionFor in src/reach-tools.ts).
//
// Dependency-light by design: node:crypto plus the shared contract and CLI
// safety primitive only. No child_process, no fetch.

import { createHash } from 'node:crypto';
import { SocialError, type SocialPlatform } from '../social/social-contract.js';
import { requireCliPositional } from '../social/social-cli-safety.js';

// ── Core vocabulary ──

export const MEDIA_CHANNELS = ['youtube', 'bilibili', 'rss'] as const;

export type MediaChannel = (typeof MEDIA_CHANNELS)[number];

export const MEDIA_ACTIONS = ['search', 'details', 'hot', 'transcript', 'feed'] as const;

export type MediaAction = (typeof MEDIA_ACTIONS)[number];

export type MediaAuthTier = 'cookie' | 'anonymous' | 'api_key';

export type MediaPaginationMode = 'cursor' | 'page' | 'unsupported';

export type MediaBackendQuality = 'full' | 'degraded';

export type MediaEntityKind = 'video' | 'feed_entry' | 'video_transcript';

export const MEDIA_ENTITY_KINDS: ReadonlySet<string> = new Set([
  'video',
  'feed_entry',
  'video_transcript',
]);

export function isMediaChannel(value: unknown): value is MediaChannel {
  return typeof value === 'string' && (MEDIA_CHANNELS as readonly string[]).includes(value);
}

export function isMediaAction(value: unknown): value is MediaAction {
  return typeof value === 'string' && (MEDIA_ACTIONS as readonly string[]).includes(value);
}

function isMediaEntityKind(value: unknown): value is MediaEntityKind {
  return typeof value === 'string' && MEDIA_ENTITY_KINDS.has(value);
}

// ── Advertised canonical actions per channel ──
// Mirrors src/capabilities.ts media channels exactly. Single source of truth
// for what each channel accepts; never maintain a duplicate list elsewhere.

export const MEDIA_CANONICAL_ACTIONS: Readonly<Record<MediaChannel, readonly MediaAction[]>> = {
  youtube: ['search', 'details', 'hot', 'transcript'],
  bilibili: ['search', 'details', 'transcript', 'hot'],
  rss: ['feed'],
};

export function mediaCanonicalActions(channel: MediaChannel): readonly MediaAction[] {
  return MEDIA_CANONICAL_ACTIONS[channel];
}

export function isAdvertisedMediaAction(channel: MediaChannel, action: MediaAction): boolean {
  return MEDIA_CANONICAL_ACTIONS[channel].includes(action);
}

function mediaError(
  code: 'invalid_request' | 'unsupported_action' | 'cursor_invalid' | 'cursor_mismatch',
  message: string,
  options?: { channel?: MediaChannel; backend?: string },
): SocialError {
  return new SocialError(code, message, {
    // SocialError is platform-generic ({platform, backend, cause}); the media
    // channel rides in the platform slot so callers keep one error class.
    ...(options?.channel !== undefined
      ? { platform: options.channel as unknown as SocialPlatform }
      : {}),
    ...(options?.backend !== undefined ? { backend: options.backend } : {}),
  });
}

/**
 * Validate that `action` is an advertised canonical action for the channel.
 * Unknown or legacy spellings ('video', 'subtitle', ...) throw
 * unsupported_action — no alias mapping, no pass-through. Throws before any
 * backend dispatch.
 */
export function resolveMediaAction(channel: MediaChannel, action: string): MediaAction {
  if (!isMediaAction(action) || !MEDIA_CANONICAL_ACTIONS[channel].includes(action)) {
    throw mediaError('unsupported_action', `Unsupported ${channel} action: ${String(action).slice(0, 32)}`, { channel });
  }
  return action;
}

// ── Selector / limit validation ──

export type MediaSelectorField = 'query' | 'id' | 'url';

export interface MediaActionSelectorSpec {
  /** Every listed selector must be present. */
  required?: readonly MediaSelectorField[];
  /** At least one listed selector must be present. */
  anyOf?: readonly MediaSelectorField[];
  /** Per-action limit cap; defaults to MEDIA_MAX_LIMIT. */
  maxLimit?: number;
}

// Channel-aware selector requirements. Every advertised action has an entry
// (possibly empty for self-scoped listings like hot).
const MEDIA_ACTION_SELECTORS: Readonly<
  Record<MediaChannel, Readonly<Partial<Record<MediaAction, MediaActionSelectorSpec>>>>
> = {
  youtube: {
    search: { required: ['query'], maxLimit: 50 },
    details: { anyOf: ['id', 'url'], maxLimit: 50 },
    transcript: { anyOf: ['id', 'url'], maxLimit: 50 },
    hot: { maxLimit: 50 },
  },
  bilibili: {
    search: { required: ['query'] },
    details: { anyOf: ['id', 'url'] },
    transcript: { anyOf: ['id', 'url'] },
    hot: {},
  },
  rss: {
    feed: { required: ['url'], maxLimit: 50 },
  },
};

export function mediaSelectorSpecFor(channel: MediaChannel, action: MediaAction): MediaActionSelectorSpec {
  return MEDIA_ACTION_SELECTORS[channel][action] ?? {};
}

export const DEFAULT_MEDIA_LIMIT = 20;
export const MEDIA_MAX_LIMIT = 25;
export const MEDIA_YOUTUBE_MAX_LIMIT = 50;
export const MEDIA_RSS_MAX_LIMIT = 50;
export const MAX_MEDIA_QUERY_LENGTH = 200;
export const MAX_MEDIA_ID_LENGTH = 64;

/** Validate and bound a request limit. Clamps above the cap with a warning. */
export function resolveMediaLimit(
  raw: unknown,
  maxLimit: number = MEDIA_MAX_LIMIT,
): { limit: number; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { limit: DEFAULT_MEDIA_LIMIT, warnings };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw mediaError('invalid_request', 'limit must be a positive integer');
  }
  if (raw > maxLimit) {
    warnings.push(`limit clamped to ${maxLimit}`);
    return { limit: maxLimit, warnings };
  }
  return { limit: raw, warnings };
}

export interface MediaRequestInput {
  channel: string;
  action: string;
  query?: string;
  id?: string;
  url?: string;
  limit?: number;
}

export interface MediaRequest {
  channel: MediaChannel;
  action: MediaAction;
  query?: string;
  id?: string;
  url?: string;
  limit: number;
  cursor?: string;
}

function cleanSelector(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse and validate a raw media request: resolve the channel and canonical
 * action, enforce channel-aware selector requirements and length caps, apply
 * requireCliPositional to every positional-bound selector (query/id) so
 * option-shaped values are rejected before any CLI argv exists, and bound the
 * limit. Rejection errors never echo the rejected value. Throws SocialError
 * before any backend dispatch.
 */
export function validateMediaRequest(input: MediaRequestInput): {
  request: MediaRequest;
  warnings: string[];
} {
  const warnings: string[] = [];

  if (!isMediaChannel(input.channel)) {
    throw mediaError('invalid_request', `Unsupported media channel: ${String(input.channel).slice(0, 32)}`);
  }
  const channel: MediaChannel = input.channel;
  const action = resolveMediaAction(channel, input.action);

  // Positional-bound selectors pass through requireCliPositional: blank or
  // option-shaped values throw invalid_request without echoing the value.
  const selectors: Partial<Record<MediaSelectorField, string>> = {};
  const query = cleanSelector(input.query);
  if (typeof input.query === 'string' && query === undefined) {
    throw mediaError('invalid_request', `${channel} query must be a non-empty string when provided`, {
      channel,
    });
  }
  if (query !== undefined) {
    if (query.length > MAX_MEDIA_QUERY_LENGTH) {
      throw mediaError(
        'invalid_request',
        `${channel} query exceeds maximum length of ${MAX_MEDIA_QUERY_LENGTH}`,
        { channel },
      );
    }
    selectors.query = requireCliPositional(query, 'query', channel as unknown as SocialPlatform);
  }

  const id = cleanSelector(input.id);
  if (typeof input.id === 'string' && id === undefined) {
    throw mediaError('invalid_request', `${channel} id must be a non-empty string when provided`, {
      channel,
    });
  }
  if (id !== undefined) {
    if (id.length > MAX_MEDIA_ID_LENGTH) {
      throw mediaError('invalid_request', `${channel} id exceeds maximum length of ${MAX_MEDIA_ID_LENGTH}`, {
        channel,
      });
    }
    selectors.id = requireCliPositional(id, 'id', channel as unknown as SocialPlatform);
  }

  const url = cleanSelector(input.url);
  if (typeof input.url === 'string' && url === undefined) {
    throw mediaError('invalid_request', `${channel} url must be a non-empty string when provided`, {
      channel,
    });
  }
  if (url !== undefined) selectors.url = url;

  const spec = MEDIA_ACTION_SELECTORS[channel][action] ?? {};
  const missingRequired = (spec.required ?? []).filter((field) => selectors[field] === undefined);
  if (missingRequired.length > 0) {
    throw mediaError('invalid_request', `${channel} ${action} requires selector: ${missingRequired.join(', ')}`, {
      channel,
    });
  }
  if (spec.anyOf !== undefined && !spec.anyOf.some((field) => selectors[field] !== undefined)) {
    throw mediaError(
      'invalid_request',
      `${channel} ${action} requires one of: ${spec.anyOf.join(', ')}`,
      { channel },
    );
  }

  const maxLimit = spec.maxLimit ?? MEDIA_MAX_LIMIT;
  const { limit, warnings: limitWarnings } = resolveMediaLimit(input.limit, maxLimit);
  warnings.push(...limitWarnings);

  const request: MediaRequest = { channel, action, limit };
  if (selectors.query !== undefined) request.query = selectors.query;
  if (selectors.id !== undefined) request.id = selectors.id;
  if (selectors.url !== undefined) request.url = selectors.url;
  return { request, warnings };
}

// ── Normalized entities ──
// Only fields present upstream are set. Never synthesize metrics, dates, or
// identifiers. No raw backend_text on media paths: backend_text payloads are
// rejected as unknown-shape.

export interface MediaEntityBaseV1 {
  version: 1;
  kind: MediaEntityKind;
  id: string;
  channel: MediaChannel;
  backend: string;
  url?: string;
  title?: string;
  publishedAt?: string;
}

export interface MediaVideoV1 extends MediaEntityBaseV1 {
  kind: 'video';
  description?: string;
  durationSeconds?: number;
  viewCount?: number;
  author?: { id?: string; name?: string };
  thumbnailUrl?: string;
}

export interface MediaFeedEntryV1 extends MediaEntityBaseV1 {
  kind: 'feed_entry';
  snippet?: string;
  author?: { id?: string; name?: string };
}

export interface MediaTranscriptSegmentV1 {
  start: number;
  duration: number;
  text: string;
}

export interface MediaVideoTranscriptV1 {
  version: 1;
  kind: 'video_transcript';
  videoId: string;
  channel: MediaChannel;
  backend: string;
  segments: MediaTranscriptSegmentV1[];
  language?: string;
}

export type MediaEntityV1 = MediaVideoV1 | MediaFeedEntryV1 | MediaVideoTranscriptV1;

/** Namespaced entity id: channel/kind/native ID. */
export function mediaEntityId(channel: MediaChannel, kind: MediaEntityKind, nativeId: string): string {
  return `${channel}:${kind}:${nativeId}`;
}

/** ISO 8601 timestamp or undefined. Invalid dates are omitted by callers. */
export function parseMediaDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = Math.abs(value) >= 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateMediaAuthor(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push('author must be an object');
    return;
  }
  const author = value as Record<string, unknown>;
  for (const key of Object.keys(author)) {
    if (key !== 'id' && key !== 'name') issues.push(`author.${key} is not a known field`);
  }
  if (author.id !== undefined && typeof author.id !== 'string') issues.push('author.id must be a string');
  if (author.name !== undefined && typeof author.name !== 'string') issues.push('author.name must be a string');
}

function validateMediaSegments(value: unknown, issues: string[]): void {
  if (!Array.isArray(value)) {
    issues.push('segments must be an array');
    return;
  }
  for (const [index, segment] of value.entries()) {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) {
      issues.push(`segments[${index}] must be an object`);
      continue;
    }
    const row = segment as Record<string, unknown>;
    for (const key of Object.keys(row)) {
      if (key !== 'start' && key !== 'duration' && key !== 'text') {
        issues.push(`segments[${index}].${key} is not a known field`);
      }
    }
    if (typeof row.start !== 'number' || !Number.isFinite(row.start) || row.start < 0) {
      issues.push(`segments[${index}].start must be a finite number >= 0`);
    }
    if (typeof row.duration !== 'number' || !Number.isFinite(row.duration) || row.duration <= 0) {
      issues.push(`segments[${index}].duration must be a finite number > 0`);
    }
    if (typeof row.text !== 'string' || row.text.trim().length === 0) {
      issues.push(`segments[${index}].text is required`);
    }
  }
}

const MEDIA_VIDEO_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'id',
  'channel',
  'backend',
  'url',
  'title',
  'publishedAt',
  'description',
  'durationSeconds',
  'viewCount',
  'author',
  'thumbnailUrl',
]);

const MEDIA_FEED_ENTRY_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'id',
  'channel',
  'backend',
  'url',
  'title',
  'publishedAt',
  'snippet',
  'author',
]);

const MEDIA_TRANSCRIPT_FIELDS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'videoId',
  'channel',
  'backend',
  'segments',
  'language',
]);

export function validateMediaEntity(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['entity is not an object'] };
  }
  const entity = value as Record<string, unknown>;
  const kind = entity.kind;
  if (!isMediaEntityKind(kind)) {
    return { ok: false, issues: ['kind is not a valid media entity kind'] };
  }
  if (entity.version !== 1) issues.push('version must be 1');
  if (entity.backend_text !== undefined || entity.backendText !== undefined) {
    issues.push('backend_text is not allowed on media paths');
  }
  if (!isMediaChannel(entity.channel)) issues.push('channel is not a valid media channel');
  if (typeof entity.backend !== 'string' || entity.backend.trim().length === 0) {
    issues.push('backend is required');
  }

  if (kind === 'video_transcript') {
    if (typeof entity.videoId !== 'string' || entity.videoId.trim().length === 0) {
      issues.push('videoId is required');
    }
    if (entity.language !== undefined && typeof entity.language !== 'string') {
      issues.push('language must be a string');
    }
    validateMediaSegments(entity.segments, issues);
    for (const key of Object.keys(entity)) {
      if (!MEDIA_TRANSCRIPT_FIELDS.has(key)) issues.push(`${key} is not a known field for kind video_transcript`);
    }
    return { ok: issues.length === 0, issues };
  }

  if (typeof entity.id !== 'string' || entity.id.trim().length === 0) issues.push('id is required');
  if (entity.url !== undefined && (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url))) {
    issues.push('url is not a valid http(s) URL');
  }
  if (entity.title !== undefined && typeof entity.title !== 'string') issues.push('title must be a string');
  if (entity.publishedAt !== undefined && parseMediaDate(entity.publishedAt) === undefined) {
    issues.push('publishedAt is not a valid date');
  }

  if (kind === 'video') {
    for (const key of Object.keys(entity)) {
      if (!MEDIA_VIDEO_FIELDS.has(key)) issues.push(`${key} is not a known field for kind video`);
    }
    if (entity.description !== undefined && typeof entity.description !== 'string') {
      issues.push('description must be a string');
    }
    if (
      entity.durationSeconds !== undefined &&
      (typeof entity.durationSeconds !== 'number' ||
        !Number.isFinite(entity.durationSeconds) ||
        entity.durationSeconds < 0)
    ) {
      issues.push('durationSeconds must be a finite number >= 0');
    }
    if (
      entity.viewCount !== undefined &&
      (typeof entity.viewCount !== 'number' || !Number.isFinite(entity.viewCount))
    ) {
      issues.push('viewCount must be a finite number');
    }
    if (
      entity.thumbnailUrl !== undefined &&
      (typeof entity.thumbnailUrl !== 'string' || !isValidHttpUrl(entity.thumbnailUrl))
    ) {
      issues.push('thumbnailUrl is not a valid http(s) URL');
    }
    validateMediaAuthor(entity.author, issues);
  } else {
    for (const key of Object.keys(entity)) {
      if (!MEDIA_FEED_ENTRY_FIELDS.has(key)) issues.push(`${key} is not a known field for kind feed_entry`);
    }
    if (entity.snippet !== undefined && typeof entity.snippet !== 'string') {
      issues.push('snippet must be a string');
    }
    validateMediaAuthor(entity.author, issues);
  }

  return { ok: issues.length === 0, issues };
}

export interface MediaPageV1 {
  entities: MediaEntityV1[];
  pagination: {
    supported: boolean;
    limit: number;
    returned: number;
    hasMore: boolean;
    nextCursor?: string;
  };
  partial: boolean;
  warnings: string[];
}

export function validateMediaPage(value: unknown): { ok: boolean; issues: string[]; page?: MediaPageV1 } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['page is not an object'] };
  }
  const page = value as Record<string, unknown>;
  for (const key of Object.keys(page)) {
    if (key !== 'entities' && key !== 'pagination' && key !== 'partial' && key !== 'warnings') {
      issues.push(`${key} is not a known page field`);
    }
  }
  if (page.backend_text !== undefined || (page as Record<string, unknown>).backendText !== undefined) {
    issues.push('backend_text is not allowed on media paths');
  }

  if (!Array.isArray(page.entities)) {
    issues.push('entities must be an array');
  } else {
    for (const [index, entity] of page.entities.entries()) {
      const check = validateMediaEntity(entity);
      if (!check.ok) issues.push(`entities[${index}]: ${check.issues.join('; ')}`);
    }
  }
  if (typeof page.partial !== 'boolean') issues.push('partial must be a boolean');
  if (!Array.isArray(page.warnings) || page.warnings.some((warning) => typeof warning !== 'string')) {
    issues.push('warnings must be an array of strings');
  }

  if (typeof page.pagination !== 'object' || page.pagination === null || Array.isArray(page.pagination)) {
    issues.push('pagination must be an object');
  } else {
    const pagination = page.pagination as Record<string, unknown>;
    if (typeof pagination.supported !== 'boolean') issues.push('pagination.supported must be a boolean');
    if (typeof pagination.hasMore !== 'boolean') issues.push('pagination.hasMore must be a boolean');
    if (typeof pagination.limit !== 'number' || !Number.isFinite(pagination.limit)) {
      issues.push('pagination.limit must be a finite number');
    }
    if (typeof pagination.returned !== 'number' || !Number.isFinite(pagination.returned)) {
      issues.push('pagination.returned must be a finite number');
    }
    if (Array.isArray(page.entities) && pagination.returned !== page.entities.length) {
      issues.push('pagination.returned must equal entities.length');
    }
    if (pagination.hasMore === true) {
      if (pagination.supported !== true) issues.push('hasMore true requires pagination.supported true');
      if (typeof pagination.nextCursor !== 'string' || pagination.nextCursor.length === 0) {
        issues.push('hasMore true requires a nextCursor');
      }
    }
    if (pagination.nextCursor !== undefined && (typeof pagination.nextCursor !== 'string' || pagination.nextCursor.length === 0)) {
      issues.push('nextCursor must be a non-empty string when present');
    }
    if (pagination.nextCursor !== undefined && pagination.hasMore !== true) {
      issues.push('nextCursor present requires hasMore true');
    }
  }

  return issues.length === 0 ? { ok: true, issues, page: page as unknown as MediaPageV1 } : { ok: false, issues };
}

// ── Backend plan seam ──

export interface MediaExecutionContext {
  /** Abort signal propagated to every backend execution. */
  signal?: AbortSignal;
}

export interface MediaBackendPlan {
  backend: string;
  authTier: MediaAuthTier;
  pagination: MediaPaginationMode;
  /** Fallback or limited backend contributing to degraded status. */
  degraded: boolean;
  quality: MediaBackendQuality;
  execute(signal?: AbortSignal): Promise<unknown>;
}

export interface MediaPlatformWorker {
  readonly channels: readonly MediaChannel[];
  plans(request: MediaRequest, context: MediaExecutionContext): Promise<readonly MediaBackendPlan[]>;
  normalize(request: MediaRequest, plan: MediaBackendPlan, payload: unknown): MediaPageV1;
}

/**
 * Backend preference order per channel, mirroring the capability registry
 * (full backends before degraded fallbacks).
 */
export const MEDIA_BACKEND_PREFERENCE: Readonly<Record<MediaChannel, readonly string[]>> = {
  youtube: ['youtube-data-api', 'youtube-oembed'],
  bilibili: ['bili-cli', 'OpenCLI'],
  rss: ['native-rss-atom'],
};

const MEDIA_AUTH_TIER_RANK: Readonly<Record<MediaAuthTier, number>> = {
  cookie: 0,
  anonymous: 1,
  api_key: 2,
};

function mediaPreferenceIndex(channel: MediaChannel, backend: string): number {
  const index = MEDIA_BACKEND_PREFERENCE[channel].indexOf(backend);
  return index >= 0 ? index : MEDIA_BACKEND_PREFERENCE[channel].length;
}

function mediaPaginationRank(pagination: MediaPaginationMode): number {
  return pagination === 'cursor' || pagination === 'page' ? 0 : 1;
}

/**
 * Order backend plans: non-degraded (complete) first, full quality before
 * degraded, cursor/page-capable before unsupported, then auth-tier rank, then
 * channel backend preference. Mirrors orderPlans in src/social.ts.
 */
export function orderMediaPlans(
  channel: MediaChannel,
  plans: readonly MediaBackendPlan[],
): MediaBackendPlan[] {
  return [...plans].sort((a, b) => {
    if (a.degraded !== b.degraded) return a.degraded ? 1 : -1;
    const qualityRank = (quality: MediaBackendQuality): number => (quality === 'full' ? 0 : 1);
    if (qualityRank(a.quality) !== qualityRank(b.quality)) {
      return qualityRank(a.quality) - qualityRank(b.quality);
    }
    const pagination = mediaPaginationRank(a.pagination) - mediaPaginationRank(b.pagination);
    if (pagination !== 0) return pagination;
    const tier = MEDIA_AUTH_TIER_RANK[a.authTier] - MEDIA_AUTH_TIER_RANK[b.authTier];
    if (tier !== 0) return tier;
    return mediaPreferenceIndex(channel, a.backend) - mediaPreferenceIndex(channel, b.backend);
  });
}

// ── Pagination cursors ──
// Opaque base64url JSON bound to channel/action/backend plus a fingerprint of
// the canonical selectors and limit. Cursors carry the upstream pageToken in
// typed state; they never contain keys, cookies, or URLs.

export const MEDIA_MAX_CURSOR_LENGTH = 4096;

export type MediaCursorState = Record<string, string | number | boolean>;

export interface MediaCursorV1 {
  v: 1;
  channel: MediaChannel;
  action: MediaAction;
  backend: string;
  fingerprint: string;
  state: MediaCursorState;
}

export interface DecodedMediaCursor {
  channel: MediaChannel;
  action: MediaAction;
  backend: string;
  state: MediaCursorState;
}

// Credential-shaped substrings forbidden in cursor keys and string values.
const FORBIDDEN_MEDIA_CURSOR_SUBSTRINGS: readonly string[] = [
  'cookie',
  'xsec_token',
  'auth_token',
  'access_token',
  'refresh_token',
  'id_token',
  'authorization',
  'bearer',
  'password',
  'secret',
  'api_key',
  'apikey',
  'ct0',
  'sessdata',
  'http://',
  'https://',
];

function assertMediaCursorSafe(state: MediaCursorState): void {
  for (const [key, value] of Object.entries(state)) {
    if (key.length === 0) {
      throw mediaError('cursor_invalid', 'cursor state keys must be non-empty');
    }
    const haystack = `${key} ${typeof value === 'string' ? value : ''}`.toLowerCase();
    for (const forbidden of FORBIDDEN_MEDIA_CURSOR_SUBSTRINGS) {
      if (haystack.includes(forbidden)) {
        throw mediaError('cursor_invalid', `cursor state contains forbidden material in "${key}"`);
      }
    }
  }
}

export interface MediaCursorFingerprintInput {
  channel: MediaChannel;
  action: MediaAction;
  query?: string;
  id?: string;
  url?: string;
  limit: number;
}

/** SHA-256 fingerprint over canonical selectors and limit. */
export function mediaCursorFingerprint(input: MediaCursorFingerprintInput): string {
  const parts: string[] = [
    input.channel,
    input.action,
    input.query ?? '',
    input.id ?? '',
    input.url ?? '',
    String(input.limit),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export function encodeMediaCursor(input: {
  channel: MediaChannel;
  action: MediaAction;
  backend: string;
  fingerprint: string;
  state: MediaCursorState;
}): string {
  assertMediaCursorSafe(input.state);
  const payload: MediaCursorV1 = {
    v: 1,
    channel: input.channel,
    action: input.action,
    backend: input.backend,
    fingerprint: input.fingerprint,
    state: input.state,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > MEDIA_MAX_CURSOR_LENGTH) {
    throw mediaError('cursor_invalid', `cursor exceeds maximum length of ${MEDIA_MAX_CURSOR_LENGTH}`);
  }
  return encoded;
}

/**
 * Decode and verify a cursor against the current request. Rejects malformed
 * tokens (cursor_invalid) and cursors bound to a different channel, action,
 * backend, or selector fingerprint (cursor_mismatch). A cursor-pinned request
 * must never switch backends.
 */
export function decodeMediaCursor(
  cursor: string,
  expected: { channel: MediaChannel; action: MediaAction; backend: string; fingerprint: string },
): DecodedMediaCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw mediaError('cursor_invalid', 'cursor is required', { channel: expected.channel });
  }
  if (cursor.length > MEDIA_MAX_CURSOR_LENGTH) {
    throw mediaError('cursor_invalid', `cursor exceeds maximum length of ${MEDIA_MAX_CURSOR_LENGTH}`, {
      channel: expected.channel,
    });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw mediaError('cursor_invalid', 'cursor is not a valid opaque token', { channel: expected.channel });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw mediaError('cursor_invalid', 'cursor payload is invalid', { channel: expected.channel });
  }
  const record = payload as Record<string, unknown>;
  if (record.v !== 1) {
    throw mediaError('cursor_invalid', 'cursor payload version must be 1', { channel: expected.channel });
  }
  if (!isMediaChannel(record.channel) || !isMediaAction(record.action)) {
    throw mediaError('cursor_invalid', 'cursor channel/action is invalid', { channel: expected.channel });
  }
  if (
    typeof record.backend !== 'string' ||
    record.backend.length === 0 ||
    typeof record.fingerprint !== 'string' ||
    record.fingerprint.length === 0
  ) {
    throw mediaError('cursor_invalid', 'cursor backend/fingerprint is invalid', { channel: expected.channel });
  }
  if (!isMediaCursorState(record.state)) {
    throw mediaError('cursor_invalid', 'cursor state contains non-scalar values', { channel: expected.channel });
  }
  const state = record.state;
  assertMediaCursorSafe(state);
  if (
    record.channel !== expected.channel ||
    record.action !== expected.action ||
    record.backend !== expected.backend ||
    record.fingerprint !== expected.fingerprint
  ) {
    throw mediaError(
      'cursor_mismatch',
      `cursor was issued for ${String(record.channel)}/${String(record.action)}/${String(record.backend)}, not ${expected.channel}/${expected.action}/${expected.backend}`,
      { channel: expected.channel, backend: expected.backend },
    );
  }
  return { channel: record.channel, action: record.action, backend: record.backend, state };
}

function isMediaCursorState(value: unknown): value is MediaCursorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
}
