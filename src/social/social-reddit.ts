// Stage 2 Reddit platform worker.
//
// Owns Reddit command/endpoint mapping, payload parsing, platform
// normalization, and backend plan declaration for the advertised canonical
// Reddit actions. Global backend selection stays in src/social.ts.
//
// Backends, in the binding auth order (cookie → anonymous → api_key), with
// the Reddit preference OpenCLI → rdt-cli → native within an equal tier:
//   - reddit-cookie (native www.reddit.com JSON, cookie session, rejects redirects)
//   - OpenCLI 1.8.6 (external CLI, always `-f json`, anonymous on public data)
//   - rdt-cli 0.4.2 (external Python CLI, `--json`, `--after` cursor)
//   - reddit-oauth  (native oauth.reddit.com, optional API key, public actions only)
//
// Completeness: `get_post` returns exactly one post entity; `get_thread`
// returns the root post first, then comments in source structural order.
// Listing actions carry truthful `after` cursors; thread trees never do.
// No archive, web, or other fallback backend exists in this module, and no
// mutation command (save/upvote/comment/login/open/export) is ever spawned.

import { spawnCliCommand } from '../process/cli-command.js';
import { createHash } from 'node:crypto';
import { cookieHeaderForUrl } from '../chrome/cookie-jar.js';
import { requireCliPositional } from './social-cli-safety.js';
import { buildPythonChildEnvironment } from '../process/python-child-env.js';
import { openCliChildEnv } from './social-opencli.js';
import {
  SocialError,
  decodeSocialCursor,
  encodeSocialCursor,
  parseSocialDate,
  socialCursorFingerprint,
  socialEntityId,
  validateSocialEntity,
  type BackendActionCapability,
  type BackendCapability,
  type SocialAuthTier,
  type SocialBackendPlan,
  type SocialEntityV1,
  type SocialExecutionContext,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialRequest,
} from './social-contract.js';

const REDDIT_WWW_BASE = 'https://www.reddit.com';
const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const USER_AGENT = 'pi-northstar/0.1 (social-reddit worker)';

const CLI_TIMEOUT_MS = 60_000;
const SIGKILL_AFTER_MS = 5_000;
const MAX_OUTPUT_CHARS = 4_000_000;

// Strict closed shapes for Reddit identifiers reaching an argv or URL.
const REDDIT_ID_RE = /^(?:t[135]_)?[A-Za-z0-9]{4,12}$/;
const REDDIT_AFTER_RE = /^(?:t[1-9]_)?[A-Za-z0-9]{3,20}$/;
const REDDIT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_]{2,20}$/;

/** Reddit actions that only exist behind an authenticated session. */
const REDDIT_AUTH_REQUIRED_ACTIONS: ReadonlySet<SocialRequest['action']> = new Set(['get_feed', 'get_saved']);

// Closed per-command option vocabularies: only these upstream values pass through.
const OPENCLI_SEARCH_SORTS = new Set(['relevance', 'hot', 'top', 'new', 'comments']);
const OPENCLI_COMMUNITY_SORTS = new Set(['hot', 'new', 'top', 'rising']);
const RDT_SEARCH_SORTS = new Set(['relevance', 'hot', 'top', 'new', 'comments']);
const RDT_SUB_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial', 'best']);
const NATIVE_COMMUNITY_SORTS = new Set(['hot', 'new', 'top', 'rising', 'controversial']);

// ── Capability declarations (single source per backend) ──

function op(
  action: BackendActionCapability['action'],
  upstreamAction: string[],
  auth: SocialAuthTier[],
  pagination: BackendActionCapability['pagination'],
): BackendActionCapability {
  return { action, upstreamAction, auth, pagination, required: [], maxLimit: 100 };
}

export const REDDIT_BACKEND_CAPABILITIES: readonly BackendCapability[] = [
  {
    name: 'OpenCLI',
    type: 'external',
    command: 'opencli',
    verifiedVersion: '1.8.6',
    operations: [
      op('search', ['reddit search'], ['anonymous'], 'none'),
      op('get_post', ['reddit read'], ['anonymous'], 'none'),
      op('get_thread', ['reddit read'], ['anonymous'], 'none'),
      op('get_comments', ['reddit read'], ['anonymous'], 'none'),
      op('get_profile', ['reddit user'], ['anonymous'], 'none'),
      op('get_user_posts', ['reddit user-posts'], ['anonymous'], 'none'),
      op('get_user_comments', ['reddit user-comments'], ['anonymous'], 'none'),
      op('get_feed', ['reddit home'], ['cookie'], 'none'),
      op('get_saved', ['reddit saved'], ['cookie'], 'none'),
      op('get_trending', ['reddit hot', 'reddit popular'], ['anonymous'], 'none'),
      op('get_community', ['reddit subreddit-info'], ['anonymous'], 'none'),
      op('get_community_posts', ['reddit subreddit'], ['anonymous'], 'none'),
    ],
  },
  {
    name: 'rdt-cli',
    type: 'external',
    command: 'rdt',
    verifiedVersion: '0.4.2',
    operations: [
      op('search', ['rdt search'], ['anonymous'], 'cursor'),
      op('get_post', ['rdt read'], ['anonymous'], 'none'),
      op('get_thread', ['rdt read'], ['anonymous'], 'none'),
      op('get_comments', ['rdt read'], ['anonymous'], 'none'),
      op('get_profile', ['rdt user'], ['anonymous'], 'none'),
      op('get_user_posts', ['rdt user-posts'], ['anonymous'], 'cursor'),
      op('get_user_comments', ['rdt user-comments'], ['anonymous'], 'cursor'),
      op('get_feed', ['rdt feed', 'rdt all'], ['cookie'], 'cursor'),
      op('get_saved', ['rdt saved'], ['cookie'], 'cursor'),
      op('get_trending', ['rdt popular'], ['anonymous'], 'cursor'),
      op('get_community', ['rdt sub-info'], ['anonymous'], 'none'),
      op('get_community_posts', ['rdt sub'], ['anonymous'], 'cursor'),
    ],
  },
  {
    name: 'reddit-cookie',
    type: 'native',
    operations: [
      op('search', ['/search.json'], ['cookie'], 'cursor'),
      op('get_post', ['/api/info.json'], ['cookie'], 'none'),
      op('get_thread', ['/comments/:id.json'], ['cookie'], 'none'),
      op('get_comments', ['/comments/:id.json'], ['cookie'], 'none'),
      op('get_comment_replies', ['/api/info.json + /comments/:id.json'], ['cookie'], 'none'),
      op('get_profile', ['/user/:user/about.json'], ['cookie'], 'none'),
      op('get_user_posts', ['/user/:user/submitted.json'], ['cookie'], 'cursor'),
      op('get_user_comments', ['/user/:user/comments.json'], ['cookie'], 'cursor'),
      op('get_feed', ['/hot.json'], ['cookie'], 'cursor'),
      op('get_saved', ['/api/me.json + /user/:user/saved.json'], ['cookie'], 'cursor'),
      op('get_trending', ['/r/popular.json'], ['cookie'], 'cursor'),
      op('get_community', ['/r/:community/about.json'], ['cookie'], 'none'),
      op('get_community_posts', ['/r/:community/:sort.json'], ['cookie'], 'cursor'),
    ],
  },
  {
    name: 'reddit-oauth',
    type: 'native',
    // Optional API credentials, public actions only (no feed/saved).
    operations: [
      op('search', ['/search.json'], ['api_key'], 'cursor'),
      op('get_post', ['/api/info.json'], ['api_key'], 'none'),
      op('get_thread', ['/comments/:id.json'], ['api_key'], 'none'),
      op('get_comments', ['/comments/:id.json'], ['api_key'], 'none'),
      op('get_comment_replies', ['/api/info.json + /comments/:id.json'], ['api_key'], 'none'),
      op('get_profile', ['/user/:user/about.json'], ['api_key'], 'none'),
      op('get_user_posts', ['/user/:user/submitted.json'], ['api_key'], 'cursor'),
      op('get_user_comments', ['/user/:user/comments.json'], ['api_key'], 'cursor'),
      op('get_trending', ['/r/popular.json'], ['api_key'], 'cursor'),
      op('get_community', ['/r/:community/about.json'], ['api_key'], 'none'),
      op('get_community_posts', ['/r/:community/:sort.json'], ['api_key'], 'cursor'),
    ],
  },
];

