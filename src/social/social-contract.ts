// Stage 2 social contract facade: request validation, canonical URL/ID
// extraction, cursor encoding/validation, and the SocialPlatformWorker seam.
// Shared vocabulary and SocialError live in social-core; normalized entity
// types, envelope validators, and rendering live in social-entity-contract.
// This module re-exports both so existing importers keep one entry point.
//
// This module owns validation only. Platform command/endpoint mappings live
// in the per-platform workers; global backend selection lives in the central
// integrator (src/social.ts). Canonical capability data stays in the
// capability registry (src/capabilities.ts); the BackendCapability types here
// are the shape that registry and workers must satisfy.
//
// Canonical-only contract: no legacy aliases exist. Unknown action names are
// rejected with unsupported_action before any backend dispatch. Instagram has
// no post-detail action until a verified read-only adapter exists.

import { createHash } from 'node:crypto';
import {
  SocialError,
  isSocialAction,
  isSocialPlatform,
  resolveSocialAction,
  type SocialAction,
  type SocialAuthTier,
  type SocialPaginationMode,
  type SocialPlatform,
} from './social-core.js';
import type { SocialPageV1 } from './social-entity-contract.js';

export {
  SOCIAL_ACTIONS,
  SOCIAL_CANONICAL_ACTIONS,
  SOCIAL_ENTITY_KINDS,
  SOCIAL_PLATFORMS,
  SocialError,
  canonicalActionsFor,
  isAdvertisedAction,
  isSocialAction,
  isSocialPlatform,
  resolveSocialAction,
} from './social-core.js';
export type {
  SocialAction,
  SocialAuthTier,
  SocialEntityKind,
  SocialErrorCode,
  SocialPaginationMode,
  SocialPlatform,
} from './social-core.js';
export {
  parseSocialDate,
  renderSocialEntity,
  renderSocialPage,
  socialEntityId,
  validateSocialEntity,
  validateSocialPage,
} from './social-entity-contract.js';
export type {
  SocialAccountV1,
  SocialActorV1,
  SocialCommentV1,
  SocialCommunityV1,
  SocialEngagementV1,
  SocialEntityBaseV1,
  SocialEntityV1,
  SocialMediaItemV1,
  SocialMediaV1,
  SocialMetricsV1,
  SocialNotificationV1,
  SocialPageV1,
  SocialPostV1,
  SocialReferenceV1,
  SocialRelationshipV1,
  SocialThreadV1,
  SocialTopicV1,
} from './social-entity-contract.js';

// // NOTE: core vocabulary, the canonical action registry, and SocialError
// moved to social-core.js and re-exported above.

// ── Selector / limit validation ──

export type SocialSelectorField = 'query' | 'postId' | 'commentId' | 'user' | 'community' | 'topic';

export interface SocialActionSelectorSpec {
  /** Every listed selector must be present (directly or via URL extraction). */
  required?: readonly SocialSelectorField[];
  /** At least one listed selector must be present (directly or via URL extraction). */
  anyOf?: readonly SocialSelectorField[];
  /** Per-action limit cap; defaults to SOCIAL_MAX_LIMIT. */
  maxLimit?: number;
}

