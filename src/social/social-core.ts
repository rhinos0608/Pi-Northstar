// Social core vocabulary: platforms, actions, entity kinds, the canonical
// action registry, and SocialError. Foundational module with no runtime
// imports — social-entity-contract and the social-contract facade build on it.
// Never import from the facade here; that would create a runtime cycle.

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
    throw new SocialError('unsupported_action', `Unsupported ${platform} action: ${String(action).slice(0, 32)}`, { platform });
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