// ── Injectable execution surface (tests supply fixtures) ──

export type RedditHttpGet = (
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;

export type RedditCliRunner = (
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal | undefined },
) => Promise<unknown>;

export interface RedditWorkerDeps {
  env?: Record<string, string | undefined>;
  httpGet?: RedditHttpGet;
  requestToken?: (env: Record<string, string | undefined>, signal?: AbortSignal) => Promise<string>;
  runCli?: RedditCliRunner;
}

export function createRedditWorker(deps: RedditWorkerDeps = {}): SocialPlatformWorker {
  const env = deps.env ?? process.env;
  const httpGet = deps.httpGet;
  const requestToken = deps.requestToken;
  const runCli = deps.runCli;
  const defaultRunner: RedditCliRunner = (command, args, options) =>
    runRedditCli(command, args, options, env);

  return {
    platforms: ['reddit'],

    async plans(request, context): Promise<readonly SocialBackendPlan[]> {
      const candidates: SocialBackendPlan[] = [];
      const authRequired = REDDIT_AUTH_REQUIRED_ACTIONS.has(request.action);
      const hasCookie = cookieForRequest(request, env) !== undefined;
      const hasOAuth = hasRedditApiCredentials(env);

      const add: PlanAdder = (build: () => SocialBackendPlan): void => {
        try {
          candidates.push(build());
        } catch (error) {
          // cursor_mismatch for this backend means the cursor was issued for
          // another backend: skip the plan, never switch backends. A bad
          // cursor token is deterministic and propagates. A backend without
          // a declared mapping for the action is simply not a candidate.
          if (error instanceof SocialError && error.code === 'cursor_invalid') throw error;
          if (isSkippablePlanError(error)) return;
          throw error;
        }
      };

      addCookieTier({ add, request, context, authRequired, hasCredential: hasCookie });
      addAnonymousTier({ add, request, context, authRequired, hasCredential: false });
      addApiTier({ add, request, context, authRequired, hasCredential: hasOAuth });

      return candidates;
    },

    normalize(request, plan, payload): SocialPageV1 {
      return normalizeRedditPayload(request, plan, payload);
    },
  };

  interface TierInput {
    add: PlanAdder;
    request: SocialRequest;
    context: SocialExecutionContext;
    authRequired: boolean;
    hasCredential: boolean;
  }

  type PlanAdder = (build: () => SocialBackendPlan) => void;

  function isSkippablePlanError(error: unknown): boolean {
    return error instanceof SocialError && (error.code === 'cursor_mismatch' || error.code === 'unsupported_action');
  }

  function addCookieTier(tier: TierInput): void {
    if (tier.authRequired) {
      tier.add(() => openCliPlan(tier.request, tier.context, 'cookie'));
      tier.add(() => rdtPlan(tier.request, tier.context, 'cookie'));
    }
    if (tier.hasCredential) {
      tier.add(() => nativeCookiePlan(tier.request, tier.context));
    }
  }

  function addAnonymousTier(tier: TierInput): void {
    if (tier.authRequired) return;
    tier.add(() => openCliPlan(tier.request, tier.context, 'anonymous'));
    tier.add(() => rdtPlan(tier.request, tier.context, 'anonymous'));
  }

  function addApiTier(tier: TierInput): void {
    if (tier.authRequired || !tier.hasCredential) return;
    tier.add(() => oauthPlan(tier.request, tier.context));
  }

  function cursorAfterFor(request: SocialRequest, backend: string): string | undefined {
    if (request.cursor === undefined) return undefined;
    const decoded = decodeSocialCursor(request.cursor, {
      platform: 'reddit',
      action: request.action,
      backend,
      fingerprint: socialCursorFingerprint(request),
    });
    const after = decoded.state.after;
    if (typeof after !== 'string' || !REDDIT_AFTER_RE.test(after)) {
      throw new SocialError('cursor_invalid', 'cursor state.after failed Reddit continuation-token validation', { platform: 'reddit', backend });
    }
    return after;
  }

  function openCliPlan(request: SocialRequest, context: SocialExecutionContext, tier: SocialAuthTier): SocialBackendPlan {
    const after = cursorAfterFor(request, 'OpenCLI');
    if (after !== undefined) {
      throw new SocialError('cursor_mismatch', 'OpenCLI Reddit operations do not expose continuation tokens', { platform: 'reddit', backend: 'OpenCLI' });
    }
    const args = openCliArgs(request);
    return {
      backend: 'OpenCLI',
      authTier: tier,
      pagination: 'none',
      async execute(signal) {
        const runner = runCli ?? defaultRunner;
        const effective = signal ?? context.signal;
        return runner('opencli', args, { signal: effective });
      },
    };
  }

  function rdtPlan(request: SocialRequest, context: SocialExecutionContext, tier: SocialAuthTier): SocialBackendPlan {
    const after = cursorAfterFor(request, 'rdt-cli');
    const args = rdtArgs(request, after);
    return {
      backend: 'rdt-cli',
      authTier: tier,
      pagination: 'cursor',
      async execute(signal) {
        const runner = runCli ?? defaultRunner;
        const effective = signal ?? context.signal;
        return runner('rdt', args, { signal: effective });
      },
    };
  }

  function nativeCookiePlan(request: SocialRequest, context: SocialExecutionContext): SocialBackendPlan {
    const after = cursorAfterFor(request, 'reddit-cookie');
    return {
      backend: 'reddit-cookie',
      authTier: 'cookie',
      pagination: 'cursor',
      async execute(signal) {
        const cookie = cookieForRequest(request, env);
        if (cookie === undefined) {
          throw new SocialError('authentication_required', 'no Reddit session cookie is available for this request', { platform: 'reddit', backend: 'reddit-cookie' });
        }
        return nativeExecute(request, {
          after,
          signal: signal ?? context.signal,
          headers: {
            Cookie: cookie,
            'User-Agent': env.REDDIT_USER_AGENT?.trim() ?? USER_AGENT,
          },
        });
      },
    };
  }

  function oauthPlan(request: SocialRequest, context: SocialExecutionContext): SocialBackendPlan {
    const after = cursorAfterFor(request, 'reddit-oauth');
    return {
      backend: 'reddit-oauth',
      authTier: 'api_key',
      pagination: 'cursor',
      async execute(signal) {
        const effectiveSignal = signal ?? context.signal;
        const token = requestToken !== undefined
          ? await requestToken(env, effectiveSignal)
          : await getRedditToken(env, effectiveSignal);
        return nativeExecute(request, {
          after,
          signal: effectiveSignal,
          headers: {
            Authorization: `Bearer ${token}`,
            'User-Agent': env.REDDIT_USER_AGENT?.trim() ?? USER_AGENT,
          },
          base: REDDIT_OAUTH_BASE,
        });
      },
    };
  }

  interface NativeExecuteOptions {
    after: string | undefined;
    signal: AbortSignal | undefined;
    headers: Record<string, string>;
    base?: string | undefined;
  }

  async function nativeSavedListing(
    request: SocialRequest,
    get: (path: string, params: Record<string, string>) => Promise<unknown>,
    after: string | undefined,
  ): Promise<unknown> {
    const me = await get('/api/me.json', {});
    const name = aboutRowName(me);
    if (name === undefined) {
      throw new SocialError('authentication_required', 'could not resolve the authenticated Reddit user for the saved listing', { platform: 'reddit', backend: 'reddit-cookie' });
    }
    return get(`/user/${encodeURIComponent(name)}/saved.json`, listingParams(request, {}, after));
  }

  async function nativeExecute(request: SocialRequest, options: NativeExecuteOptions): Promise<unknown> {
    const base = options.base ?? REDDIT_WWW_BASE;
    const get = (path: string, params: Record<string, string>): Promise<unknown> =>
      fetchJsonNative(`${base}${path}?${new URLSearchParams(params).toString()}`, options.headers, options.signal, httpGet);

    if (request.action === 'get_saved') {
      return nativeSavedListing(request, get, options.after);
    }
    if (request.action === 'get_comment_replies') {
      return nativeCommentReplies(request, get);
    }
    const { path, params } = nativeEndpoint(request);
    return get(path, listingParams(request, params, options.after));
  }

  async function nativeCommentReplies(
    request: SocialRequest,
    get: (path: string, params: Record<string, string>) => Promise<unknown>,
  ): Promise<unknown> {
    const commentId = stripFullname(requireCommentIdPublic(request), 't1');
    const info = await get('/api/info.json', { id: `t1_${commentId}` });
    const row = listingRow(info, 0);
    const linkId = typeof row?.link_id === 'string' ? row.link_id : undefined;
    if (linkId === undefined || !REDDIT_ID_RE.test(linkId)) {
      throw new SocialError('not_found', `comment ${commentId} not found`, { platform: 'reddit', backend: 'reddit-cookie' });
    }
    const thread = await get(`/comments/${encodeURIComponent(stripFullname(linkId, 't3'))}.json`, {
      comment: commentId,
      limit: String(request.limit),
    });
    // Thread payload is [postListing, commentListing]; the subtree rooted at
    // the requested comment lives in the second listing.
    const threadListings = Array.isArray(thread) ? thread : [];
    return listingChildren(threadListings[1] ?? []);
  }
}