// Platform-aware selector requirements. Every advertised action has an entry
// (possibly empty for self-scoped listings like feed/saved/notifications).
// `anyOf: ['postId']` means postId directly, or any URL that extracts one.
const SOCIAL_ACTION_SELECTORS: Readonly<Record<SocialPlatform, Readonly<Partial<Record<SocialAction, SocialActionSelectorSpec>>>>> = {
  twitter: {
    search: { required: ['query'] },
    get_post: { anyOf: ['postId'] },
    get_thread: { anyOf: ['postId'] },
    get_comments: { anyOf: ['postId'] },
    get_comment_replies: { required: ['commentId'] },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_followers: { required: ['user'] },
    get_following: { required: ['user'] },
    get_feed: {},
    get_trending: {},
    get_saved: {},
    get_notifications: {},
  },
  reddit: {
    search: { required: ['query'] },
    get_post: { anyOf: ['postId'] },
    get_thread: { anyOf: ['postId'] },
    get_comments: { anyOf: ['postId'] },
    get_comment_replies: { required: ['commentId'] },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_user_comments: { required: ['user'] },
    get_feed: {},
    get_trending: {},
    get_saved: {},
    get_community: { required: ['community'] },
    get_community_posts: { required: ['community'] },
  },
  xiaohongshu: {
    search: { required: ['query'] },
    get_post: { anyOf: ['postId'] },
    get_comments: { anyOf: ['postId'], maxLimit: 50 },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_followers: { required: ['user'] },
    get_following: { required: ['user'] },
    get_feed: {},
    get_saved: {},
    get_notifications: {},
  },
  facebook: {
    search: { required: ['query'] },
    get_profile: { required: ['user'] },
    get_feed: {},
    get_notifications: {},
    get_community: { required: ['community'] },
  },
  instagram: {
    search: { required: ['query'] },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_followers: { required: ['user'] },
    get_following: { required: ['user'] },
    get_trending: {},
    get_saved: {},
  },
  v2ex: {
    get_topic: { required: ['topic'] },
    get_thread: { anyOf: ['postId'] },
    get_comments: { anyOf: ['postId'] },
    get_profile: { required: ['user'] },
    get_trending: {},
    get_community: { required: ['community'] },
    get_community_posts: { required: ['community'] },
    get_notifications: {},
  },
  linkedin: {
    search: { required: ['query'], maxLimit: 10 },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_feed: {},
  },
};

export function selectorSpecFor(platform: SocialPlatform, action: SocialAction): SocialActionSelectorSpec {
  return SOCIAL_ACTION_SELECTORS[platform][action] ?? {};
}

// ── Per-action auxiliary-field contract ──
// Only fields listed here for a platform/action are honored. Closed string
// lists are the intersection every backend path supports, so a validated
// value can never be silently dropped downstream. `timeRange: 'date'` pins
// YYYY-MM-DD; `timeRange: true` accepts any non-empty string the backends
// forward verbatim. Actions without an entry honor no aux fields.
export interface SocialAuxSpec {
  sort?: readonly string[];
  timeRange?: true | 'date';
  feedVariant?: readonly string[];
  includeReplies?: true;
}

const SOCIAL_AUX_SPECS: Readonly<Record<SocialPlatform, Readonly<Partial<Record<SocialAction, SocialAuxSpec>>>>> = {
  twitter: {
    search: { sort: ['top', 'latest'], timeRange: 'date' },
    get_feed: { feedVariant: ['for-you', 'following'] },
  },
  reddit: {
    search: { sort: ['relevance', 'hot', 'top', 'new', 'comments'], timeRange: true },
    get_thread: { includeReplies: true },
    get_comments: { includeReplies: true },
    get_feed: { feedVariant: ['popular', 'all'] },
    get_trending: { feedVariant: ['hot'] },
    get_community_posts: { sort: ['hot', 'new', 'top', 'rising'] },
  },
  xiaohongshu: {
    get_comments: { includeReplies: true },
    get_notifications: { feedVariant: ['mentions', 'likes', 'connections'] },
  },
  facebook: {},
  instagram: {},
  v2ex: {},
  linkedin: {},
};

export function auxSpecFor(platform: SocialPlatform, action: SocialAction): SocialAuxSpec {
  return SOCIAL_AUX_SPECS[platform][action] ?? {};
}

export const SOCIAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateAuxField(
  platform: SocialPlatform,
  action: SocialAction,
  spec: SocialAuxSpec,
  field: 'sort' | 'timeRange' | 'feedVariant',
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  const allowed = spec[field];
  if (allowed === undefined) {
    throw new SocialError('invalid_request', `${platform} ${action} does not support ${field}`);
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new SocialError('invalid_request', `${field} must be a non-empty string when provided`);
  }
  if (Array.isArray(allowed)) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new SocialError(
        'invalid_request',
        `${platform} ${action} invalid ${field} "${String(value).slice(0, 32)}", expected one of: ${(allowed as readonly string[]).join(', ')}`,
      );
    }
  } else if (allowed === 'date' && !SOCIAL_DATE_RE.test(value)) {
    throw new SocialError('invalid_request', `${field} must match YYYY-MM-DD, got "${String(value).slice(0, 32)}"`);
  }
  return value;
}

