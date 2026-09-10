// Stage 2 social contract: shared social vocabulary, canonical action
// validation, platform-aware selector/limit validation, canonical URL/ID
// extraction, cursor encoding/validation, SocialError, normalized entity
// types, the SocialPlatformWorker seam, and human-readable rendering helpers.
//
// This module owns vocabulary and validation only. Platform command/endpoint
// mappings live in the per-platform workers; global backend selection lives in
// the central integrator (src/social.ts). Canonical capability data stays in
// the capability registry (src/capabilities.ts); the BackendCapability types
// here are the shape that registry and workers must satisfy.
//
// Canonical-only contract: no legacy aliases exist. Unknown action names are
// rejected with unsupported_action before any backend dispatch. Instagram has
// no post-detail action until a verified read-only adapter exists.

import { createHash } from 'node:crypto';

// ── Core vocabulary ──

export const SOCIAL_PLATFORMS = [
  'twitter',
  'reddit',
  'xiaohongshu',
  'facebook',
  'instagram',
  'v2ex',
  'linkedin',
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export const SOCIAL_ACTIONS = [
  'search',
  'get_post',
  'get_thread',
  'get_comments',
  'get_comment_replies',
  'get_profile',
  'get_user_posts',
  'get_user_comments',
  'get_followers',
  'get_following',
  'get_feed',
  'get_trending',
  'get_saved',
  'get_notifications',
  'get_community',
  'get_community_posts',
  'get_topic',
] as const;

export type SocialAction = (typeof SOCIAL_ACTIONS)[number];

export type SocialAuthTier = 'cookie' | 'anonymous' | 'api_key';

export type SocialPaginationMode = 'cursor' | 'page' | 'none';

export type SocialEntityKind =
  | 'social_post'
  | 'social_comment'
  | 'social_account'
  | 'social_thread'
  | 'social_community'
  | 'social_media'
  | 'social_relationship'
  | 'social_engagement'
  | 'social_topic'
  | 'social_notification'
  | 'social_reference';

export const SOCIAL_ENTITY_KINDS: ReadonlySet<string> = new Set([
  'social_post',
  'social_comment',
  'social_account',
  'social_thread',
  'social_community',
  'social_media',
  'social_relationship',
  'social_engagement',
  'social_topic',
  'social_notification',
  'social_reference',
]);

export function isSocialPlatform(value: unknown): value is SocialPlatform {
  return typeof value === 'string' && (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export function isSocialAction(value: unknown): value is SocialAction {
  return typeof value === 'string' && (SOCIAL_ACTIONS as readonly string[]).includes(value);
}

function isSocialEntityKind(value: unknown): value is SocialEntityKind {
  return typeof value === 'string' && SOCIAL_ENTITY_KINDS.has(value);
}

// ── Advertised canonical actions per platform (capability table) ──
// Platform-scoped. Unsupported actions stay unadvertised; the registry here is
// the single source of truth for what each platform accepts. Never maintain a
// duplicate of these lists elsewhere.

export const SOCIAL_CANONICAL_ACTIONS: Readonly<Record<SocialPlatform, readonly SocialAction[]>> = {
  twitter: [
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
    'get_profile', 'get_user_posts', 'get_followers', 'get_following',
    'get_feed', 'get_trending', 'get_saved', 'get_notifications',
  ],
  reddit: [
    'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
    'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
    'get_trending', 'get_saved', 'get_community', 'get_community_posts',
  ],
  xiaohongshu: [
    'search', 'get_post', 'get_comments', 'get_profile', 'get_user_posts',
    'get_followers', 'get_following', 'get_feed', 'get_saved', 'get_notifications',
  ],
  facebook: ['search', 'get_profile', 'get_feed', 'get_notifications', 'get_community'],
  instagram: [
    'search', 'get_profile', 'get_user_posts', 'get_followers', 'get_following',
    'get_trending', 'get_saved',
  ],
  v2ex: [
    'get_topic', 'get_thread', 'get_comments', 'get_profile', 'get_trending',
    'get_community', 'get_community_posts', 'get_notifications',
  ],
  linkedin: ['search', 'get_profile', 'get_user_posts', 'get_feed'],
};

export function canonicalActionsFor(platform: SocialPlatform): readonly SocialAction[] {
  return SOCIAL_CANONICAL_ACTIONS[platform];
}

export function isAdvertisedAction(platform: SocialPlatform, action: SocialAction): boolean {
  return SOCIAL_CANONICAL_ACTIONS[platform].includes(action);
}

/**
 * Validate that `action` is an advertised canonical action for the platform.
 * Unknown or unadvertised action names throw unsupported_action — no alias
 * mapping, no fallback spelling. Throws before any backend dispatch.
 */
export function resolveSocialAction(platform: SocialPlatform, action: string): SocialAction {
  if (!isSocialAction(action) || !SOCIAL_CANONICAL_ACTIONS[platform].includes(action)) {
    throw new SocialError('unsupported_action', `Unsupported ${platform} action: ${action}`, { platform });
  }
  return action;
}

// ── Errors ──

export type SocialErrorCode =
  | 'invalid_request'
  | 'unsupported_action'
  | 'not_found'
  | 'backend_unavailable'
  | 'authentication_required'
  | 'permission_denied'
  | 'rate_limited'
  | 'upstream_error'
  | 'malformed_upstream'
  | 'cursor_invalid'
  | 'cursor_mismatch';

const RETRYABLE_ERROR_CODES: ReadonlySet<SocialErrorCode> = new Set([
  'backend_unavailable',
  'rate_limited',
  'upstream_error',
  'malformed_upstream',
]);

export class SocialError extends Error {
  readonly code: SocialErrorCode;
  readonly platform?: SocialPlatform;
  readonly backend?: string;
  readonly retryable: boolean;

  constructor(
    code: SocialErrorCode,
    message: string,
    options?: { platform?: SocialPlatform; backend?: string; retryable?: boolean; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'SocialError';
    this.code = code;
    if (options?.platform !== undefined) this.platform = options.platform;
    if (options?.backend !== undefined) this.backend = options.backend;
    this.retryable = options?.retryable ?? RETRYABLE_ERROR_CODES.has(code);
  }
}

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
    get_comments: { anyOf: ['postId'] },
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
    search: { required: ['query'] },
    get_profile: { required: ['user'] },
    get_user_posts: { required: ['user'] },
    get_feed: {},
  },
};

export function selectorSpecFor(platform: SocialPlatform, action: SocialAction): SocialActionSelectorSpec {
  return SOCIAL_ACTION_SELECTORS[platform][action] ?? {};
}

export const DEFAULT_SOCIAL_LIMIT = 20;
export const SOCIAL_MAX_LIMIT = 100;
const MAX_SELECTOR_LENGTH = 1024;

/** Validate and bound a request limit. Clamps above the cap with a warning. */
export function resolveSocialLimit(raw: unknown, maxLimit: number = SOCIAL_MAX_LIMIT): { limit: number; warnings: string[] } {
  const warnings: string[] = [];
  if (raw === undefined || raw === null) return { limit: DEFAULT_SOCIAL_LIMIT, warnings };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw new SocialError('invalid_request', 'limit must be a positive integer');
  }
  if (raw > maxLimit) {
    warnings.push(`limit clamped to ${maxLimit}`);
    return { limit: maxLimit, warnings };
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
export function validateSocialRequest(input: SocialRequestInput): { request: SocialRequest; warnings: string[] } {
  const warnings: string[] = [];

  if (!isSocialPlatform(input.platform)) {
    throw new SocialError('invalid_request', `Unsupported platform: ${String(input.platform)}`);
  }
  const platform: SocialPlatform = input.platform;
  const action = resolveSocialAction(platform, input.action);

  // Selectors: explicit values win; URL extraction fills missing fields.
  const selectors: Partial<Record<SocialSelectorField, string>> = {};
  for (const field of SELECTOR_FIELDS) {
    const raw = input[field];
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

  const spec = SOCIAL_ACTION_SELECTORS[platform][action] ?? {};
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
  if (input.feedVariant !== undefined) request.feedVariant = input.feedVariant;
  if (input.sort !== undefined) request.sort = input.sort;
  if (input.timeRange !== undefined) request.timeRange = input.timeRange;
  if (input.includeReplies !== undefined) request.includeReplies = input.includeReplies;
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
    throw new SocialError('invalid_request', `url is not a valid URL: ${url}`, { platform });
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
  throw new SocialError('invalid_request', `unrecognized ${platform} URL shape: ${path}`, { platform });
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

// ── Normalized entities ──
// Only fields present upstream are set. Never synthesize zero metrics, dates,
// parent relationships, or verification status.

export interface SocialEntityBaseV1 {
  version: 1;
  kind: SocialEntityKind;
  id: string;
  platformId?: string;
  platform: SocialPlatform;
  backend: string;
  url?: string;
  publishedAt?: string;
}

export interface SocialActorV1 {
  id?: string;
  handle?: string;
  displayName?: string;
  profileUrl?: string;
  avatarUrl?: string;
  verified?: boolean;
}

export interface SocialMetricsV1 {
  likes?: number;
  replies?: number;
  comments?: number;
  shares?: number;
  reposts?: number;
  quotes?: number;
  saves?: number;
  views?: number;
  score?: number;
  followers?: number;
  following?: number;
}

export interface SocialMediaV1 {
  type?: 'image' | 'video' | 'gif' | 'link';
  url?: string;
  thumbnailUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
}

export interface SocialPostV1 extends SocialEntityBaseV1 {
  kind: 'social_post';
  contentType: 'post' | 'article' | 'note' | 'topic';
  title?: string;
  text?: string;
  author?: SocialActorV1;
  communityId?: string;
  threadId?: string;
  parentId?: string;
  metrics?: SocialMetricsV1;
  media?: SocialMediaV1[];
}

export interface SocialCommentV1 extends SocialEntityBaseV1 {
  kind: 'social_comment';
  postId: string;
  parentCommentId?: string;
  depth?: number;
  text: string;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialAccountV1 extends SocialEntityBaseV1 {
  kind: 'social_account';
  handle?: string;
  displayName?: string;
  bio?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialThreadV1 extends SocialEntityBaseV1 {
  kind: 'social_thread';
  rootPostId: string;
  title?: string;
  text?: string;
  postIds?: string[];
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialCommunityV1 extends SocialEntityBaseV1 {
  kind: 'social_community';
  name?: string;
  description?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialMediaItemV1 extends SocialEntityBaseV1 {
  kind: 'social_media';
  postId: string;
  mediaType: 'image' | 'video' | 'gif' | 'link';
  thumbnailUrl?: string;
  altText?: string;
  width?: number;
  height?: number;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialRelationshipV1 extends SocialEntityBaseV1 {
  kind: 'social_relationship';
  user: string;
  relatedUser: string;
  relationship: 'following' | 'followed_by' | 'mutual';
  actor?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialEngagementV1 extends SocialEntityBaseV1 {
  kind: 'social_engagement';
  postId: string;
  engagementType: 'like' | 'repost' | 'share' | 'save' | 'view' | 'quote';
  actor?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export interface SocialTopicV1 extends SocialEntityBaseV1 {
  kind: 'social_topic';
  name?: string;
  description?: string;
  metrics?: SocialMetricsV1;
}

export interface SocialNotificationV1 extends SocialEntityBaseV1 {
  kind: 'social_notification';
  type?: string;
  text?: string;
  actor?: SocialActorV1;
  relatedEntityId?: string;
}

export interface SocialReferenceV1 extends SocialEntityBaseV1 {
  // Sparse-row fallback only: search listings too sparse to form a
  // post/comment/account/community/topic/notification entity. Never
  // synthesize a reference when a richer kind applies.
  kind: 'social_reference';
  title?: string;
  snippet?: string;
  author?: SocialActorV1;
  metrics?: SocialMetricsV1;
}

export type SocialEntityV1 =
  | SocialPostV1
  | SocialCommentV1
  | SocialAccountV1
  | SocialThreadV1
  | SocialCommunityV1
  | SocialMediaItemV1
  | SocialRelationshipV1
  | SocialEngagementV1
  | SocialTopicV1
  | SocialNotificationV1
  | SocialReferenceV1;

/** Namespaced entity id: platform/kind/native ID. */
export function socialEntityId(platform: SocialPlatform, kind: SocialEntityKind, nativeId: string): string {
  return `${platform}:${kind}:${nativeId}`;
}

/** ISO 8601 timestamp or undefined. Invalid dates are omitted by callers (with a warning). */
export function parseSocialDate(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds vs milliseconds heuristic.
    const ms = Math.abs(value) >= 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  const parsed = new Date(value.trim());
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

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

export interface SocialPageV1 {
  entities: SocialEntityV1[];
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

// ── Envelope validation ──
// Normalized envelope validator: rejects unknown fields, NaN metrics, invalid
// dates, and malformed URLs before a page is surfaced.

const METRIC_KEYS: readonly (keyof SocialMetricsV1)[] = [
  'likes', 'replies', 'comments', 'shares', 'reposts', 'quotes', 'saves',
  'views', 'score', 'followers', 'following',
];

const ENTITY_KIND_FIELDS: Readonly<Record<SocialEntityKind, ReadonlySet<string>>> = {
  social_post: new Set(['contentType', 'title', 'text', 'author', 'communityId', 'threadId', 'parentId', 'metrics', 'media']),
  social_comment: new Set(['postId', 'parentCommentId', 'depth', 'text', 'author', 'metrics']),
  social_account: new Set(['handle', 'displayName', 'bio', 'metrics']),
  social_thread: new Set(['rootPostId', 'title', 'text', 'postIds', 'author', 'metrics']),
  social_community: new Set(['name', 'description', 'metrics']),
  social_media: new Set(['postId', 'mediaType', 'thumbnailUrl', 'altText', 'width', 'height', 'author', 'metrics']),
  social_relationship: new Set(['user', 'relatedUser', 'relationship', 'actor', 'metrics']),
  social_engagement: new Set(['postId', 'engagementType', 'actor', 'metrics']),
  social_topic: new Set(['name', 'description', 'metrics']),
  social_notification: new Set(['type', 'text', 'actor', 'relatedEntityId']),
  social_reference: new Set(['title', 'snippet', 'author', 'metrics']),
};

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateActor(value: unknown, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push('actor must be an object');
    return;
  }
  const actor = value as Record<string, unknown>;
  const allowed = new Set(['id', 'handle', 'displayName', 'profileUrl', 'avatarUrl', 'verified']);
  for (const key of Object.keys(actor)) {
    if (!allowed.has(key)) issues.push(`actor.${key} is not a known field`);
  }
  for (const key of ['id', 'handle', 'displayName', 'profileUrl', 'avatarUrl'] as const) {
    if (actor[key] !== undefined && typeof actor[key] !== 'string') issues.push(`actor.${key} must be a string`);
  }
  if (actor.profileUrl !== undefined && typeof actor.profileUrl === 'string' && !isValidHttpUrl(actor.profileUrl)) {
    issues.push('actor.profileUrl is not a valid http(s) URL');
  }
  if (actor.verified !== undefined && typeof actor.verified !== 'boolean') {
    issues.push('actor.verified must be a boolean');
  }
}

function validateMetrics(value: unknown, path: string, issues: string[]): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push(`${path} must be an object`);
    return;
  }
  const metrics = value as Record<string, unknown>;
  for (const key of Object.keys(metrics)) {
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      issues.push(`${path}.${key} is not a known metric`);
      continue;
    }
    const metric = metrics[key];
    if (metric !== undefined && (typeof metric !== 'number' || !Number.isFinite(metric))) {
      issues.push(`${path}.${key} must be a finite number`);
    }
  }
}

export function validateSocialEntity(value: unknown): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['entity is not an object'] };
  }
  const entity = value as Record<string, unknown>;
  const kind = entity.kind;
  if (!isSocialEntityKind(kind)) {
    return { ok: false, issues: ['kind is not a valid social entity kind'] };
  }
  if (entity.version !== 1) issues.push('version must be 1');
  if (typeof entity.id !== 'string' || entity.id.trim().length === 0) issues.push('id is required');
  if (!isSocialPlatform(entity.platform)) issues.push('platform is not a valid social platform');
  if (typeof entity.backend !== 'string' || entity.backend.trim().length === 0) issues.push('backend is required');
  if (entity.platformId !== undefined && typeof entity.platformId !== 'string') issues.push('platformId must be a string');
  if (entity.url !== undefined && (typeof entity.url !== 'string' || !isValidHttpUrl(entity.url))) {
    issues.push('url is not a valid http(s) URL');
  }
  if (entity.publishedAt !== undefined && parseSocialDate(entity.publishedAt) === undefined) {
    issues.push('publishedAt is not a valid date');
  }

  const allowed = new Set([
    'version', 'kind', 'id', 'platformId', 'platform', 'backend', 'url', 'publishedAt',
    ...ENTITY_KIND_FIELDS[kind],
  ]);
  for (const key of Object.keys(entity)) {
    if (!allowed.has(key)) issues.push(`${key} is not a known field for kind ${String(kind)}`);
  }

  if (kind === 'social_post') {
    if (!['post', 'article', 'note', 'topic'].includes(entity.contentType as string)) {
      issues.push('contentType must be post, article, note, or topic');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
    if (entity.media !== undefined) {
      if (!Array.isArray(entity.media)) issues.push('media must be an array');
      else {
        for (const [index, media] of entity.media.entries()) {
          if (typeof media !== 'object' || media === null || Array.isArray(media)) {
            issues.push(`media[${index}] must be an object`);
            continue;
          }
          const row = media as Record<string, unknown>;
          const mediaAllowed = new Set(['type', 'url', 'thumbnailUrl', 'altText', 'width', 'height']);
          for (const key of Object.keys(row)) {
            if (!mediaAllowed.has(key)) issues.push(`media[${index}].${key} is not a known field`);
          }
          if (row.url !== undefined && (typeof row.url !== 'string' || !isValidHttpUrl(row.url))) {
            issues.push(`media[${index}].url is not a valid http(s) URL`);
          }
        }
      }
    }
  } else if (kind === 'social_comment') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (typeof entity.text !== 'string' || entity.text.trim().length === 0) issues.push('text is required');
    if (entity.depth !== undefined && (typeof entity.depth !== 'number' || !Number.isFinite(entity.depth))) {
      issues.push('depth must be a finite number');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_thread') {
    if (typeof entity.rootPostId !== 'string' || entity.rootPostId.trim().length === 0) issues.push('rootPostId is required');
    if (entity.title !== undefined && typeof entity.title !== 'string') issues.push('title must be a string');
    if (entity.text !== undefined && typeof entity.text !== 'string') issues.push('text must be a string');
    if (entity.postIds !== undefined && (!Array.isArray(entity.postIds) || entity.postIds.some((id) => typeof id !== 'string'))) {
      issues.push('postIds must be an array of strings');
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_media') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (!['image', 'video', 'gif', 'link'].includes(entity.mediaType as string)) {
      issues.push('mediaType must be image, video, gif, or link');
    }
    if (entity.thumbnailUrl !== undefined && (typeof entity.thumbnailUrl !== 'string' || !isValidHttpUrl(entity.thumbnailUrl))) {
      issues.push('thumbnailUrl is not a valid http(s) URL');
    }
    for (const dim of ['width', 'height'] as const) {
      if (entity[dim] !== undefined && (typeof entity[dim] !== 'number' || !Number.isFinite(entity[dim]))) {
        issues.push(`${dim} must be a finite number`);
      }
    }
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_relationship') {
    if (typeof entity.user !== 'string' || entity.user.trim().length === 0) issues.push('user is required');
    if (typeof entity.relatedUser !== 'string' || entity.relatedUser.trim().length === 0) issues.push('relatedUser is required');
    if (!['following', 'followed_by', 'mutual'].includes(entity.relationship as string)) {
      issues.push('relationship must be following, followed_by, or mutual');
    }
    validateActor(entity.actor, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_engagement') {
    if (typeof entity.postId !== 'string' || entity.postId.trim().length === 0) issues.push('postId is required');
    if (!['like', 'repost', 'share', 'save', 'view', 'quote'].includes(entity.engagementType as string)) {
      issues.push('engagementType must be like, repost, share, save, view, or quote');
    }
    validateActor(entity.actor, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  } else if (kind === 'social_notification') {
    validateActor(entity.actor, issues);
  } else {
    validateActor(entity.author, issues);
    validateMetrics(entity.metrics, 'metrics', issues);
  }

  return { ok: issues.length === 0, issues };
}

export function validateSocialPage(value: unknown): { ok: boolean; issues: string[]; page?: SocialPageV1 } {
  const issues: string[] = [];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, issues: ['page is not an object'] };
  }
  const page = value as Record<string, unknown>;

  if (!Array.isArray(page.entities)) {
    issues.push('entities must be an array');
  } else {
    for (const [index, entity] of page.entities.entries()) {
      const check = validateSocialEntity(entity);
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

  return issues.length === 0 ? { ok: true, issues, page: page as unknown as SocialPageV1 } : { ok: false, issues };
}

// ── Human-readable rendering ──

function boundedText(value: string, maxChars: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

function actorLabel(actor: SocialActorV1 | undefined): string | undefined {
  if (actor === undefined) return undefined;
  if (actor.handle !== undefined) return `@${actor.handle}`;
  if (actor.displayName !== undefined) return actor.displayName;
  return undefined;
}

const METRIC_LABELS: Record<keyof SocialMetricsV1, string> = {
  likes: 'likes', replies: 'replies', comments: 'comments', shares: 'shares',
  reposts: 'reposts', quotes: 'quotes', saves: 'saves', views: 'views',
  score: 'score', followers: 'followers', following: 'following',
};

function metricsSummary(metrics: SocialMetricsV1 | undefined): string | undefined {
  if (metrics === undefined) return undefined;
  const parts: string[] = [];
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (value !== undefined) parts.push(`${METRIC_LABELS[key]} ${value}`);
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Render one normalized entity as deterministic human-readable text. */
export function renderSocialEntity(entity: SocialEntityV1, options?: { maxTextChars?: number }): string {
  const maxTextChars = options?.maxTextChars ?? 200;
  const lines: string[] = [];

  switch (entity.kind) {
    case 'social_post': {
      const headline = entity.title ?? entity.text ?? '';
      const headlineText = boundedText(headline, maxTextChars);
      lines.push(headlineText.length > 0 ? `[post] ${headlineText}` : '[post]');
      break;
    }
    case 'social_comment': {
      lines.push(`[comment] ${boundedText(entity.text, maxTextChars)}`);
      lines.push(`on post ${entity.postId}`);
      break;
    }
    case 'social_account': {
      const label = entity.handle !== undefined ? `@${entity.handle}` : entity.displayName ?? entity.id;
      lines.push(`[account] ${label}`);
      if (entity.bio !== undefined) lines.push(boundedText(entity.bio, maxTextChars));
      break;
    }
    case 'social_thread': {
      const threadHeadline = entity.title ?? entity.text ?? entity.rootPostId;
      lines.push(`[thread] ${boundedText(threadHeadline, maxTextChars)}`);
      lines.push(`root post ${entity.rootPostId}`);
      if (entity.postIds !== undefined) lines.push(`${entity.postIds.length} posts`);
      break;
    }
    case 'social_community': {
      lines.push(`[community] ${entity.name ?? entity.id}`);
      if (entity.description !== undefined) lines.push(boundedText(entity.description, maxTextChars));
      break;
    }
    case 'social_media': {
      lines.push(`[media:${entity.mediaType}] on post ${entity.postId}`);
      if (entity.altText !== undefined) lines.push(boundedText(entity.altText, maxTextChars));
      break;
    }
    case 'social_relationship': {
      lines.push(`[relationship] ${entity.user} ${entity.relationship} ${entity.relatedUser}`);
      break;
    }
    case 'social_engagement': {
      lines.push(`[engagement:${entity.engagementType}] on post ${entity.postId}`);
      break;
    }
    case 'social_topic': {
      lines.push(`[topic] ${entity.name ?? entity.id}`);
      if (entity.description !== undefined) lines.push(boundedText(entity.description, maxTextChars));
      break;
    }
    case 'social_notification': {
      lines.push(`[notification] ${entity.type ?? 'event'}`);
      if (entity.text !== undefined) lines.push(boundedText(entity.text, maxTextChars));
      break;
    }
    case 'social_reference': {
      const headline = boundedText(entity.title ?? entity.snippet ?? '', maxTextChars);
      lines.push(headline.length > 0 ? `[reference] ${headline}` : '[reference]');
      break;
    }
  }

  if ('author' in entity) {
    const label = actorLabel(entity.author);
    if (label !== undefined) lines.push(`by ${label}`);
  } else if ('actor' in entity) {
    const label = actorLabel(entity.actor);
    if (label !== undefined) lines.push(`by ${label}`);
  }
  if (entity.publishedAt !== undefined) lines.push(`published ${entity.publishedAt}`);
  const metricsLine = metricsSummary('metrics' in entity ? entity.metrics : undefined);
  if (metricsLine !== undefined) lines.push(metricsLine);
  if (entity.url !== undefined) lines.push(entity.url);
  return lines.join('\n');
}

/** Render a normalized page: entities joined by blank lines plus pagination footer. */
export function renderSocialPage(page: SocialPageV1, options?: { maxTextChars?: number }): string {
  const sections = page.entities.map((entity) => renderSocialEntity(entity, options));
  const footer: string[] = [];
  if (page.pagination.hasMore) footer.push('more results available (use nextCursor to continue)');
  else if (page.pagination.supported) footer.push(`${page.pagination.returned} of up to ${page.pagination.limit} results`);
  for (const warning of page.warnings) footer.push(`warning: ${warning}`);
  if (page.partial) footer.push('partial: some upstream rows were dropped');
  const body = sections.join('\n\n');
  const tail = footer.join('\n');
  if (body.length === 0 && tail.length === 0) return '(no results)';
  if (tail.length === 0) return body;
  return body.length === 0 ? tail : `${body}\n\n--\n${tail}`;
}