// ── Credentials ──

function hasRedditApiCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.REDDIT_CLIENT_ID?.trim() && env.REDDIT_CLIENT_SECRET?.trim() && env.REDDIT_USER_AGENT?.trim());
}

function directCookieHeader(env: Record<string, string | undefined>): string | undefined {
  if (typeof env.REDDIT_COOKIE === 'string' && env.REDDIT_COOKIE.trim().length > 0) return env.REDDIT_COOKIE.trim();
  return undefined;
}

/**
 * Cookie for the fixed canonical Reddit host. A raw user-provided
 * REDDIT_COOKIE travels untouched; stored cookies are matched per-request by
 * exact host/path/expiry/secure inside the cookie jar.
 */
function cookieForRequest(request: SocialRequest, env: Record<string, string | undefined>): string | undefined {
  const direct = directCookieHeader(env);
  if (direct !== undefined) return direct;
  try {
    const { path, params } = nativeEndpoint(request);
    return cookieHeaderForUrl('reddit', `${REDDIT_WWW_BASE}${path}?${new URLSearchParams(params).toString()}`, env);
  } catch {
    return undefined;
  }
}

// OAuth token cache: keyed by a digest of the credential triple (never the
// values), bounded lifetime, never surfaced in output. Module-level per process.
let redditTokenCache: { keyDigest: string; value: string; expiresAt: number } | undefined;

interface RedditOAuthCredentials {
  clientId: string;
  clientSecret: string;
  userAgent: string;
}

function hasOAuthParts(parts: readonly (string | undefined)[]): parts is readonly [string, string, string] {
  return parts.every((part) => part !== undefined && part.length > 0);
}

function redditOAuthCredentials(env: Record<string, string | undefined>): RedditOAuthCredentials {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  const userAgent = env.REDDIT_USER_AGENT?.trim();
  const parts = [clientId, clientSecret, userAgent];
  if (!hasOAuthParts(parts)) {
    throw new SocialError('authentication_required', 'Reddit OAuth requires REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT', { platform: 'reddit', backend: 'reddit-oauth' });
  }
  const [validId, validSecret, validAgent] = parts;
  return { clientId: validId, clientSecret: validSecret, userAgent: validAgent };
}

function cachedTokenValue(cached: { keyDigest: string; value: string; expiresAt: number } | undefined, keyDigest: string): string | undefined {
  if (cached === undefined) return undefined;
  if (cached.keyDigest !== keyDigest) return undefined;
  if (Date.now() >= cached.expiresAt) return undefined;
  return cached.value;
}

function redditTokenCacheHit(keyDigest: string): string | undefined {
  return cachedTokenValue(redditTokenCache, keyDigest);
}

async function postRedditTokenRequest(credentials: RedditOAuthCredentials, signal?: AbortSignal): Promise<Response> {
  return fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': credentials.userAgent,
    },
    body: 'grant_type=client_credentials',
    // Bearer/basic credentials never follow redirects.
    redirect: 'manual',
    signal: signal ?? null,
  });
}

async function parseRedditTokenBody(response: Response): Promise<{ token: string; expiresIn: number }> {
  let parsed: { access_token?: unknown; expires_in?: unknown };
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch (error) {
    throw new SocialError('malformed_upstream', 'Reddit token response is not valid JSON', { platform: 'reddit', backend: 'reddit-oauth', cause: error });
  }
  if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
    throw new SocialError('malformed_upstream', 'Reddit token response missing access_token', { platform: 'reddit', backend: 'reddit-oauth' });
  }
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  return { token: parsed.access_token, expiresIn };
}

async function getRedditToken(env: Record<string, string | undefined>, signal?: AbortSignal): Promise<string> {
  const credentials = redditOAuthCredentials(env);
  const keyDigest = createHash('sha256').update(`${credentials.clientId}\n${credentials.clientSecret}\n${credentials.userAgent}`).digest('hex');
  const hit = redditTokenCacheHit(keyDigest);
  if (hit !== undefined) return hit;
  const response = await postRedditTokenRequest(credentials, signal);
  if (!response.ok) {
    throw new SocialError('authentication_required', `Reddit token request failed with status ${response.status}`, { platform: 'reddit', backend: 'reddit-oauth' });
  }
  const { token, expiresIn } = await parseRedditTokenBody(response);
  redditTokenCache = { keyDigest, value: token, expiresAt: Date.now() + Math.min(expiresIn, 3600) * 1000 - 60_000 };
  return token;
}

// ── Native endpoints (fixed first-party hosts, closed mappings) ──

interface NativeRoute {
  path: string;
  params: Record<string, string>;
}

type NativeRouteBuilder = (request: SocialRequest) => NativeRoute;

function nativeSearchRoute(request: SocialRequest): NativeRoute {
  const params: Record<string, string> = { q: requireQuery(request), sort: request.sort ?? 'relevance', type: 'link', limit: String(request.limit) };
  return { path: '/search.json', params };
}

function nativePostRoute(request: SocialRequest): NativeRoute {
  return { path: '/api/info.json', params: { id: withFullname(requirePostId(request), 't3') } };
}

function nativeThreadRoute(request: SocialRequest): NativeRoute {
  const params: Record<string, string> = { limit: String(request.limit) };
  if (request.includeReplies === false) params.depth = '1';
  return { path: `/comments/${encodeURIComponent(stripFullname(requirePostId(request), 't3'))}.json`, params };
}

function nativeCommentLookupRoute(request: SocialRequest): NativeRoute {
  return { path: '/api/info.json', params: { id: `t1_${stripFullname(requireCommentIdPublic(request), 't1')}` } };
}

function nativeProfileRoute(request: SocialRequest): NativeRoute {
  return { path: `/user/${encodeURIComponent(requireUser(request))}/about.json`, params: {} };
}

function nativeUserListingRoute(request: SocialRequest, leaf: 'submitted.json' | 'comments.json'): NativeRoute {
  return { path: `/user/${encodeURIComponent(requireUser(request))}/${leaf}`, params: { limit: String(request.limit) } };
}

function nativeFeedRoute(request: SocialRequest): NativeRoute {
  if (request.feedVariant === 'popular') return { path: '/r/popular.json', params: {} };
  if (request.feedVariant === 'all') return { path: '/r/all/hot.json', params: {} };
  return { path: '/hot.json', params: {} };
}

function nativeTrendingRoute(request: SocialRequest): NativeRoute {
  if (request.feedVariant === 'hot') return { path: '/hot.json', params: {} };
  return { path: '/r/popular.json', params: {} };
}

function nativeCommunityRoute(request: SocialRequest): NativeRoute {
  return { path: `/r/${encodeURIComponent(requireCommunity(request))}/about.json`, params: {} };
}

function nativeCommunityPostsRoute(request: SocialRequest): NativeRoute {
  const sort = request.sort !== undefined && NATIVE_COMMUNITY_SORTS.has(request.sort) ? request.sort : 'hot';
  return { path: `/r/${encodeURIComponent(requireCommunity(request))}/${sort}.json`, params: {} };
}