export const DEFAULT_SOCIAL_LIMIT = 20;
export const SOCIAL_MAX_LIMIT = 100;
export const MAX_SELECTOR_LENGTH = 1024;

/** Validate and bound a request limit. Rejects out-of-range limits instead of clamping. */
export function resolveSocialLimit(raw: unknown, maxLimit: number = SOCIAL_MAX_LIMIT): { limit: number; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) {
    return { limit: Math.min(DEFAULT_SOCIAL_LIMIT, maxLimit), warnings };
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > maxLimit) {
    throw new SocialError('invalid_request', `limit must be an integer 1..${maxLimit}`);
  }
  return { limit: raw, warnings };
}

export interface SocialRequestInput {
  platform: string;
  action: string;
  query?: string;
  postId?: string;
  commentId?: string;
  user?: string;
  community?: string;
  topic?: string;
  url?: string;
  feedVariant?: string;
  sort?: string;
  timeRange?: string;
  includeReplies?: boolean;
  limit?: number;
}

export interface SocialRequest {
  platform: SocialPlatform;
  action: SocialAction;
  query?: string;
  postId?: string;
  commentId?: string;
  user?: string;
  community?: string;
  topic?: string;
  url?: string;
  feedVariant?: string;
  sort?: string;
  timeRange?: string;
  includeReplies?: boolean;
  limit: number;
  cursor?: string;
}

const SELECTOR_FIELDS: readonly SocialSelectorField[] = ['query', 'postId', 'commentId', 'user', 'community', 'topic'];