const NATIVE_ROUTES: Partial<Record<SocialRequest['action'], NativeRouteBuilder>> = {
  search: nativeSearchRoute,
  get_post: nativePostRoute,
  get_thread: nativeThreadRoute,
  get_comments: nativeThreadRoute,
  get_comment_replies: nativeCommentLookupRoute,
  get_profile: nativeProfileRoute,
  get_user_posts: (request) => nativeUserListingRoute(request, 'submitted.json'),
  get_user_comments: (request) => nativeUserListingRoute(request, 'comments.json'),
  get_feed: nativeFeedRoute,
  get_trending: nativeTrendingRoute,
  get_saved: () => ({ path: '/api/me.json', params: {} }),
  get_community: nativeCommunityRoute,
  get_community_posts: nativeCommunityPostsRoute,
};

function nativeEndpoint(request: SocialRequest): { path: string; params: Record<string, string> } {
  const builder = NATIVE_ROUTES[request.action];
  if (builder === undefined) {
    throw new SocialError('unsupported_action', `Reddit native HTTP has no endpoint for ${request.action}`, { platform: 'reddit' });
  }
  return builder(request);
}

function listingParams(request: SocialRequest, params: Record<string, string>, after: string | undefined): Record<string, string> {
  const merged: Record<string, string> = { ...params, limit: String(request.limit) };
  if (after !== undefined) merged.after = after;
  return merged;
}

function throwForNativeStatus(response: Response): void {
  if (response.status >= 300 && response.status < 400) {
    throw new SocialError('upstream_error', `redirect rejected (${response.status}); Reddit cookie/token requests never follow redirects`, { platform: 'reddit' });
  }
  const statusError = nativeStatusError(response.status);
  if (statusError !== undefined) throw statusError;
  if (!response.ok) {
    throw new SocialError('upstream_error', `Reddit returned ${response.status}`, { platform: 'reddit' });
  }
}

function nativeStatusError(status: number): SocialError | undefined {
  if (status === 401) return new SocialError('authentication_required', `Reddit returned ${status}`, { platform: 'reddit' });
  if (status === 403) return new SocialError('permission_denied', `Reddit returned ${status}`, { platform: 'reddit' });
  if (status === 404) return new SocialError('not_found', 'Reddit returned 404', { platform: 'reddit' });
  if (status === 429) return new SocialError('rate_limited', 'Reddit rate limit reached', { platform: 'reddit' });
  return undefined;
}

async function parseNativeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new SocialError('malformed_upstream', 'Reddit response is not valid JSON', { platform: 'reddit', cause: error });
  }
}

async function fetchJsonNative(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  injected?: RedditHttpGet,
): Promise<unknown> {
  if (injected !== undefined) return injected(url, headers, signal);
  const response = await fetch(url, { headers, redirect: 'manual', signal: signal ?? null });
  throwForNativeStatus(response);
  return parseNativeJson(response);
}

// ── Selector guards (defense in depth; the contract validates first) ──

function requireQuery(request: SocialRequest): string {
  if (typeof request.query !== 'string' || request.query.length === 0) {
    throw new SocialError('invalid_request', 'query is required', { platform: 'reddit' });
  }
  return request.query;
}

function requirePostId(request: SocialRequest): string {
  const value = request.postId;
  if (typeof value !== 'string' || !REDDIT_ID_RE.test(value)) {
    throw new SocialError('invalid_request', 'postId is missing or not a valid Reddit post id', { platform: 'reddit' });
  }
  return value;
}

function requireCommentIdPublic(request: SocialRequest): string {
  const value = request.commentId;
  if (typeof value !== 'string' || !REDDIT_ID_RE.test(value)) {
    throw new SocialError('invalid_request', 'commentId is missing or not a valid Reddit comment id', { platform: 'reddit' });
  }
  return value;
}

function requireUser(request: SocialRequest): string {
  const value = request.user;
  if (typeof value !== 'string' || !REDDIT_NAME_RE.test(value)) {
    throw new SocialError('invalid_request', 'user is missing or not a valid Reddit username', { platform: 'reddit' });
  }
  return value;
}

function requireCommunity(request: SocialRequest): string {
  const value = request.community;
  if (typeof value !== 'string' || !REDDIT_NAME_RE.test(value)) {
    throw new SocialError('invalid_request', 'community is missing or not a valid subreddit name', { platform: 'reddit' });
  }
  return value;
}

// ── CLI argv (closed mappings only) ──

type CliArgBuilder = (request: SocialRequest, n: string) => string[];

function openCliSearchArgs(request: SocialRequest, n: string): string[] {
  const args = ['reddit', 'search', requireCliPositional(requireQuery(request), 'query', 'reddit'), '--limit', n];
  if (request.sort !== undefined && OPENCLI_SEARCH_SORTS.has(request.sort)) args.push('--sort', request.sort);
  if (request.timeRange !== undefined) args.push('--time', request.timeRange);
  return [...args, '-f', 'json'];
}

function openCliThreadArgs(request: SocialRequest, n: string): string[] {
  return [
    'reddit', 'read', stripFullname(requirePostId(request), 't3'),
    '--limit', n,
    ...(request.includeReplies === false ? ['--depth', '1'] : []),
    '-f', 'json',
  ];
}

function openCliThreadNoDepthArgs(request: SocialRequest, n: string): string[] {
  return ['reddit', 'read', stripFullname(requirePostId(request), 't3'), '--limit', n, '-f', 'json'];
}

function openCliTrendingArgs(request: SocialRequest, n: string): string[] {
  if (request.feedVariant === 'hot') return ['reddit', 'hot', '--limit', n, '-f', 'json'];
  return ['reddit', 'popular', '--limit', n, '-f', 'json'];
}

function openCliCommunityPostsArgs(request: SocialRequest, n: string): string[] {
  return [
    'reddit', 'subreddit', requireCommunity(request),
    '--limit', n,
    ...(request.sort !== undefined && OPENCLI_COMMUNITY_SORTS.has(request.sort) ? ['--sort', request.sort] : []),
    '-f', 'json',
  ];
}

const OPENCLI_ARG_BUILDERS: Partial<Record<SocialRequest['action'], CliArgBuilder>> = {
  search: openCliSearchArgs,
  get_post: (request) => ['reddit', 'read', stripFullname(requirePostId(request), 't3'), '--limit', '1', '-f', 'json'],
  get_thread: openCliThreadArgs,
  get_comments: openCliThreadNoDepthArgs,
  get_profile: (request) => ['reddit', 'user', requireUser(request), '-f', 'json'],
  get_user_posts: (request, n) => ['reddit', 'user-posts', requireUser(request), '--limit', n, '-f', 'json'],
  get_user_comments: (request, n) => ['reddit', 'user-comments', requireUser(request), '--limit', n, '-f', 'json'],
  get_feed: (_request, n) => ['reddit', 'home', '--limit', n, '-f', 'json'],
  get_saved: (_request, n) => ['reddit', 'saved', '--limit', n, '-f', 'json'],
  get_trending: openCliTrendingArgs,
  get_community: (request) => ['reddit', 'subreddit-info', requireCommunity(request), '-f', 'json'],
  get_community_posts: openCliCommunityPostsArgs,
};

function openCliArgs(request: SocialRequest): string[] {
  const builder = OPENCLI_ARG_BUILDERS[request.action];
  if (builder === undefined) {
    throw new SocialError('unsupported_action', `OpenCLI has no Reddit mapping for ${request.action}`, { platform: 'reddit', backend: 'OpenCLI' });
  }
  return builder(request, String(request.limit));
}

interface RdtArgContext {
  n: string;
  afterArgs: string[];
}

type RdtArgBuilder = (request: SocialRequest, ctx: RdtArgContext) => string[];

function rdtSearchArgs(request: SocialRequest, ctx: RdtArgContext): string[] {
  const args = ['search', requireCliPositional(requireQuery(request), 'query', 'reddit'), '-n', ctx.n];
  if (request.community !== undefined && REDDIT_NAME_RE.test(request.community)) args.push('-r', request.community);
  if (request.sort !== undefined && RDT_SEARCH_SORTS.has(request.sort)) args.push('-s', request.sort);
  if (request.timeRange !== undefined) args.push('-t', request.timeRange);
  return [...args, ...ctx.afterArgs, '--json'];
}

function rdtReadArgs(request: SocialRequest, ctx: RdtArgContext): string[] {
  return ['read', stripFullname(requirePostId(request), 't3'), '-n', ctx.n, '--json'];
}

function rdtFeedArgs(request: SocialRequest, ctx: RdtArgContext): string[] {
  if (request.feedVariant === 'all') return ['all', '-n', ctx.n, ...ctx.afterArgs, '--json'];
  return ['feed', '-n', ctx.n, ...ctx.afterArgs, '--json'];
}

function rdtCommunityPostsArgs(request: SocialRequest, ctx: RdtArgContext): string[] {
  return [
    'sub', requireCommunity(request), '-n', ctx.n,
    ...(request.sort !== undefined && RDT_SUB_SORTS.has(request.sort) ? ['-s', request.sort] : []),
    ...ctx.afterArgs, '--json',
  ];
}

const RDT_ARG_BUILDERS: Partial<Record<SocialRequest['action'], RdtArgBuilder>> = {
  search: rdtSearchArgs,
  get_post: (request) => ['read', stripFullname(requirePostId(request), 't3'), '-n', '1', '--json'],
  get_thread: rdtReadArgs,
  get_comments: rdtReadArgs,
  get_profile: (request) => ['user', requireUser(request), '--json'],
  get_user_posts: (request, ctx) => ['user-posts', requireUser(request), '-n', ctx.n, ...ctx.afterArgs, '--json'],
  get_user_comments: (request, ctx) => ['user-comments', requireUser(request), '-n', ctx.n, ...ctx.afterArgs, '--json'],
  get_feed: rdtFeedArgs,
  get_saved: (_request, ctx) => ['saved', '-n', ctx.n, ...ctx.afterArgs, '--json'],
  get_trending: (_request, ctx) => ['popular', '-n', ctx.n, ...ctx.afterArgs, '--json'],
  get_community: (request) => ['sub-info', requireCommunity(request), '--json'],
  get_community_posts: rdtCommunityPostsArgs,
};

function rdtArgs(request: SocialRequest, after: string | undefined): string[] {
  const builder = RDT_ARG_BUILDERS[request.action];
  if (builder === undefined) {
    throw new SocialError('unsupported_action', `rdt-cli has no Reddit mapping for ${request.action}`, { platform: 'reddit', backend: 'rdt-cli' });
  }
  return builder(request, { n: String(request.limit), afterArgs: after !== undefined ? ['--after', after] : [] });
}

// ── CLI runner ──

/**
 * Resolve the sanitized child environment for a Reddit subprocess. Commands
 * starting with 'opencli' (Node CLI) get openCliChildEnv so operator-owned
 * OPENCLI_HOST/PORT/TOKEN pass through; Python 'rdt' keeps
 * buildPythonChildEnvironment and must never see secret-bearing env vars.
 */
export function resolveRedditChildEnv(
  command: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (command.startsWith('opencli')) return openCliChildEnv(source);
  return buildPythonChildEnvironment(source);
}

/**
 * Shared social CLI runner. Splits the sanitized child environment by command
 * (opencli → openCliChildEnv; rdt → buildPythonChildEnvironment). Output is
 * bounded; abort kills the child and never falls through.
 */
export async function runRedditCli(
  command: string,
  args: readonly string[],
  options: { signal?: AbortSignal | undefined },
  envSource?: Record<string, string | undefined>,
): Promise<unknown> {
  const result = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    // Portable spawn: .cmd/.bat shims run via cmd.exe with pre-quoted argv
    // (shell:false cannot execute them — spawn EINVAL); see cli-command.ts.
    const child = spawnCliCommand(command, args, {
      env: resolveRedditChildEnv(command, envSource),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let timedOut = false;

    const terminate = (): void => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, CLI_TIMEOUT_MS);

    const abortListener = (): void => {
      terminate();
      settle(() => reject(abortError()));
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT_CHARS) terminate();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > MAX_OUTPUT_CHARS) terminate();
    });
    child.on('error', (error) => {
      settle(() => reject(new SocialError('backend_unavailable', `${command} could not be executed: ${error.message}`, { platform: 'reddit', backend: backendNameForCommand(command), cause: error })));
    });
    child.on('close', (code) => {
      if (timedOut) {
        settle(() => reject(new SocialError('backend_unavailable', `${command} timed out after ${CLI_TIMEOUT_MS}ms`, { platform: 'reddit', backend: backendNameForCommand(command) })));
        return;
      }
      settle(() => resolve({ stdout, stderr, code: code ?? -1 }));
    });

    function settle(fn: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer !== undefined) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abortListener);
      fn();
    }
  });

  if (result.code !== 0) {
    throw new SocialError('backend_unavailable', `${command} exited with code ${result.code}`, { platform: 'reddit', backend: backendNameForCommand(command) });
  }
  try {
    return JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new SocialError('malformed_upstream', `${command} did not return valid JSON output`, { platform: 'reddit', backend: backendNameForCommand(command), cause: error });
  }
}

function backendNameForCommand(command: string): string {
  return command === 'rdt' ? 'rdt-cli' : command === 'opencli' ? 'OpenCLI' : command;
}

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// ── Payload shapes ──

function stripFullname(value: string, prefix: string): string {
  return value.startsWith(`${prefix}_`) ? value.slice(prefix.length + 1) : value;
}