function cleanSelector(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Parse and validate a raw social request: resolve platform and canonical
 * action, enforce platform-aware selector requirements, extract selectors
 * from a verified platform URL when provided, and bound the limit. Throws
 * SocialError before any backend dispatch.
 */
const SOCIAL_REQUEST_INPUT_FIELDS: ReadonlySet<string> = new Set([
  'platform', 'action', 'query', 'postId', 'commentId', 'user', 'community',
  'topic', 'url', 'feedVariant', 'sort', 'timeRange', 'includeReplies', 'limit',
]);

export function validateSocialRequest(input: SocialRequestInput): { request: SocialRequest; warnings: string[] } {
  const warnings: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SocialError('invalid_request', 'request must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!SOCIAL_REQUEST_INPUT_FIELDS.has(key)) {
      throw new SocialError('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }

  const rawInput = input as SocialRequestInput;
  if (!isSocialPlatform(rawInput.platform)) {
    throw new SocialError('invalid_request', `Unsupported platform: ${String(rawInput.platform).slice(0, 32)}`);
  }
  const platform: SocialPlatform = rawInput.platform;
  const action = resolveSocialAction(platform, input.action);
  const spec = SOCIAL_ACTION_SELECTORS[platform][action] ?? {};
  const allowedDirectSelectors = new Set<SocialSelectorField>([
    ...(spec.required ?? []),
    ...(spec.anyOf ?? []),
  ]);

  // Selectors: explicit values win; URL extraction fills missing fields.
  // Direct selectors that are irrelevant to the selected action reject
  // instead of riding downstream as silently ignored baggage.
  const selectors: Partial<Record<SocialSelectorField, string>> = {};
  for (const field of SELECTOR_FIELDS) {
    const raw = input[field];
    if (raw !== undefined && !allowedDirectSelectors.has(field)) {
      throw new SocialError('invalid_request', `${platform} ${action} does not support selector: ${field}`);
    }
    if (typeof raw === 'string' && raw.trim().length === 0) {
      throw new SocialError('invalid_request', `${field} must be a non-empty string when provided`);
    }
    const value = cleanSelector(raw);
    if (value !== undefined) {
      if (value.length > MAX_SELECTOR_LENGTH) {
        throw new SocialError('invalid_request', `${field} exceeds maximum length of ${MAX_SELECTOR_LENGTH}`);
      }
      selectors[field] = value;
    }
  }

  let url: string | undefined;
  if (typeof input.url === 'string') {
    if (input.url.trim().length === 0) {
      throw new SocialError('invalid_request', 'url must be a non-empty string when provided');
    }
    url = input.url.trim();
    const extracted = extractSelectorsFromUrl(platform, url);
    for (const [field, value] of Object.entries(extracted)) {
      const key = field as SocialSelectorField;
      if (selectors[key] === undefined && value !== undefined) {
        selectors[key] = value;
        warnings.push(`${key} derived from url`);
      }
    }
  }

  const missingRequired = (spec.required ?? []).filter((field) => selectors[field] === undefined);
  if (missingRequired.length > 0) {
    throw new SocialError(
      'invalid_request',
      `${platform} ${action} requires selector: ${missingRequired.join(', ')}`,
    );
  }
  if (spec.anyOf !== undefined && !spec.anyOf.some((field) => selectors[field] !== undefined)) {
    throw new SocialError(
      'invalid_request',
      `${platform} ${action} requires one of: ${spec.anyOf.join(', ')}`,
    );
  }

  const maxLimit = spec.maxLimit ?? SOCIAL_MAX_LIMIT;
  const { limit, warnings: limitWarnings } = resolveSocialLimit(input.limit, maxLimit);
  warnings.push(...limitWarnings);

  const request: SocialRequest = { platform, action, limit };
  for (const field of SELECTOR_FIELDS) {
    if (selectors[field] !== undefined) request[field] = selectors[field];
  }
  if (url !== undefined) request.url = url;
  const aux = auxSpecFor(platform, action);
  const feedVariant = validateAuxField(platform, action, aux, 'feedVariant', input.feedVariant);
  const sort = validateAuxField(platform, action, aux, 'sort', input.sort);
  const timeRange = validateAuxField(platform, action, aux, 'timeRange', input.timeRange);
  if (feedVariant !== undefined) request.feedVariant = feedVariant;
  if (sort !== undefined) request.sort = sort;
  if (timeRange !== undefined) request.timeRange = timeRange;
  if (input.includeReplies !== undefined) {
    if (aux.includeReplies === undefined) {
      throw new SocialError('invalid_request', `${platform} ${action} does not support includeReplies`);
    }
    if (typeof input.includeReplies !== 'boolean') {
      throw new SocialError('invalid_request', 'includeReplies must be a boolean when provided');
    }
    request.includeReplies = input.includeReplies;
  }
  return { request, warnings };
}

// ── Canonical URL / ID extraction ──
// Exact platform host allowlists. Lookalike hosts, non-HTTP schemes, URL
// credentials, and non-default ports are rejected before any path parsing.

const SOCIAL_URL_HOSTS: Readonly<Record<SocialPlatform, readonly string[]>> = {
  twitter: ['twitter.com', 'x.com'],
  reddit: ['reddit.com', 'redd.it'],
  xiaohongshu: ['xiaohongshu.com', 'xhslink.com'],
  facebook: ['facebook.com', 'fb.com'],
  instagram: ['instagram.com'],
  v2ex: ['v2ex.com'],
  linkedin: ['linkedin.com'],
};

const TWITTER_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'search', 'home', 'explore', 'i', 'notifications', 'messages', 'settings',
  'compose', 'intent', 'hashtag', 'jobs', 'privacy', 'tos', 'login', 'signup',
]);

const INSTAGRAM_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'p', 'reel', 'tv', 'explore', 'stories', 'accounts', 'direct', 'about',
]);