function withFullname(value: string, prefix: string): string {
  return value.startsWith(`${prefix}_`) ? value : `${prefix}_${value}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ListingExtraction {
  children: unknown[];
  after?: string | undefined;
}

/**
 * Extract listing children and continuation token from any verified Reddit
 * listing shape: raw `{data:{children,after}}`, rdt `{ok,data:{kind:'Listing',
 * data:{...}}}`, or a native thread array `[postListing, commentListing]`.
 * Unknown shapes fail closed.
 */
function rawListingShape(payload: Record<string, unknown>): ListingExtraction | undefined {
  if (!isRecord(payload.data)) return undefined;
  const data = payload.data as { children?: unknown; after?: unknown };
  if (!Array.isArray(data.children)) return undefined;
  return withAfter(data.children, data.after);
}

function nestedRdtListingShape(payload: Record<string, unknown>): ListingExtraction | undefined {
  if (!isRecord(payload.data)) return undefined;
  const inner = (payload.data as Record<string, unknown>).data;
  if (!isRecord(inner)) return undefined;
  const nested = inner as unknown as { children?: unknown; after?: unknown };
  if (!Array.isArray(nested.children)) return undefined;
  return withAfter(nested.children, nested.after);
}

function extractListing(payload: unknown): ListingExtraction {
  if (Array.isArray(payload)) {
    return { children: payload };
  }
  if (isRecord(payload)) {
    const direct = rawListingShape(payload) ?? nestedRdtListingShape(payload);
    if (direct !== undefined) return direct;
  }
  throw new SocialError('malformed_upstream', 'payload is not a recognizable Reddit listing', { platform: 'reddit' });
}

function withAfter(children: unknown[], after: unknown): ListingExtraction {
  return { children, after: typeof after === 'string' && after.length > 0 ? after : undefined };
}

function listingChildren(payload: unknown): unknown[] {
  return extractListing(payload).children;
}

function childRow(child: unknown): Record<string, unknown> | undefined {
  const row = isRecord(child) && isRecord((child as Record<string, unknown>).data) ? (child as Record<string, unknown>).data : child;
  return isRecord(row) ? row : undefined;
}

/**
 * Row `index` from a listing payload. When the payload is a native thread
 * array (`[postListing, commentsListing]`), `payload[index]` is itself a
 * listing and its first child is returned.
 */
function listingRow(payload: unknown, index: number): Record<string, unknown> | undefined {
  const children = Array.isArray(payload)
    ? (payload[index] !== undefined ? listingChildren(payload[index]) : [])
    : listingChildren(payload);
  return childRow(children[index]);
}

/**
 * Resolve the post row of a post-detail payload. A listing-shaped payload
 * with zero children is a deterministic miss (not_found); an unknown shape
 * stays malformed_upstream so the integrator can try the next plan.
 */
function isBenignEmptyListing(error: unknown, payload: unknown): boolean {
  return error instanceof SocialError && error.code === 'malformed_upstream' && isEmptyListing(payload);
}

function postOrNotFound(payload: unknown, backend: string): Record<string, unknown> {
  try {
    return postDetailPayload(payload).post;
  } catch (error) {
    if (isBenignEmptyListing(error, payload)) {
      throw new SocialError('not_found', 'post not found', { platform: 'reddit', backend });
    }
    throw error;
  }
}

function isEmptyListing(payload: unknown): boolean {
  try {
    return listingChildren(payload).length === 0;
  } catch {
    return false;
  }
}

function readEnvelopeDetail(payload: Record<string, unknown>): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  // rdt / OpenCLI read envelope: {ok, data:{post:{...}, comments:[...]}}
  if (!isRecord(payload.data)) return undefined;
  const data = payload.data as Record<string, unknown>;
  if (!isRecord(data.post)) return undefined;
  return { post: data.post as Record<string, unknown>, comments: Array.isArray(data.comments) ? data.comments : [] };
}

function nativeThreadDetail(payload: unknown[]): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  // Native thread payload: [postListing, commentsListing].
  if (payload.length < 1) return undefined;
  const post = listingRow(payload[0], 0);
  if (post === undefined) return undefined;
  return { post, comments: payload.length >= 2 ? extractListing(payload[1]).children : [] };
}

function infoListingDetail(payload: Record<string, unknown>): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  // Single post wrapped in a listing (/api/info.json).
  const post = listingRow(payload, 0);
  if (post === undefined) return undefined;
  return { post, comments: [] };
}

function envelopeDetailFromRecord(payload: unknown): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  if (!isRecord(payload)) return undefined;
  return readEnvelopeDetail(payload);
}

function threadDetailFromArray(payload: unknown): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  if (!Array.isArray(payload)) return undefined;
  return nativeThreadDetail(payload);
}

function singleDetailFromRecord(payload: unknown): { post: Record<string, unknown>; comments: unknown[] } | undefined {
  if (!isRecord(payload)) return undefined;
  return infoListingDetail(payload);
}

function postDetailPayload(payload: unknown): { post: Record<string, unknown>; comments: unknown[] } {
  const envelope = envelopeDetailFromRecord(payload);
  if (envelope !== undefined) return envelope;
  const thread = threadDetailFromArray(payload);
  if (thread !== undefined) return thread;
  const single = singleDetailFromRecord(payload);
  if (single !== undefined) return single;
  throw new SocialError('malformed_upstream', 'payload is not a recognizable Reddit post detail', { platform: 'reddit' });
}

function aboutRowName(payload: unknown): string | undefined {
  try {
    const row = aboutRow(payload);
    return typeof row.name === 'string' && row.name.length > 0 ? row.name : undefined;
  } catch {
    return undefined;
  }
}

function hasAboutName(row: Record<string, unknown>): boolean {
  return row.name !== undefined || row.display_name !== undefined;
}

function isAboutPayload(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && hasAboutName(payload);
}

function isAboutDataPayload(payload: unknown): payload is Record<string, unknown> {
  return isRecord(payload) && isRecord(payload.data) && hasAboutName(payload.data as Record<string, unknown>);
}

function aboutRow(payload: unknown): Record<string, unknown> {
  if (isAboutDataPayload(payload)) {
    return payload.data as Record<string, unknown>;
  }
  if (isAboutPayload(payload)) return payload;
  throw new SocialError('malformed_upstream', 'payload is not a recognizable Reddit about row', { platform: 'reddit' });
}

// ── Normalization ──

function detailPostPage(request: SocialRequest, plan: SocialBackendPlan, payload: unknown, warnings: string[]): SocialPageV1 {
  const post = postOrNotFound(payload, plan.backend);
  const entity = normalizePostRow(post, plan.backend, warnings);
  if (entity === undefined) {
    throw new SocialError('not_found', 'post not found', { platform: 'reddit', backend: plan.backend });
  }
  return page([entity], warnings, warnings.length > 0, noPagination(request));
}

function detailThreadPage(request: SocialRequest, plan: SocialBackendPlan, payload: unknown, warnings: string[]): SocialPageV1 {
  const { comments } = postDetailPayload(payload);
  const post = postOrNotFound(payload, plan.backend);
  const root = normalizePostRow(post, plan.backend, warnings);
  if (root === undefined) {
    throw new SocialError('not_found', 'post not found', { platform: 'reddit', backend: plan.backend });
  }
  // Completeness: root post first, then comments in source structural order.
  // The forest walk caps normalization at limit-1 so the bounded page below
  // holds root + at most limit-1 comments; anything beyond is counted, not built.
  const { entities, dropped, truncated } = flattenCommentForest(comments, {
    backend: plan.backend,
    postId: root.platformId ?? '',
    includeReplies: request.includeReplies !== false,
    warnings,
    limit: Math.max(0, request.limit - 1),
  });
  return boundedDetailPage(request, [root, ...entities], warnings, dropped, truncated);
}

function detailCommentsPage(request: SocialRequest, plan: SocialBackendPlan, payload: unknown, warnings: string[]): SocialPageV1 {
  const { post, comments } = postDetailPayload(payload);
  const postId = postNativeId(post);
  if (postId === undefined) {
    throw new SocialError('not_found', 'post not found for comment listing', { platform: 'reddit', backend: plan.backend });
  }
  const { entities, dropped, truncated } = flattenCommentForest(comments, {
    backend: plan.backend,
    postId,
    includeReplies: request.includeReplies !== false,
    warnings,
    limit: request.limit,
  });
  return boundedDetailPage(request, entities, warnings, dropped, truncated);
}

function detailCommentRepliesPage(request: SocialRequest, plan: SocialBackendPlan, payload: unknown, warnings: string[]): SocialPageV1 {
  const extraction = extractListing(payload);
  if (extraction.children.length === 0) {
    throw new SocialError('not_found', 'comment not found', { platform: 'reddit', backend: plan.backend });
  }
  const rootRow = firstRow(extraction.children);
  const postId = typeof rootRow?.link_id === 'string' ? rootRow.link_id : request.postId ?? '';
  const { entities, dropped, truncated } = flattenCommentForest(extraction.children, {
    backend: plan.backend,
    postId,
    includeReplies: true,
    warnings,
    limit: request.limit,
  });
  return boundedDetailPage(request, entities, warnings, dropped, truncated);
}

function detailAboutPage(request: SocialRequest, plan: SocialBackendPlan, payload: unknown, warnings: string[], kind: 'account' | 'community'): SocialPageV1 {
  const entity = normalizeAbout(aboutRow(payload), kind, plan.backend);
  return page([entity], warnings, false, noPagination(request));
}

function normalizeRedditPayload(request: SocialRequest, plan: SocialBackendPlan, payload: unknown): SocialPageV1 {
  const warnings: string[] = [];

  switch (request.action) {
    case 'get_post':
      return detailPostPage(request, plan, payload, warnings);
    case 'get_thread':
      return detailThreadPage(request, plan, payload, warnings);
    case 'get_comments':
      return detailCommentsPage(request, plan, payload, warnings);
    case 'get_comment_replies':
      return detailCommentRepliesPage(request, plan, payload, warnings);
    case 'get_profile':
      return detailAboutPage(request, plan, payload, warnings, 'account');
    case 'get_community':
      return detailAboutPage(request, plan, payload, warnings, 'community');
    default:
      return normalizeListing(request, plan, payload);
  }
}

function noPagination(request: SocialRequest): SocialPageV1['pagination'] {
  return { supported: false, limit: request.limit, returned: 0, hasMore: false };
}

function page(entities: SocialEntityV1[], warnings: string[], partial: boolean, pagination: SocialPageV1['pagination']): SocialPageV1 {
  return {
    entities,
    pagination: { ...pagination, returned: entities.length },
    partial,
    warnings,
  };
}

function postNativeId(row: Record<string, unknown>): string | undefined {
  if (typeof row.name === 'string' && row.name.length > 0) return row.name;
  if (typeof row.id === 'string' && row.id.length > 0) return `t3_${row.id}`;
  return undefined;
}

function commentNativeId(row: Record<string, unknown>): string | undefined {
  if (typeof row.fullname === 'string' && row.fullname.length > 0) return row.fullname;
  if (typeof row.name === 'string' && row.name.length > 0) return row.name;
  if (typeof row.id === 'string' && row.id.length > 0) return `t1_${row.id}`;
  return undefined;
}

function rowKind(row: Record<string, unknown>): 'post' | 'comment' {
  const name = typeof row.fullname === 'string' ? row.fullname : typeof row.name === 'string' ? row.name : undefined;
  if (name !== undefined) return name.startsWith('t1_') ? 'comment' : 'post';
  // OpenCLI flattened rows are posts; bare comment rows always carry a body.
  if (row.body !== undefined && row.title === undefined) return 'comment';
  return 'post';
}

function firstRow(children: unknown[]): Record<string, unknown> | undefined {
  const child = children[0];
  const row = isRecord(child) && isRecord(child.data) ? child.data : child;
  return isRecord(row) ? row : undefined;
}

function listingRowEntity(child: unknown, backend: string, warnings: string[]): SocialEntityV1 | undefined {
  const row = childRow(child);
  if (row === undefined) {
    warnings.push('dropped malformed listing row');
    return undefined;
  }
  return rowKind(row) === 'comment'
    ? normalizeCommentRow(row, { backend, depth: 0, warnings })
    : normalizePostRow(row, backend, warnings);
}

interface CursorListingInput {
  request: SocialRequest;
  plan: SocialBackendPlan;
  extraction: ListingExtraction;
  entities: SocialEntityV1[];
  warnings: string[];
  dropped: number;
}

function cursorListingPage(input: CursorListingInput): SocialPageV1 {
  const { request, plan, extraction, warnings, dropped } = input;
  let entities = input.entities;
  const after = extraction.after;
  if (after !== undefined && !REDDIT_AFTER_RE.test(after)) {
    throw new SocialError('malformed_upstream', 'upstream continuation token failed validation', { platform: 'reddit', backend: plan.backend });
  }
  const hasMore = after !== undefined;
  // Defensive cap: an oversized upstream page never returns more than limit.
  let capped = 0;
  if (entities.length > request.limit) {
    capped = entities.length - request.limit;
    entities = entities.slice(0, request.limit);
    warnings.push(hasMore ? `truncated ${capped} rows to limit; see nextCursor for the remaining page` : `truncated ${capped} rows to limit; no further page`);
  }
  const nextCursor = hasMore
    ? encodeSocialCursor({
        platform: 'reddit',
        action: request.action,
        backend: plan.backend,
        fingerprint: socialCursorFingerprint(request),
        state: { after },
      })
    : undefined;
  return {
    entities,
    pagination: {
      supported: true,
      limit: request.limit,
      returned: entities.length,
      hasMore,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    },
    partial: dropped > 0 || capped > 0,
    warnings,
  };
}

function truncatedListingPage(request: SocialRequest, entities: SocialEntityV1[], warnings: string[], dropped: number, rawCount: number): SocialPageV1 {
  // Non-pageable backend: known truncation without continuation. Slice to the
  // requested limit first; the truncation signal uses the raw upstream row
  // count (>= keeps the at-limit signal: upstream may hold more rows we
  // cannot page to), not the post-drop entity count.
  const limited = entities.slice(0, request.limit);
  const truncated = rawCount >= request.limit;
  if (truncated) {
    const cut = rawCount - limited.length;
    warnings.push(cut > 0 ? `truncated ${cut} rows to limit; backend exposes no continuation token` : `truncated to limit; backend exposes no continuation token`);
  }
  return {
    entities: limited,
    pagination: { supported: false, limit: request.limit, returned: limited.length, hasMore: false },
    partial: dropped > 0 || truncated,
    warnings,
  };
}

function normalizeListing(request: SocialRequest, plan: SocialBackendPlan, payload: unknown): SocialPageV1 {
  const warnings: string[] = [];
  const extraction = extractListing(payload);
  const entities: SocialEntityV1[] = [];
  let dropped = 0;

  for (const child of extraction.children) {
    const entity = listingRowEntity(child, plan.backend, warnings);
    if (entity === undefined) {
      dropped += 1;
      continue;
    }
    entities.push(entity);
  }

  if (plan.pagination === 'cursor') {
    return cursorListingPage({ request, plan, extraction, entities, warnings, dropped });
  }
  return truncatedListingPage(request, entities, warnings, dropped, extraction.children.length);
}

function resolvePostPermalink(row: Record<string, unknown>): string | undefined {
  if (typeof row.permalink === 'string') return `${REDDIT_WWW_BASE}${row.permalink}`;
  if (typeof row.url === 'string' && row.url.startsWith(`${REDDIT_WWW_BASE}/`)) return row.url;
  return undefined;
}

function postScoreMetrics(row: Record<string, unknown>): { score?: number; comments?: number } {
  const metrics: { score?: number; comments?: number } = {};
  const score = finiteNumber(row.score);
  const numComments = finiteNumber(row.num_comments) ?? finiteNumber(row.comments);
  if (score !== undefined) metrics.score = score;
  if (numComments !== undefined) metrics.comments = numComments;
  return metrics;
}

interface PostOptionalParts {
  row: Record<string, unknown>;
  author: { handle: string } | undefined;
  metrics: { score?: number; comments?: number };
  publishedAt: string | undefined;
  permalink: string | undefined;
}

function postOptionalFields(parts: PostOptionalParts): {
  title?: string;
  text?: string;
  author?: { handle: string };
  communityId?: string;
  url?: string;
  metrics?: { score?: number; comments?: number };
  publishedAt?: string;
} {
  const { row, author, metrics, publishedAt, permalink } = parts;
  return {
    ...(typeof row.title === 'string' && row.title.trim().length > 0 ? { title: row.title } : {}),
    ...(typeof row.selftext === 'string' && row.selftext.trim().length > 0 ? { text: row.selftext } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof row.subreddit === 'string' ? { communityId: row.subreddit.replace(/^r\//, '') } : {}),
    ...(permalink !== undefined ? { url: permalink } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

function buildPostEntity(
  row: Record<string, unknown>,
  backend: string,
  nativeId: string,
): SocialEntityV1 {
  const permalink = resolvePostPermalink(row);
  const author = actorFromRow(row);
  const metrics = postScoreMetrics(row);
  const publishedAt = publishedDate(row);
  return {
    version: 1,
    kind: 'social_post',
    id: socialEntityId('reddit', 'social_post', nativeId),
    platformId: nativeId,
    platform: 'reddit',
    backend,
    contentType: 'post',
    ...postOptionalFields({ row, author, metrics, publishedAt, permalink }),
  };
}

function normalizePostRow(row: Record<string, unknown>, backend: string, warnings: string[]): SocialEntityV1 | undefined {
  const nativeId = postNativeId(row);
  if (nativeId === undefined) {
    warnings.push('dropped post row without id');
    return undefined;
  }
  const entity = buildPostEntity(row, backend, nativeId);
  const validation = validateSocialEntity(entity);
  if (!validation.ok) {
    warnings.push(`dropped invalid post row: ${validation.issues[0]}`);
    return undefined;
  }
  return entity;
}

interface CommentRowContext {
  backend: string;
  depth: number;
  postId?: string | undefined;
  parentCommentId?: string | undefined;
  warnings: string[];
}

function commentBodyText(row: Record<string, unknown>): string | undefined {
  const text = typeof row.body === 'string' ? row.body : undefined;
  if (text === undefined || text.trim().length === 0) return undefined;
  return text;
}

function resolveForestPostId(postId: string | undefined, row: Record<string, unknown>): string | undefined {
  if (postId !== undefined && postId.length > 0) return postId;
  if (typeof row.link_id === 'string') return row.link_id;
  return undefined;
}

function resolveForestParent(parentCommentId: string | undefined, row: Record<string, unknown>): string | undefined {
  if (parentCommentId !== undefined) return parentCommentId;
  if (typeof row.parent_fullname === 'string' && row.parent_fullname.startsWith('t1_')) return row.parent_fullname;
  return undefined;
}

function commentScoreMetrics(row: Record<string, unknown>): { score?: number } {
  const metrics: { score?: number } = {};
  const score = finiteNumber(row.score);
  if (score !== undefined) metrics.score = score;
  return metrics;
}

interface CommentEntityParts {
  row: Record<string, unknown>;
  backend: string;
  nativeId: string;
  text: string;
  postId: string;
  parent: string | undefined;
  depth: number;
  author: { handle: string } | undefined;
  metrics: { score?: number };
  publishedAt: string | undefined;
}

function buildCommentEntity(parts: CommentEntityParts): SocialEntityV1 {
  const { row, backend, nativeId, text, postId, parent, depth, author, metrics, publishedAt } = parts;
  return {
    version: 1,
    kind: 'social_comment',
    id: socialEntityId('reddit', 'social_comment', nativeId),
    platformId: nativeId,
    platform: 'reddit',
    backend,
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    ...(typeof row.permalink === 'string' ? { url: `${REDDIT_WWW_BASE}${row.permalink}` } : {}),
    postId,
    ...(parent !== undefined ? { parentCommentId: parent } : {}),
    ...(depth > 0 ? { depth } : {}),
    text,
    ...(author !== undefined ? { author } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

function normalizeCommentRow(row: Record<string, unknown>, ctx: CommentRowContext): SocialEntityV1 | undefined {
  const nativeId = commentNativeId(row);
  const text = commentBodyText(row);
  if (nativeId === undefined || text === undefined) {
    ctx.warnings.push('dropped malformed comment row');
    return undefined;
  }
  const resolvedPostId = resolveForestPostId(ctx.postId, row);
  if (resolvedPostId === undefined || resolvedPostId.length === 0) {
    ctx.warnings.push('dropped comment row without post reference');
    return undefined;
  }
  const resolvedParent = resolveForestParent(ctx.parentCommentId, row);
  const entity = buildCommentEntity({
    row,
    backend: ctx.backend,
    nativeId,
    text,
    postId: resolvedPostId,
    parent: resolvedParent,
    depth: ctx.depth,
    author: actorFromRow(row),
    metrics: commentScoreMetrics(row),
    publishedAt: publishedDate(row),
  });
  const validation = validateSocialEntity(entity);
  if (!validation.ok) {
    ctx.warnings.push(`dropped invalid comment row: ${validation.issues[0]}`);
    return undefined;
  }
  return entity;
}

/** Bounded detail output: slice to limit, mark truncation truthfully.
 * `truncated` counts rows the capped traversal never built; `overflow`
 * covers anything still over limit (e.g. the thread root post). */
function boundedDetailPage(request: SocialRequest, entities: SocialEntityV1[], warnings: string[], dropped: number, truncated: number): SocialPageV1 {
  const limited = entities.slice(0, request.limit);
  const overflow = entities.length - limited.length;
  const cut = truncated + overflow;
  if (cut > 0) warnings.push(`truncated ${cut} rows to limit; detail output is capped at ${request.limit} entities`);
  return page(limited, warnings, dropped > 0 || cut > 0, noPagination(request));
}

interface ForestResult {
  entities: SocialEntityV1[];
  dropped: number;
  truncated: number;
}

interface ForestWalkState {
  backend: string;
  postId: string;
  includeReplies: boolean;
  warnings: string[];
  entities: SocialEntityV1[];
  dropped: number;
  limit: number;
  truncated: number;
}

/** Structural row count of a comment subtree (node + all descendants),
 * without building entities: lets the capped walk report an exact
 * truncation count while skipping the expensive normalization. */
function countSubtreeRows(node: unknown): number {
  const row = childRow(node);
  if (row === undefined) return 1;
  let total = 1;
  for (const reply of commentReplies(row)) total += countSubtreeRows(reply);
  return total;
}

function walkCommentForest(nodes: unknown[], depth: number, parentCommentId: string | undefined, state: ForestWalkState): void {
  for (const node of nodes) {
    // At the cap: count the whole subtree as truncated, never build it.
    if (state.entities.length >= state.limit) {
      state.truncated += countSubtreeRows(node);
      continue;
    }
    const row = childRow(node);
    if (row === undefined) {
      state.dropped += 1;
      state.warnings.push('dropped malformed comment row');
      continue;
    }
    const entity = normalizeCommentRow(row, { backend: state.backend, depth, postId: state.postId, parentCommentId, warnings: state.warnings });
    if (entity === undefined) {
      state.dropped += 1;
      continue;
    }
    state.entities.push(entity);
    const replies = commentReplies(row);
    if (replies.length === 0) continue;
    if (!state.includeReplies) {
      state.warnings.push('nested replies omitted (includeReplies is false)');
      continue;
    }
    // Normalization hit the cap mid-siblings: count the rest structurally.
    if (state.entities.length >= state.limit) {
      for (const reply of replies) state.truncated += countSubtreeRows(reply);
      continue;
    }
    walkCommentForest(replies, depth + 1, commentNativeId(row), state);
  }
}

/** Flatten a Reddit comment forest in source structural (pre-order) order. */
function flattenCommentForest(
  rows: unknown[],
  options: {
    backend: string;
    postId: string;
    includeReplies: boolean;
    warnings: string[];
    limit: number;
  },
): ForestResult {
  const state: ForestWalkState = { backend: options.backend, postId: options.postId, includeReplies: options.includeReplies, warnings: options.warnings, entities: [], dropped: 0, limit: options.limit, truncated: 0 };
  walkCommentForest(rows, 0, undefined, state);
  return { entities: state.entities, dropped: state.dropped, truncated: state.truncated };
}

function commentReplies(row: Record<string, unknown>): unknown[] {
  const direct = row.replies;
  if (Array.isArray(direct)) return direct;
  // Raw Reddit shape: replies: {kind:'Listing', data:{children:[...]}}
  if (isRecord(direct) && isRecord((direct as Record<string, unknown>).data)) {
    const data = (direct as Record<string, unknown>).data as Record<string, unknown>;
    if (Array.isArray(data.children)) return data.children;
  }
  return [];
}

function isRemovedAuthor(author: unknown): boolean {
  return author === '[deleted]' || author === '[removed]';
}

function authorHandle(row: Record<string, unknown>): string | undefined {
  const author = row.author;
  if (typeof author !== 'string') return undefined;
  if (author.length === 0) return undefined;
  if (isRemovedAuthor(author)) return undefined;
  return author;
}

function actorFromRow(row: Record<string, unknown>): { handle: string } | undefined {
  const handle = authorHandle(row);
  if (handle === undefined) return undefined;
  return { handle };
}

function publishedDate(row: Record<string, unknown>): string | undefined {
  return parseSocialDate(row.created_utc ?? row.created);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeAbout(row: Record<string, unknown>, kind: 'account' | 'community', backend: string): SocialEntityV1 {
  const nativeId = postNativeId(row);
  if (nativeId === undefined) {
    throw new SocialError('malformed_upstream', 'about row has no id', { platform: 'reddit', backend });
  }
  const metrics: { followers?: number } = {};
  const subscribers = kind === 'community' ? finiteNumber(row.subscribers) : undefined;
  if (subscribers !== undefined) metrics.followers = subscribers;
  const displayName = typeof row.title === 'string' && row.title.trim().length > 0 ? row.title : undefined;
  const description = typeof row.public_description === 'string' && row.public_description.trim().length > 0 ? row.public_description : undefined;
  const publishedAt = publishedDate(row);

  const entity: SocialEntityV1 = kind === 'community'
    ? {
        version: 1,
        kind: 'social_community',
        id: socialEntityId('reddit', 'social_community', nativeId),
        platformId: nativeId,
        platform: 'reddit',
        backend,
        ...(typeof row.display_name === 'string' ? { name: row.display_name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      }
    : {
        version: 1,
        kind: 'social_account',
        id: socialEntityId('reddit', 'social_account', nativeId),
        platformId: nativeId,
        platform: 'reddit',
        backend,
        ...(typeof row.name === 'string' ? { handle: row.name } : {}),
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { bio: description } : {}),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
      };
  const validation = validateSocialEntity(entity);
  if (!validation.ok) {
    throw new SocialError('malformed_upstream', `upstream about row failed normalization: ${validation.issues[0]}`, { platform: 'reddit', backend });
  }
  return entity;
}