function parseCanonicalUrl(platform: SocialPlatform, url: string): URL {
  if (!isSocialPlatform(platform)) {
    throw new SocialError('invalid_request', `Unsupported platform: ${String(platform)}`);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SocialError('invalid_request', `url is not a valid URL: ${url.slice(0, 128)}`, { platform });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SocialError('invalid_request', `url scheme must be http or https, got ${parsed.protocol}`, { platform });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SocialError('invalid_request', 'url must not contain credentials', { platform });
  }
  if (parsed.port !== '') {
    throw new SocialError('invalid_request', `url must use a default port, got :${parsed.port}`, { platform });
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = SOCIAL_URL_HOSTS[platform].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
  if (!allowed) {
    throw new SocialError(
      'invalid_request',
      `url host ${host} is not an allowed ${platform} domain`,
      { platform },
    );
  }
  return parsed;
}

/**
 * Extract canonical selectors ({postId, commentId, user, community, topic})
 * from a verified platform URL. Only closed, known path shapes are parsed;
 * unrecognized shapes throw invalid_request rather than guessing.
 */
export function extractSelectorsFromUrl(
  platform: SocialPlatform,
  url: string,
): Partial<Record<SocialSelectorField, string>> {
  const parsed = parseCanonicalUrl(platform, url);
  const path = parsed.pathname.replace(/\/+$/, '');
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const first = segments[0] ?? '';

  switch (platform) {
    case 'twitter': {
      // /:user/status/:id (also /statuses/, /i/web/status/), /:user
      const statusIndex = segments.findIndex((segment) => segment === 'status' || segment === 'statuses');
      if (statusIndex >= 0 && segments[statusIndex + 1] !== undefined) {
        return { postId: segments[statusIndex + 1]! };
      }
      if (segments.length === 1 && /^[A-Za-z0-9_]{1,15}$/.test(first) && !TWITTER_RESERVED_PATHS.has(first)) {
        return { user: first.toLowerCase() };
      }
      break;
    }
    case 'reddit': {
      // /r/:sub/comments/:id(/[slug]/:commentId), /comments/:id, /r/:sub, /u/:name
      if (first === 'r' && segments[1] !== undefined && segments[2] === 'comments' && segments[3] !== undefined) {
        const extracted: Partial<Record<SocialSelectorField, string>> = {
          community: segments[1]!,
          postId: segments[3]!,
        };
        if (segments[5] !== undefined) extracted.commentId = segments[5]!;
        return extracted;
      }
      if (first === 'comments' && segments[1] !== undefined) {
        return { postId: segments[1]! };
      }
      if (first === 'r' && segments[1] !== undefined && segments.length === 2) {
        return { community: segments[1]! };
      }
      if ((first === 'user' || first === 'u') && segments[1] !== undefined && segments.length === 2) {
        return { user: segments[1]! };
      }
      break;
    }
    case 'xiaohongshu': {
      // /explore/:id, /discovery/item/:id, /user/profile/:id
      if (first === 'explore' && segments.length === 2 && /^[0-9a-f]{24}$/i.test(segments[1]!)) {
        return { postId: segments[1]! };
      }
      if (first === 'discovery' && segments[1] === 'item' && segments.length === 3 && /^[0-9a-f]{24}$/i.test(segments[2]!)) {
        return { postId: segments[2]! };
      }
      if (first === 'user' && segments[1] === 'profile' && segments.length === 3) {
        return { user: segments[2]! };
      }
      break;
    }
    case 'facebook': {
      // /groups/:id, /people/:name/:id, /profile.php?id=, /:user
      if (first === 'groups' && segments[1] !== undefined && segments.length === 2) {
        return { community: segments[1]! };
      }
      if (first === 'people' && segments[1] !== undefined && segments[2] !== undefined && segments.length === 3) {
        return { user: segments[2]! };
      }
      if (first === 'profile.php' && parsed.searchParams.get('id') !== null) {
        return { user: parsed.searchParams.get('id')! };
      }
      if (segments.length === 1 && /^[A-Za-z0-9.]{5,}$/.test(first)) {
        return { user: first };
      }
      break;
    }
    case 'instagram': {
      // /p/:shortcode, /reel/:id, /tv/:id, /:user
      if ((first === 'p' || first === 'reel' || first === 'tv') && segments[1] !== undefined && segments.length === 2) {
        return { postId: segments[1]! };
      }
      if (segments.length === 1 && /^[A-Za-z0-9._]{1,30}$/.test(first) && !INSTAGRAM_RESERVED_PATHS.has(first)) {
        return { user: first };
      }
      break;
    }
    case 'v2ex': {
      // /t/:id, /go/:node, /member/:name
      if (first === 't' && segments[1] !== undefined && segments.length === 2 && /^\d+$/.test(segments[1]!)) {
        return { postId: segments[1]!, topic: segments[1]! };
      }
      if (first === 'go' && segments[1] !== undefined && segments.length === 2) {
        return { community: segments[1]! };
      }
      if (first === 'member' && segments[1] !== undefined && segments.length === 2) {
        return { user: segments[1]! };
      }
      break;
    }
    case 'linkedin': {
      // /in/:handle
      if (first === 'in' && segments[1] !== undefined && segments.length === 2) {
        return { user: segments[1]! };
      }
      break;
    }
  }
  throw new SocialError('invalid_request', `unrecognized ${platform} URL shape: ${path.slice(0, 128)}`, { platform });
}

// ── Pagination cursors ──
// Opaque base64url JSON bound to platform/action/backend plus a fingerprint
// of the canonical selectors, filters, sort, time range, and limit. Cursors
// never contain cookies, API keys, full authenticated URLs, or XHS
// xsec_token values.

export const SOCIAL_MAX_CURSOR_LENGTH = 4096;

export type SocialCursorState = Record<string, string | number | boolean>;

export interface SocialCursorV1 {
  v: 1;
  platform: SocialPlatform;
  action: SocialAction;
  backend: string;
  fingerprint: string;
  state: SocialCursorState;
}

export interface DecodedSocialCursor {
  platform: SocialPlatform;
  action: SocialAction;
  backend: string;
  state: SocialCursorState;
}

// Credential-shaped substrings forbidden in cursor keys and string values.
const FORBIDDEN_CURSOR_SUBSTRINGS: readonly string[] = [
  'cookie', 'xsec_token', 'auth_token', 'access_token', 'refresh_token',
  'id_token', 'authorization', 'bearer', 'password', 'secret', 'api_key',
  'apikey', 'ct0', 'sessdata', 'http://', 'https://',
];

function assertCursorSafe(state: SocialCursorState): void {
  for (const [key, value] of Object.entries(state)) {
    if (key.length === 0) {
      throw new SocialError('cursor_invalid', 'cursor state keys must be non-empty');
    }
    const haystack = `${key} ${typeof value === 'string' ? value : ''}`.toLowerCase();
    for (const forbidden of FORBIDDEN_CURSOR_SUBSTRINGS) {
      if (haystack.includes(forbidden)) {
        throw new SocialError('cursor_invalid', `cursor state contains forbidden material in "${key}"`);
      }
    }
  }
}

export interface SocialCursorFingerprintInput {
  platform: SocialPlatform;
  action: SocialAction;
  query?: string;
  postId?: string;
  commentId?: string;
  user?: string;
  community?: string;
  topic?: string;
  feedVariant?: string;
  sort?: string;
  timeRange?: string;
  includeReplies?: boolean;
  limit: number;
}

/** SHA-256 fingerprint over canonical selectors, filters, sort, time range, and limit. */
export function socialCursorFingerprint(input: SocialCursorFingerprintInput): string {
  const parts: string[] = [
    input.platform,
    input.action,
    input.query ?? '',
    input.postId ?? '',
    input.commentId ?? '',
    input.user ?? '',
    input.community ?? '',
    input.topic ?? '',
    input.feedVariant ?? '',
    input.sort ?? '',
    input.timeRange ?? '',
    input.includeReplies === undefined ? '' : String(input.includeReplies),
    String(input.limit),
  ];
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex');
}

export function encodeSocialCursor(input: {
  platform: SocialPlatform;
  action: SocialAction;
  backend: string;
  fingerprint: string;
  state: SocialCursorState;
}): string {
  assertCursorSafe(input.state);
  const payload: SocialCursorV1 = {
    v: 1,
    platform: input.platform,
    action: input.action,
    backend: input.backend,
    fingerprint: input.fingerprint,
    state: input.state,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  if (encoded.length > SOCIAL_MAX_CURSOR_LENGTH) {
    throw new SocialError('cursor_invalid', `cursor exceeds maximum length of ${SOCIAL_MAX_CURSOR_LENGTH}`);
  }
  return encoded;
}

/**
 * Decode and verify a cursor against the current request. Rejects malformed
 * tokens (cursor_invalid) and cursors bound to a different platform, action,
 * backend, or selector fingerprint (cursor_mismatch). A cursor-pinned request
 * must never switch backends.
 */
export function decodeSocialCursor(
  cursor: string,
  expected: { platform: SocialPlatform; action: SocialAction; backend: string; fingerprint: string },
): DecodedSocialCursor {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new SocialError('cursor_invalid', 'cursor is required');
  }
  if (cursor.length > SOCIAL_MAX_CURSOR_LENGTH) {
    throw new SocialError('cursor_invalid', `cursor exceeds maximum length of ${SOCIAL_MAX_CURSOR_LENGTH}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new SocialError('cursor_invalid', 'cursor is not a valid opaque token');
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new SocialError('cursor_invalid', 'cursor payload is invalid');
  }
  const record = payload as Record<string, unknown>;
  if (record.v !== 1) {
    throw new SocialError('cursor_invalid', 'cursor payload version must be 1');
  }
  if (!isSocialPlatform(record.platform) || !isSocialAction(record.action)) {
    throw new SocialError('cursor_invalid', 'cursor platform/action is invalid');
  }
  if (typeof record.backend !== 'string' || record.backend.length === 0
    || typeof record.fingerprint !== 'string' || record.fingerprint.length === 0) {
    throw new SocialError('cursor_invalid', 'cursor backend/fingerprint is invalid');
  }
  if (!isSocialCursorState(record.state)) {
    throw new SocialError('cursor_invalid', 'cursor state contains non-scalar values');
  }
  const state = record.state;
  assertCursorSafe(state);
  if (record.platform !== expected.platform || record.action !== expected.action
    || record.backend !== expected.backend || record.fingerprint !== expected.fingerprint) {
    throw new SocialError(
      'cursor_mismatch',
      `cursor was issued for ${record.platform}/${record.action}/${record.backend}, not ${expected.platform}/${expected.action}/${expected.backend}`,
      { platform: expected.platform, backend: expected.backend },
    );
  }
  return { platform: record.platform, action: record.action, backend: record.backend, state };
}

function isSocialCursorState(value: unknown): value is SocialCursorState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (entry) => typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
  );
}

// NOTE: normalized entity types, socialEntityId, and parseSocialDate moved
// to social-entity-contract.js and re-exported above.

// ── Worker / plan seam ──

export interface SocialExecutionContext {
  /** Abort signal propagated to every backend execution. */
  signal?: AbortSignal;
}

export interface SocialBackendPlan {
  backend: string;
  authTier: SocialAuthTier;
  pagination: SocialPaginationMode;
  execute(signal?: AbortSignal): Promise<unknown>;
}

// NOTE: SocialPageV1 moved to social-entity-contract.js and re-exported above.

/**
 * A platform worker owns command/endpoint mapping, payload parsing, and
 * platform normalization for its platforms. Workers never choose global
 * fallback order; the central integrator selects among declared plans.
 */
export interface SocialPlatformWorker {
  readonly platforms: readonly SocialPlatform[];
  plans(request: SocialRequest, context: SocialExecutionContext): Promise<readonly SocialBackendPlan[]>;
  normalize(request: SocialRequest, plan: SocialBackendPlan, payload: unknown): SocialPageV1;
}

// ── Backend capability shape (registry data lives in src/capabilities.ts) ──

export interface BackendActionCapability {
  action: SocialAction;
  upstreamAction: readonly string[];
  auth: readonly SocialAuthTier[];
  pagination: SocialPaginationMode;
  required: readonly SocialSelectorField[];
  maxLimit: number;
}

export interface BackendCapability {
  name: string;
  type: 'native' | 'external';
  command?: string;
  verifiedVersion?: string;
  operations: readonly BackendActionCapability[];
}

/** Whether a backend declares an operation for a canonical action. */
export function backendSupportsAction(capability: BackendCapability, action: SocialAction): boolean {
  return capability.operations.some((operation) => operation.action === action);
}

// NOTE: envelope validators moved to social-entity-contract.js and re-exported above.

// NOTE: human-readable rendering moved to social-entity-contract.js and re-exported above.
