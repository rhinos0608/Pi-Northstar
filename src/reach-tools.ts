import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { BackendCallOptions, BackendCallResult } from './backend.js';
import { CliSearchBackend } from './cli-backend.js';
import { callSetupTool } from './bootstrap.js';
import { browser } from './browser-tools.js';
import { fetchInit, fetchJson as boundedFetchJson, fetchJsonNoRedirect, fetchText as boundedFetchText, safeResponseJson, validatePublicHttpUrl } from './http.js';
import { cookieAuthEnvironment, cookieHeaderForUrl } from './cookie-jar.js';
import { authForChannel } from './providers.js';
import { dedupeBy, guardResult, jsonTextResult, textResult } from './tool-output.js';

export type ReachToolName = 'reach_status' | 'reach_setup' | 'social' | 'video' | 'feeds' | 'media' | 'browser';

interface ReachToolOptions {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ExternalCandidate {
  name: string;
  command: string;
  probeArgs: string[];
  args(action: string, input: Record<string, unknown>): string[];
  setup: string;
}

interface ChannelDefinition {
  name: string;
  family: 'social' | 'media' | 'web' | 'dev' | 'research' | 'browser';
  description: string;
  tier: 0 | 1 | 2;
  backends: Array<{ name: string; type: 'native' | 'external'; command?: string; setup?: string }>;
}

const COMMAND_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;
const USER_AGENT = 'pi-extension-search/0.1';

// Fixed first-party hosts only. No user-configurable fallback hosts.
const REDDIT_OAUTH_BASE = 'https://oauth.reddit.com';
const REDDIT_WWW_BASE = 'https://www.reddit.com';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const ARCTIC_SHIFT_BASE = 'https://arctic-shift.photon-reddit.com';
const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_OEMBED_URL = 'https://www.youtube.com/oembed';
const YOUTUBE_MAX_RESULTS = 50;

// Opt-in final web fallback (PI_SEARCH_PLATFORM_WEB_FALLBACK=1). Uses Pi-owned
// web_search/agentic-browse utilities through a sanitized child environment:
// no cookies, no proxy vars, no platform/API credentials, one-shot scraping.
const PLATFORM_WEB_FALLBACK_FLAG = 'PI_SEARCH_PLATFORM_WEB_FALLBACK';

// Actions with a canonical live Reddit API request. Unsupported actions keep
// legacy CLI error behavior and never reach live or archive backends.
const REDDIT_LIVE_ACTIONS = new Set(['search', 'read', 'feed', 'subreddit', 'hot', 'popular', 'subreddit_info', 'all']);

// OAuth token cache: keyed by a digest of the credential triple (never the
// values), bounded lifetime, never surfaced in output. Module-level per process.
let redditTokenCache: { keyDigest: string; value: string; expiresAt: number } | undefined;

const channels: ChannelDefinition[] = [
  { name: 'web', family: 'web', description: 'Public web search and page reading', tier: 0, backends: [{ name: 'native-fetch', type: 'native' }] },
  { name: 'github', family: 'dev', description: 'GitHub repositories, files, trees, search, trending', tier: 0, backends: [{ name: 'github-api', type: 'native' }] },
  { name: 'research', family: 'research', description: 'Academic, public-data, and community sources', tier: 0, backends: [{ name: 'native-public-apis', type: 'native' }] },
  { name: 'rss', family: 'media', description: 'RSS and Atom feed reading', tier: 0, backends: [{ name: 'native-rss-atom', type: 'native' }] },
  { name: 'v2ex', family: 'social', description: 'V2EX topics, nodes, replies, and users', tier: 0, backends: [{ name: 'v2ex-public-api', type: 'native' }] },
  { name: 'twitter', family: 'social', description: 'Twitter/X tweets, search, users, and timelines', tier: 1, backends: [{ name: 'twitter-cli', type: 'external', command: 'twitter', setup: 'pipx install twitter-cli' }, { name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'reddit', family: 'social', description: 'Reddit posts, comments, subreddits, and search', tier: 1, backends: [{ name: 'reddit-api', type: 'native', setup: 'Set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET + REDDIT_USER_AGENT' }, { name: 'reddit-cookie', type: 'native', setup: 'Provide a Reddit session cookie (REDDIT_COOKIE env or imported cookie state)' }, { name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }, { name: 'rdt-cli', type: 'external', command: 'rdt', setup: "pipx install 'git+https://github.com/public-clis/rdt-cli.git' && rdt login" }] },
  { name: 'xiaohongshu', family: 'social', description: 'XiaoHongShu search, notes, comments, feed, and users', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }, { name: 'xhs-cli', type: 'external', command: 'xhs', setup: 'Install xhs-cli; OpenCLI preferred for new installs' }] },
  { name: 'facebook', family: 'social', description: 'Facebook search, profiles, feed, and groups', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'instagram', family: 'social', description: 'Instagram user search, profiles, posts, explore, and saved', tier: 1, backends: [{ name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI and login in Chrome' }] },
  { name: 'youtube', family: 'media', description: 'YouTube search, details, and hot via the official Data API, with keyless oEmbed fallback for details', tier: 1, backends: [{ name: 'youtube-data-api', type: 'native', setup: 'Set YOUTUBE_API_KEY' }, { name: 'youtube-oembed', type: 'native', setup: 'No configuration (keyless, details only)' }, { name: 'yt-dlp', type: 'external', command: 'yt-dlp', setup: 'pip install yt-dlp (legacy probe only; not used by calls)' }] },
  { name: 'bilibili', family: 'media', description: 'Bilibili search, hot videos, details, and subtitles', tier: 1, backends: [{ name: 'bili-cli', type: 'external', command: 'bili', setup: 'Install bili-cli' }, { name: 'OpenCLI', type: 'external', command: 'opencli', setup: 'Install OpenCLI for subtitles' }] },
  { name: 'browser', family: 'browser', description: 'Browser automation via CDP: navigate, evaluate, screenshot, click, type, scroll, tabs, cookies', tier: 0, backends: [{ name: 'cdp', type: 'native' }] },
];

export async function callReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions = {},
): Promise<BackendCallResult | undefined> {
  const result = await dispatchReachTool(name, args, options);
  return result ? guardResult(result, { env: options.env }) : undefined;
}

async function dispatchReachTool(
  name: string,
  args: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<BackendCallResult | undefined> {
  switch (name as ReachToolName) {
    case 'reach_status':
      return reachStatus(args, options);
    case 'reach_setup':
      return callSetupTool(args, options);
    case 'social':
      return social(args, options);
    case 'video':
      return video(args, options);
    case 'feeds':
      return feeds(args, options);
    case 'media':
      if (args.platform === 'rss' || args.action === 'feed') {
        return feeds({ url: args.url, limit: args.limit ?? 20 }, options);
      }
      return video(args, options);
    case 'browser':
      return browser(args, options);
    default:
      return undefined;
  }
}

async function reachStatus(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const family = typeof args.family === 'string' ? args.family : undefined;
  const selected = family ? channels.filter((channel) => channel.family === family) : channels;
  const env = options.env ?? process.env;
  const results = await Promise.all(selected.map((channel) => inspectChannel(channel, options)));
  const usable = results.filter((item) => item.status === 'ok').length;
  const channelsWithAuth = results.map((r) => {
    const name = typeof r.name === 'string' ? r.name : '';
    const auth = authForChannel(name, env);
    return { ...r, auth: auth ?? { configured: false, keyNames: [], loginFlow: 'unknown', cookieDomains: [], risk: 'low' } };
  });
  return jsonTextResult({ usable, total: results.length, channels: channelsWithAuth });
}

async function inspectChannel(channel: ChannelDefinition, options: ReachToolOptions): Promise<Record<string, unknown>> {
  const env = options.env ?? process.env;
  try {
    // Reddit/YouTube native HTTP backends are credential-gated and handled by
    // their own checks below; exclude them from the generic native shortcut so
    // unconfigured native channels are never falsely marked usable.
    const native = channel.name === 'reddit' || channel.name === 'youtube'
      ? undefined
      : channel.backends.find((backend) => backend.type === 'native');
    if (native) {
      return { ...channel, status: 'ok', active_backend: native.name };
    }

    // Native HTTP backends need no CLI probe: report usable when credentials exist.
    if (channel.name === 'reddit') {
      const nativeBackend = redditNativeBackend(env);
      if (nativeBackend) return { ...channel, status: 'ok', active_backend: nativeBackend };
    }
    if (channel.name === 'youtube') {
      const key = typeof env.YOUTUBE_API_KEY === 'string' ? env.YOUTUBE_API_KEY.trim() : '';
      if (key) return { ...channel, status: 'ok', active_backend: 'youtube-data-api' };
      // Keyless: the keyless oEmbed endpoint provides limited `details` only.
      // yt-dlp is never probed or reported because automatic calls never route
      // to it (no-scraping policy).
      return { ...channel, status: 'warn', active_backend: 'youtube-oembed', message: 'Keyless partial: video details via oEmbed (limited fields). Set YOUTUBE_API_KEY for search, details, and hot via the official Data API.' };
    }

    // Probe external candidates only (native entries describe HTTP backends
    // that require no CLI binary).
    const candidates = orderedBackendMetadata(channel, env).filter((backend) => backend.type === 'external');
    const warnings: Array<{ backend: string; message: string }> = [];
    for (const candidate of candidates) {
      const probe = await runCommand(candidate.command ?? '', probeArgs(candidate.name), options, 8_000);
      if (probe.code === 0) return { ...channel, status: 'ok', active_backend: candidate.name };
      if (probe.code !== 127) warnings.push({ backend: candidate.name, message: tail(sanitizeExternalOutput(probe.stderr || probe.stdout)) });
    }
    if (warnings[0]) return { ...channel, status: 'warn', active_backend: warnings[0].backend, message: warnings[0].message };
    return { ...channel, status: 'off', active_backend: null, message: setupMessage(channel) };
  } catch (error) {
    return { ...channel, status: 'error', active_backend: null, message: error instanceof Error ? error.message : String(error) };
  }
}

async function social(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const platform = platformOrInfer(args, ['twitter', 'reddit', 'v2ex', 'xiaohongshu', 'facebook', 'instagram']);
  if (platform === 'v2ex') return v2ex(args, options);
  if (platform === 'reddit') return reddit(args, options);

  const requestedAction = typeof args.action === 'string' ? args.action : 'search';
  const filter = requestedAction === 'feed' ? hotPopularFilter(args.filter) : undefined;
  const action = socialFeedAction(platform, requestedAction, filter);
  const candidates = socialCandidates(platform);
  const result = await runFirstUsable(platform, candidates, action, args, options);
  return textResult(result.stdout || result.stderr, { platform, action, ...(filter ? { filter } : {}), backend: result.backend, stdout: result.stdout, stderr: result.stderr });
}

function socialFeedAction(platform: string, action: string, filter: 'hot' | 'popular' | undefined): string {
  if (action !== 'feed' || !filter) return action;
  if (platform === 'reddit') return filter;
  if (platform === 'xiaohongshu' && filter === 'hot') return 'hot';
  if (platform === 'twitter') return action;
  throw new Error(`${platform} feed does not support ${filter} filter`);
}

// ── Reddit: native live API → native cookie session → legacy CLI → Arctic Shift archive ──

async function reddit(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const requestedAction = typeof args.action === 'string' ? args.action : 'search';
  const filter = requestedAction === 'feed' ? hotPopularFilter(args.filter) : undefined;
  const action = socialFeedAction('reddit', requestedAction, filter);
  const env = options.env ?? process.env;

  // Explicit id wins over an arbitrary supplied url for read: canonicalize
  // before any live/CLI/archive/page fallback paths consume args.
  const normalizedArgs = action === 'read' ? normalizeRedditReadInput(args) : args;

  // Actions without a canonical live request keep legacy CLI error behavior.
  if (!REDDIT_LIVE_ACTIONS.has(action)) {
    return redditCliFallback(normalizedArgs, action, filter, options);
  }

  const hasApi = hasRedditApiCredentials(env);
  // Only a raw user-provided REDDIT_COOKIE travels untouched; stored cookies
  // are routed per-request by exact host/path/expiry/secure inside the request.
  const cookie = redditCookieHeader(env);
  // Session presence for the gate uses the scoped stored-cookie match for the
  // actual request URL, never an unfiltered blob: expired/path-mismatched/
  // non-Reddit stored cookies must not bypass the legacy CLI fallback.
  const hasSession = cookie !== undefined || safeScopedRedditCookie(action, normalizedArgs, env) !== undefined;

  // No live credentials/session: legacy CLI compatibility fallback. Archive only
  // when the CLI cannot serve (never for invalid input or unsupported actions).
  if (!hasApi && !hasSession) {
    try {
      return await redditCliFallback(normalizedArgs, action, filter, options);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (isInvalidInputCliError(err)) throw err;
      return redditLastResort(action, normalizedArgs, env, options.signal, 'cli_unavailable', err, options);
    }
  }

  try {
    const live = await redditLive(action, normalizedArgs, env, options.signal, hasApi, cookie);
    if (live !== null) return live;
    return redditLastResort(action, normalizedArgs, env, options.signal, 'content_absent', undefined, options);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Auth/permission and invalid input must never trigger the archive.
    if (isAuthOrPermissionError(err) || isInvalidInputError(err)) throw err;
    if (isTransientError(err)) return redditLastResort(action, normalizedArgs, env, options.signal, 'transient', err, options);
    throw err;
  }
}

async function redditCliFallback(
  args: Record<string, unknown>,
  action: string,
  filter: 'hot' | 'popular' | undefined,
  options: ReachToolOptions,
): Promise<BackendCallResult> {
  const candidates = [openCliCandidate('reddit'), rdtCandidate()];
  const result = await runFirstUsable('reddit', candidates, action, args, options);
  return textResult(result.stdout || result.stderr, {
    platform: 'reddit', action, ...(filter ? { filter } : {}),
    backend: result.backend, stdout: result.stdout, stderr: result.stderr,
  });
}

async function redditLive(
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  hasApi: boolean,
  cookie: string | undefined,
): Promise<BackendCallResult | null> {
  try {
    if (hasApi) {
      const apiResult = await redditApi(action, args, env, signal);
      if (apiResult !== null) return apiResult;
      // redditCookieRequest self-nullifies when no raw cookie and no scoped
      // stored cookie matches, so it is safe to always attempt it.
      return redditCookieRequest(action, args, env, signal, cookie);
    }
    return redditCookieRequest(action, args, env, signal, cookie);
  } catch (err) {
    // API transient failure with a cookie session available (raw or stored):
    // try the live cookie request before falling to the archive.
    const cookieSource = cookie !== undefined || safeScopedRedditCookie(action, args, env) !== undefined;
    if (hasApi && cookieSource && !(err instanceof Error && err.name === 'AbortError') && isTransientError(err)) {
      const cookieResult = await redditCookieRequest(action, args, env, signal, cookie);
      if (cookieResult !== null) return cookieResult;
      return null;
    }
    throw err;
  }
}

function hasRedditApiCredentials(env: Record<string, string | undefined>): boolean {
  return Boolean(env.REDDIT_CLIENT_ID?.trim() && env.REDDIT_CLIENT_SECRET?.trim() && env.REDDIT_USER_AGENT?.trim());
}

function redditNativeBackend(env: Record<string, string | undefined>): 'reddit-api' | 'reddit-cookie' | undefined {
  if (hasRedditApiCredentials(env)) return 'reddit-api';
  // A stored-session backend is only reported when a scoped cookie actually
  // matches the canonical Reddit host; expired/path-mismatched/non-Reddit
  // stored cookies never mark the channel usable.
  if (redditCookieHeader(env)) return 'reddit-cookie';
  if (cookieHeaderForUrl('reddit', `${REDDIT_WWW_BASE}/`, env)) return 'reddit-cookie';
  return undefined;
}

function redditCookieHeader(env: Record<string, string | undefined>): string | undefined {
  if (typeof env.REDDIT_COOKIE === 'string' && env.REDDIT_COOKIE.trim()) return env.REDDIT_COOKIE.trim();
  return undefined;
}

/**
 * Stored-cookie session scoped to the exact canonical URL the request would
 * use. Never counts an expired, path-mismatched, or non-Reddit stored cookie
 * as a usable session.
 */
function safeScopedRedditCookie(action: string, args: Record<string, unknown>, env: Record<string, string | undefined>): string | undefined {
  try {
    const { path, params } = redditEndpoint(action, args, numberOrDefault(args.limit, 10));
    const url = `${REDDIT_WWW_BASE}${path}?${new URLSearchParams(params).toString()}`;
    return cookieHeaderForUrl('reddit', url, env);
  } catch {
    return undefined;
  }
}

async function getRedditToken(env: Record<string, string | undefined>, signal?: AbortSignal): Promise<string> {
  const clientId = env.REDDIT_CLIENT_ID?.trim();
  const clientSecret = env.REDDIT_CLIENT_SECRET?.trim();
  const userAgent = env.REDDIT_USER_AGENT?.trim();
  if (!clientId || !clientSecret || !userAgent) {
    throw new Error('Reddit API requires REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT');
  }
  const keyDigest = createHash('sha256').update(`${clientId}\n${clientSecret}\n${userAgent}`).digest('hex');
  const cached = redditTokenCache;
  if (cached && cached.keyDigest === keyDigest && Date.now() < cached.expiresAt) return cached.value;

  const response = await fetch(REDDIT_TOKEN_URL, {
    // Redirects are rejected: the token request carries basic credentials and
    // must never follow a cross-host hop.
    ...fetchInit({
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent,
    }, signal, undefined, 'manual'),
    method: 'POST',
    body: 'grant_type=client_credentials',
  });
  if (response.status >= 300 && response.status < 400) throw new Error(`Reddit token: redirect rejected for fixed host ${REDDIT_TOKEN_URL}`);
  if (!response.ok) throw new Error(`Reddit token: HTTP ${response.status}`);
  const parsed = await safeResponseJson(response, REDDIT_TOKEN_URL) as { access_token?: unknown; expires_in?: unknown };
  if (typeof parsed.access_token !== 'string' || !parsed.access_token) {
    throw new Error('Reddit token: invalid token response');
  }
  const expiresIn = typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in) ? parsed.expires_in : 3600;
  const boundedMs = Math.min(expiresIn, 3600) * 1000;
  redditTokenCache = { keyDigest, value: parsed.access_token, expiresAt: Date.now() + boundedMs - 60_000 };
  return parsed.access_token;
}

async function redditApi(
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<BackendCallResult | null> {
  const token = await getRedditToken(env, signal);
  const { path, params } = redditEndpoint(action, args, numberOrDefault(args.limit, 10));
  const url = `${REDDIT_OAUTH_BASE}${path}?${new URLSearchParams(params).toString()}`;
  // Bearer credentials never follow redirects: fixed host only.
  const data = await fetchJsonNoRedirect(url, { Authorization: `Bearer ${token}`, 'User-Agent': env.REDDIT_USER_AGENT?.trim() ?? USER_AGENT }, signal);
  return redditLiveResult(action, data, 'reddit-api');
}

async function redditCookieRequest(
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  cookie: string | undefined,
): Promise<BackendCallResult | null> {
  const { path, params } = redditEndpoint(action, args, numberOrDefault(args.limit, 10));
  const url = `${REDDIT_WWW_BASE}${path}?${new URLSearchParams(params).toString()}`;
  // Cookie is attached only to the fixed canonical host. A raw user-provided
  // REDDIT_COOKIE goes out as-is; stored cookies are matched by exact host,
  // path, expiry, and secure flag. Redirects are rejected so credentials never
  // follow a cross-host hop.
  const header = cookie ?? cookieHeaderForUrl('reddit', url, env);
  if (!header) return null;
  const data = await fetchJsonNoRedirect(url, { Cookie: header, 'User-Agent': env.REDDIT_USER_AGENT?.trim() ?? USER_AGENT }, signal);
  return redditLiveResult(action, data, 'reddit-cookie');
}

function redditLiveResult(action: string, data: unknown, backend: 'reddit-api' | 'reddit-cookie'): BackendCallResult | null {
  if (action === 'subreddit_info') {
    const sub = (data as { data?: unknown } | null)?.data;
    if (!sub || typeof sub !== 'object') return null;
    return jsonTextResult({
      platform: 'reddit', action, backend, source: redditSource(backend),
      subreddit: normalizeRedditSubreddit(sub as Record<string, unknown>),
    });
  }
  const items = listingChildren(data).flatMap((child) => {
    const row = (child as { data?: unknown } | null)?.data;
    return row && typeof row === 'object' ? [normalizeRedditPost(row as Record<string, unknown>)] : [];
  });
  if (items.length === 0) return null;
  return jsonTextResult({ platform: 'reddit', action, backend, source: redditSource(backend), items, count: items.length });
}

function listingChildren(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const children = (data as { data?: { children?: unknown } }).data?.children;
  return Array.isArray(children) ? children : [];
}

function redditSource(backend: 'reddit-api' | 'reddit-cookie'): string {
  return backend === 'reddit-api' ? REDDIT_OAUTH_BASE : REDDIT_WWW_BASE;
}

function redditEndpoint(action: string, args: Record<string, unknown>, limit: number): { path: string; params: Record<string, string> } {
  switch (action) {
    case 'search':
      return { path: '/search.json', params: { q: requireString(args.query, 'query'), sort: 'relevance', type: 'link', limit: String(limit) } };
    case 'read':
      return { path: '/api/info.json', params: { id: redditPostId(args) } };
    case 'feed':
    case 'popular':
      return { path: '/r/popular.json', params: { limit: String(limit) } };
    case 'subreddit':
      return { path: `/r/${encodeURIComponent(requireString(args.subreddit, 'subreddit'))}/hot.json`, params: { limit: String(limit) } };
    case 'hot': {
      const subreddit = typeof args.subreddit === 'string' && args.subreddit.trim() ? args.subreddit.trim() : undefined;
      return subreddit
        ? { path: `/r/${encodeURIComponent(subreddit)}/hot.json`, params: { limit: String(limit) } }
        : { path: '/hot.json', params: { limit: String(limit) } };
    }
    case 'subreddit_info':
      return { path: `/r/${encodeURIComponent(requireString(args.subreddit, 'subreddit'))}/about.json`, params: {} };
    case 'all':
      return { path: '/r/all/hot.json', params: { limit: String(limit) } };
    default:
      throw new Error(`Unsupported reddit action: ${action}`);
  }
}

function redditPostId(args: Record<string, unknown>): string {
  const raw = typeof args.id === 'string' && args.id.trim()
    ? args.id.trim()
    : (typeof args.url === 'string' ? postIdFromRedditUrl(args.url) : undefined);
  if (!raw) throw new Error('id or url is required');
  return raw.startsWith('t3_') ? raw : `t3_${raw}`;
}

// Canonical post IDs from exact Reddit hosts only: /comments/{id} paths, the
// exact redd.it host, or a reddit.com root-level short link. Never relaxes the
// cookie/cli host guard — lookalike hosts return undefined and fail validation.
function postIdFromRedditUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const isReddIt = host === 'redd.it';
  const isReddit = host === 'reddit.com' || host.endsWith('.reddit.com');
  // Host must be a canonical Reddit host before any path extraction — a
  // lookalike host such as evil.example/comments/<id> must never yield an ID.
  if (!isReddIt && !isReddit) return undefined;
  const comments = /comments\/([a-z0-9]{1,12})/i.exec(url.pathname)?.[1];
  if (comments) return comments.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const segment = segments[0];
  if (segments.length === 1 && segment && /^[a-z0-9]{1,12}$/i.test(segment)) return segment.toLowerCase();
  return undefined;
}

// Explicit id always wins over a supplied url for the read action. When both
// are present, replace the URL with a canonical reddit.com comments URL before
// any live/CLI/archive/page fallback consumes args, so the raw user URL never
// reaches a command or fallback request. Lookalike URLs without an id remain
// untouched and stay terminal invalid input.
function normalizeRedditReadInput(args: Record<string, unknown>): Record<string, unknown> {
  const rawId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
  const rawUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
  if (!rawId || !rawUrl) return args;
  const id = rawId.replace(/^t3_/, '');
  return { ...args, url: `https://www.reddit.com/comments/${encodeURIComponent(id)}` };
}

// ── Arctic Shift archive fallback (fixed host, last resort only) ──

async function redditArchive(
  action: string,
  args: Record<string, unknown>,
  _env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  reason: 'content_absent' | 'transient' | 'cli_unavailable',
): Promise<BackendCallResult> {
  if (signal?.aborted) throw abortError();
  const { path, params } = arcticShiftEndpoint(action, args, numberOrDefault(args.limit, 10));
  const url = `${ARCTIC_SHIFT_BASE}${path}?${new URLSearchParams(params).toString()}`;
  const data = await arcticShiftFetch(url, signal);
  const items = archiveItems(action, data);
  const retrievedAt = new Date().toISOString();
  const historicalApproximation = ['feed', 'hot', 'popular', 'all'].includes(action);
  const payload = {
    platform: 'reddit', action, backend: 'arctic-shift', archived: true, reason,
    source: ARCTIC_SHIFT_BASE, retrievedAt, historicalApproximation, items,
  };
  const header = `[ARCHIVE] Archival data from Arctic Shift (${ARCTIC_SHIFT_BASE}), not live Reddit. `
    + `Content may be 36+ hours stale; private/quarantined subreddits are excluded; deleted/removed items are filtered. `
    + `Retrieved ${retrievedAt}. Fallback reason: ${reason}.`;
  return textResult(`${header}\n${JSON.stringify(payload, null, 2)}`, payload);
}

async function redditLastResort(
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal: AbortSignal | undefined,
  reason: 'content_absent' | 'transient' | 'cli_unavailable',
  primaryError: unknown,
  options: ReachToolOptions,
): Promise<BackendCallResult> {
  try {
    return await redditArchive(action, args, env, signal, reason);
  } catch (err) {
    // Cancellation must always propagate, even when the archive cannot help.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    // Opt-in final web fallback after the archive is exhausted. Otherwise
    // preserve the primary error (or the archive error when there was none).
    if (platformWebFallbackEnabled(env)) return redditWebFallback(action, args, options);
    if (primaryError !== undefined) throw primaryError;
    throw err;
  }
}

function arcticShiftEndpoint(action: string, args: Record<string, unknown>, limit: number): { path: string; params: Record<string, string> } {
  switch (action) {
    case 'search':
      return { path: '/api/posts/search', params: { query: requireString(args.query, 'query'), sort: 'desc', limit: String(Math.min(limit, 100)) } };
    case 'read':
      return { path: '/api/posts/ids', params: { ids: redditPostId(args).replace(/^t3_/, ''), fields: 'id,title,selftext,author,created_utc,score,num_comments,permalink,url,subreddit,subreddit_id,over_18,spoiler,retrieved_on' } };
    case 'feed':
    case 'popular':
    case 'all':
      return { path: '/api/posts/search', params: { sort: 'desc', limit: String(Math.min(limit, 100)), after: '7d' } };
    case 'subreddit':
      return { path: '/api/posts/search', params: { subreddit: requireString(args.subreddit, 'subreddit'), sort: 'desc', limit: String(Math.min(limit, 100)) } };
    case 'hot': {
      const subreddit = typeof args.subreddit === 'string' && args.subreddit.trim() ? args.subreddit.trim() : undefined;
      return subreddit
        ? { path: '/api/posts/search', params: { subreddit, sort: 'desc', limit: String(Math.min(limit, 100)), after: '24h' } }
        : { path: '/api/posts/search', params: { sort: 'desc', limit: String(Math.min(limit, 100)), after: '24h' } };
    }
    case 'subreddit_info':
      return { path: '/api/subreddits/search', params: { subreddit: requireString(args.subreddit, 'subreddit') } };
    default:
      throw new Error(`Unsupported archive action: ${action}`);
  }
}

async function arcticShiftFetch(url: string, signal?: AbortSignal): Promise<unknown> {
  if (signal?.aborted) throw abortError();
  // Bounded fetch: default 15s timeout via fetchInit and 1MB body cap via
  // safeResponseJson. Fixed first-party host only (ARCTIC_SHIFT_BASE). A
  // single attempt only — 429/5xx propagate instead of being retried.
  // Redirects are rejected so the archive never hops to another host.
  const response = await fetch(url, fetchInit({ 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal, undefined, 'manual'));
  if (response.status >= 300 && response.status < 400) throw new Error(`Reddit archive: redirect rejected for fixed host ${ARCTIC_SHIFT_BASE}`);
  if (!response.ok) throw new Error(`Reddit archive: HTTP ${response.status}`);
  return safeResponseJson(response, url);
}

function archiveItems(action: string, data: unknown): Array<Record<string, unknown>> {
  const rows = (data as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  if (action === 'subreddit_info') {
    return rows.flatMap((row) => isArchiveItemDeleted(row as Record<string, unknown>) ? [] : [normalizeRedditSubreddit(row as Record<string, unknown>)]);
  }
  return rows.flatMap((row) => {
    const normalized = normalizeRedditPost(row as Record<string, unknown>);
    return isArchiveItemDeleted(normalized) ? [] : [normalized];
  });
}

function isArchiveItemDeleted(item: Record<string, unknown>): boolean {
  const meta = (item._meta ?? {}) as Record<string, unknown> | undefined;
  if (!meta) return false;
  if (meta.was_deleted_later === true) return true;
  // Any truthy removal marker (string, boolean, number) means the item was removed.
  return Boolean(meta.removal_type);
}

function normalizeRedditPost(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: raw.id, name: raw.name, author: raw.author, title: raw.title, selftext: raw.selftext,
    url: raw.url, permalink: raw.permalink, created_utc: raw.created_utc, score: raw.score,
    num_comments: raw.num_comments, subreddit: raw.subreddit, subreddit_id: raw.subreddit_id,
    over_18: raw.over_18, spoiler: raw.spoiler, _meta: raw._meta,
  };
}

function normalizeRedditSubreddit(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    id: raw.id, name: raw.name, display_name: raw.display_name, title: raw.title,
    description: raw.description, public_description: raw.public_description,
    subscribers: raw.subscribers, created_utc: raw.created_utc, over18: raw.over18,
    url: raw.url, _meta: raw._meta,
  };
}

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /http 429|http 5\d\d|timeout|timed out|etimedout|econnreset|socket hang up|fetch failed|network/i.test(err.message);
}

function isAuthOrPermissionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /http 401|http 403/i.test(err.message);
}

function isInvalidInputError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /http 400/i.test(err.message);
}

function isInvalidInputCliError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Missing required args and non-Reddit rdt URLs are caller errors. A backend
  // lacking a candidate action (e.g. "Unsupported rdt action: hot") is a
  // capability gap, not invalid input — valid actions must still reach the archive.
  return /required|must be a reddit\.com/.test(err.message);
}

function hotPopularFilter(value: unknown): 'hot' | 'popular' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('filter must be hot or popular');
  const normalized = value.toLowerCase();
  if (normalized === 'hot' || normalized === 'popular') return normalized;
  throw new Error('filter must be hot or popular');
}

async function video(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const platform = platformOrInfer(args, ['youtube', 'bilibili']);
  const action = typeof args.action === 'string' ? args.action : (args.url ? 'details' : 'search');

  if (platform === 'youtube') return youtubeAction(action, args, options);

  const candidates = videoCandidates(platform);
  const result = await runFirstUsable(platform, candidates, action, args, options);
  const text = result.stdout || result.stderr;
  return textResult(text, { platform, action, backend: result.backend, stdout: result.stdout, stderr: result.stderr });
}

async function feeds(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const url = requireString(args.url, 'url');
  const limit = numberOrDefault(args.limit, 20);
  const xml = await fetchText(url, options.signal);
  const items = dedupeBy(parseFeedItems(xml), (item) => item.url || item.title).slice(0, limit);
  const text = items.length
    ? items.map((item, index) => `## ${index + 1}. ${item.title}\n${item.url}\n${item.summary ?? ''}`).join('\n\n')
    : `No feed entries found for: ${url}`;
  return textResult(text, { url, items });
}

async function v2ex(args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'hot';
  const limit = numberOrDefault(args.limit, 20);
  let data: unknown;

  switch (action) {
    case 'hot':
      data = (await fetchJson('https://www.v2ex.com/api/topics/hot.json', options.signal) as unknown[]).slice(0, limit);
      break;
    case 'node': {
      const node = requireString(args.node ?? args.nodeName, 'node');
      data = (await fetchJson(`https://www.v2ex.com/api/topics/show.json?node_name=${encodeURIComponent(node)}&page=1`, options.signal) as unknown[]).slice(0, limit);
      break;
    }
    case 'topic': {
      const id = requireString(args.id ?? topicIdFromUrl(args.url), 'id');
      const topic = await fetchJson(`https://www.v2ex.com/api/topics/show.json?id=${encodeURIComponent(id)}`, options.signal);
      const replies = await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(id)}&page=1`, options.signal);
      data = { topic, replies: Array.isArray(replies) ? replies.slice(0, limit) : replies };
      break;
    }
    case 'replies': {
      const id = requireString(args.id ?? topicIdFromUrl(args.url), 'id');
      data = (await fetchJson(`https://www.v2ex.com/api/replies/show.json?topic_id=${encodeURIComponent(id)}&page=1`, options.signal) as unknown[]).slice(0, limit);
      break;
    }
    case 'user': {
      const username = requireString(args.user ?? args.username, 'user');
      data = await fetchJson(`https://www.v2ex.com/api/members/show.json?username=${encodeURIComponent(username)}`, options.signal);
      break;
    }
    default:
      throw new Error(`Unsupported v2ex action: ${action}`);
  }

  return jsonTextResult({ platform: 'v2ex', action, data });
}

// ── YouTube: official Data API (key-only) → keyless oEmbed for details; no scraping, proxy, or transcript backends ──

async function youtubeAction(action: string, args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  const env = options.env ?? process.env;
  if (action === 'transcript' || action === 'subtitle') {
    throw new Error(`YouTube ${action} is unavailable: Pi-Atlas does not scrape transcripts or use transcript services. `
      + 'Set YOUTUBE_API_KEY for search, details, and hot.');
  }
  if (action === 'details') {
    try {
      const api = await youtubeApi('details', args, env, options.signal);
      if (api !== null) return api;
    } catch (err) {
      // Keyed Data API failure falls through to the keyless oEmbed fallback;
      // cancellation, invalid input, and auth/permission failures must always
      // propagate (never retried against oEmbed or the web fallback).
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (isAuthOrPermissionError(err) || isInvalidInputError(err) || /required|Unsupported .* action/.test(err instanceof Error ? err.message : String(err))) throw err;
    }
    try {
      return await youtubeOEmbed(args, options.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      if (platformWebFallbackEnabled(env)) {
        return webPageFallback('youtube', action, canonicalYoutubeWatchUrl(args), args, options);
      }
      throw err;
    }
  }
  if (action === 'search' || action === 'hot') {
    const key = env.YOUTUBE_API_KEY?.trim();
    if (key) {
      try {
        const api = await youtubeApi(action, args, env, options.signal);
        if (api !== null) return api;
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        // Auth/permission and invalid input must never trigger the fallback.
        if (isAuthOrPermissionError(err) || isInvalidInputError(err)) throw err;
        if (platformWebFallbackEnabled(env)) return webSearchFallback('youtube', action, youtubeFallbackQuery(action, args), args, options);
        throw err;
      }
      if (platformWebFallbackEnabled(env)) return webSearchFallback('youtube', action, youtubeFallbackQuery(action, args), args, options);
      throw new Error(`YouTube ${action} returned no results via the official Data API.`);
    }
    if (platformWebFallbackEnabled(env)) return webSearchFallback('youtube', action, youtubeFallbackQuery(action, args), args, options);
    throw new Error(`YouTube ${action} unavailable: set YOUTUBE_API_KEY to use the official YouTube Data API (no scraping or proxy backends).`);
  }
  throw new Error(`Unsupported youtube action: ${action}`);
}

async function youtubeApi(
  action: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<BackendCallResult | null> {
  const key = env.YOUTUBE_API_KEY?.trim();
  if (!key) return null;
  const url = youtubeApiUrl(action, args, key, numberOrDefault(args.limit, 10));
  let data: unknown;
  try {
    // The request URL carries the API key: redirects must never be followed
    // off the fixed Google host (credential-routing control).
    data = await fetchJsonNoRedirect(url, {}, signal);
  } catch (err) {
    throw youtubeRedactKey(err, key);
  }
  const items = normalizeYoutubeItems(action, data);
  if (action === 'details' && items.length === 0) return null;
  return jsonTextResult({ platform: 'youtube', action, backend: 'youtube-api', items });
}

function youtubeApiUrl(action: string, args: Record<string, unknown>, key: string, limit: number): string {
  switch (action) {
    case 'search': {
      const params = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: String(Math.min(Math.max(limit, 1), YOUTUBE_MAX_RESULTS)), key });
      const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;
      if (query) params.set('q', query);
      return `${YOUTUBE_API_BASE}/search?${params.toString()}`;
    }
    case 'hot': {
      const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', chart: 'mostPopular', maxResults: String(Math.min(Math.max(limit, 1), YOUTUBE_MAX_RESULTS)), key });
      return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
    }
    case 'details': {
      const params = new URLSearchParams({ part: 'snippet,contentDetails,statistics', id: youtubeVideoId(args), key });
      return `${YOUTUBE_API_BASE}/videos?${params.toString()}`;
    }
    default:
      throw new Error(`Unsupported youtube action: ${action}`);
  }
}

function youtubeVideoId(args: Record<string, unknown>): string {
  if (typeof args.id === 'string' && args.id.trim()) return args.id.trim();
  if (typeof args.url === 'string') {
    const fromUrl = videoIdFromUrl(args.url);
    if (fromUrl) return fromUrl;
  }
  throw new Error('id or url is required');
}

function videoIdFromUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    // Host must be a canonical YouTube host before any `v` extraction —
    // lookalike/non-YouTube URLs must never yield a video ID.
    if (host !== 'youtube.com' && host !== 'youtu.be' && !host.endsWith('.youtube.com')) return undefined;
    const fromParam = url.searchParams.get('v');
    if (fromParam) return fromParam;
    // Canonical youtu.be short links carry the video ID as the first path segment.
    if (host === 'youtu.be') {
      const segment = url.pathname.split('/').filter(Boolean)[0];
      return segment && /^[a-zA-Z0-9_-]{1,20}$/.test(segment) ? segment : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeYoutubeItems(action: string, data: unknown): Array<Record<string, unknown>> {
  const rawItems = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(rawItems)) return [];
  if (action === 'search') {
    return rawItems.flatMap((item) => {
      const row = (item ?? {}) as Record<string, unknown>;
      const snippet = (row.snippet ?? {}) as Record<string, unknown>;
      const videoId = (row.id as { videoId?: unknown } | undefined)?.videoId;
      if (typeof videoId !== 'string' || !videoId) return [];
      return [{ id: videoId, title: snippet.title, description: snippet.description, channel: snippet.channelTitle, publishedAt: snippet.publishedAt, url: `https://www.youtube.com/watch?v=${videoId}` }];
    });
  }
  return rawItems.flatMap((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const snippet = (row.snippet ?? {}) as Record<string, unknown>;
    const details = (row.contentDetails ?? {}) as Record<string, unknown>;
    const statistics = (row.statistics ?? {}) as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string' || !id) return [];
    return [{
      id, title: snippet.title, description: snippet.description, channel: snippet.channelTitle,
      publishedAt: snippet.publishedAt, duration: details.duration, viewCount: statistics.viewCount,
      likeCount: statistics.likeCount, commentCount: statistics.commentCount,
      url: `https://www.youtube.com/watch?v=${id}`,
    }];
  });
}

function youtubeRedactKey(err: unknown, key: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = message.replace(/([?&]key=)[^&\s]*/g, '$1[redacted]').split(key).join('[redacted]');
  const error = new Error(redacted);
  if (err instanceof Error && err.name === 'AbortError') error.name = 'AbortError';
  return error;
}

async function youtubeOEmbed(args: Record<string, unknown>, signal?: AbortSignal): Promise<BackendCallResult> {
  // Only canonical YouTube URLs/video IDs may reach the oEmbed endpoint;
  // arbitrary or lookalike URLs are rejected before any network call.
  const target = canonicalYoutubeWatchUrl(args);
  const videoId = target.startsWith('https://www.youtube.com/watch?') ? (new URL(target).searchParams.get('v') ?? undefined) : undefined;
  const endpoint = `${YOUTUBE_OEMBED_URL}?${new URLSearchParams({ url: target, format: 'json' }).toString()}`;
  const data = await boundedFetchJson(endpoint, { 'User-Agent': USER_AGENT }, signal) as Record<string, unknown>;
  return jsonTextResult({
    platform: 'youtube', action: 'details', backend: 'youtube-oembed', limitedFields: true,
    items: [{ id: videoId, title: data.title, author: data.author_name, authorUrl: data.author_url, thumbnail: data.thumbnail_url, url: target }],
  });
}

function canonicalYoutubeWatchUrl(args: Record<string, unknown>): string {
  const rawId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
  if (rawId) return `https://www.youtube.com/watch?v=${encodeURIComponent(rawId)}`;
  const rawUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
  if (!rawUrl) throw new Error('id or url is required');
  // Reject non-http(s) schemes (file:, ftp:, etc.) before any host/ID
  // extraction so wrapper validation errors match the shared contract.
  const validated = validatePublicHttpUrl(rawUrl);
  const videoId = videoIdFromUrl(validated);
  if (!videoId) throw new Error('id or url is required');
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function socialCandidates(platform: string): ExternalCandidate[] {
  switch (platform) {
    case 'twitter':
      return [twitterCandidate(), openCliCandidate('twitter')];
    case 'reddit':
      return [openCliCandidate('reddit'), rdtCandidate()];
    case 'xiaohongshu':
      return [openCliCandidate('xiaohongshu'), xhsCandidate()];
    case 'facebook':
      return [openCliCandidate('facebook')];
    case 'instagram':
      return [openCliCandidate('instagram')];
    default:
      throw new Error(`Unsupported social platform: ${platform}`);
  }
}

function videoCandidates(platform: string): ExternalCandidate[] {
  if (platform === 'bilibili') return [biliCandidate(), openCliCandidate('bilibili')];
  throw new Error(`Unsupported video platform: ${platform}`);
}

function twitterCandidate(): ExternalCandidate {
  return {
    name: 'twitter-cli',
    command: 'twitter',
    probeArgs: ['status'],
    setup: 'pipx install twitter-cli; set TWITTER_AUTH_TOKEN and TWITTER_CT0 if needed',
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '-n', limit];
        case 'read':
        case 'tweet': return ['tweet', publicUrlOrId(input)];
        case 'article': return ['article', publicUrlOrId(input)];
        case 'user': return ['user', requireString(input.user ?? input.username, 'user')];
        case 'user_posts': return ['user-posts', requireString(input.user ?? input.username, 'user'), '-n', limit];
        case 'feed': return ['feed', '-n', limit, ...(hotPopularFilter(input.filter) ? ['--filter'] : [])];
        default: throw new Error(`Unsupported twitter action: ${action}`);
      }
    },
  };
}

function openCliCandidate(platform: string): ExternalCandidate {
  return {
    name: 'OpenCLI',
    command: 'opencli',
    probeArgs: ['--help'],
    setup: `Install OpenCLI and login to ${platform} in Chrome`,
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      const base = [platform];
      switch (platform) {
        case 'twitter':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read' || action === 'tweet') return [...base, 'thread', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'article') return [...base, 'article', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'user_posts') return [...base, 'tweets', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          if (action === 'user') return [...base, 'profile', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          if (action === 'feed') return [...base, 'timeline', '-f', 'yaml'];
          break;
        case 'reddit':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read') return [...base, 'read', publicUrlOrId(input, 'id or url'), '-f', 'yaml'];
          if (action === 'feed') return [...base, 'home', '--limit', limit, '-f', 'yaml'];
          if (action === 'subreddit') return [...base, 'subreddit', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
          if (action === 'hot' || action === 'popular') return [...base, action, '--limit', limit, '-f', 'yaml'];
          if (action === 'subreddit_info') return [...base, 'subreddit-info', requireString(input.subreddit, 'subreddit'), '-f', 'yaml'];
          break;
        case 'xiaohongshu':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'read' || action === 'note') return [...base, 'note', publicUrlOrId(input), '-f', 'yaml'];
          if (action === 'comments') return [...base, 'comments', requireString(input.id, 'id'), '-f', 'yaml'];
          if (action === 'feed' || action === 'hot') return [...base, 'feed', '--limit', limit, '-f', 'yaml'];
          if (action === 'user') return [...base, 'user', requireString(input.user ?? input.userId, 'user'), '-f', 'yaml'];
          break;
        case 'facebook':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'profile') return [...base, 'profile', requireString(input.user ?? input.id, 'user or id'), '-f', 'yaml'];
          if (action === 'feed' || action === 'groups') return [...base, action, '--limit', limit, '-f', 'yaml'];
          break;
        case 'instagram':
          if (action === 'search') return [...base, 'search', requireString(input.query, 'query'), '-f', 'yaml'];
          if (action === 'profile') return [...base, 'profile', requireString(input.user ?? input.username, 'user'), '-f', 'yaml'];
          if (action === 'user') return [...base, 'user', requireString(input.user ?? input.username, 'user'), '--limit', limit, '-f', 'yaml'];
          if (action === 'explore' || action === 'saved' || action === 'feed') return [...base, action === 'feed' ? 'explore' : action, '--limit', limit, '-f', 'yaml'];
          if (action === 'user_posts') return [...base, 'user', requireString(input.user ?? input.username, 'user'), '--limit', limit, '-f', 'yaml'];
          if (action === 'read' || action === 'post') return [...base, 'download', requireString(input.url ?? input.id, 'url or id'), '-f', 'yaml'];
          break;
        case 'bilibili':
          if (action === 'transcript' || action === 'subtitle') return [...base, 'subtitle', publicUrlOrId(input)];
          break;
      }
      throw new Error(`Unsupported ${platform} action for OpenCLI: ${action}`);
    },
  };
}

function rdtCandidate(): ExternalCandidate {
  return {
    name: 'rdt-cli',
    command: 'rdt',
    probeArgs: ['status', '--json'],
    setup: "pipx install 'git+https://github.com/public-clis/rdt-cli.git' && rdt login",
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '--limit', limit];
        case 'read': return ['read', requireRedditUrlOrId(input)];
        case 'feed': return ['feed', '--limit', limit];
        case 'subreddit': return ['sub', requireString(input.subreddit, 'subreddit'), '--limit', limit];
        case 'popular': return ['popular', '--limit', limit];
        case 'all': return ['all', '--limit', limit];
        default: throw new Error(`Unsupported rdt action: ${action}`);
      }
    },
  };
}

function xhsCandidate(): ExternalCandidate {
  return {
    name: 'xhs-cli',
    command: 'xhs',
    probeArgs: ['--help'],
    setup: 'Install xhs-cli; OpenCLI preferred for new installs',
    args(action, input) {
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query')];
        case 'read':
        case 'note': return ['read', publicUrlOrId(input)];
        case 'comments': return ['comments', publicUrlOrId(input)];
        case 'hot': return ['hot'];
        case 'feed': return ['feed'];
        default: throw new Error(`Unsupported xhs action: ${action}`);
      }
    },
  };
}

function biliCandidate(): ExternalCandidate {
  return {
    name: 'bili-cli',
    command: 'bili',
    probeArgs: ['--help'],
    setup: 'Install bili-cli. Do not use yt-dlp for Bilibili; current anti-bot blocks it.',
    args(action, input) {
      const limit = String(numberOrDefault(input.limit, 10));
      switch (action) {
        case 'search': return ['search', requireString(input.query, 'query'), '--type', 'video', '-n', limit];
        case 'hot': return ['hot', '-n', limit];
        case 'details':
        case 'video': return ['video', publicUrlOrId(input)];
        default: throw new Error(`Unsupported bili action: ${action}`);
      }
    },
  };
}

const SECRET_PATTERNS = [
  /Authorization:\s*(Bearer|token|Basic)\s+\S+/gi,
  /Set-Cookie:\s*\S+/gi,
  /Cookie:\s*\S+/gi,
  /(TWITTER_COOKIE|REDDIT_COOKIE|XHS_COOKIE|XIAOHONGSHU_COOKIE|BILIBILI_COOKIE|XUEQIU_COOKIE)[=:]\s*[^\n\r]+/gi,
  /(TWITTER_AUTH_TOKEN|TWITTER_CT0|BILIBILI_SESSDATA|BILIBILI_CSRF|GITHUB_TOKEN|GH_TOKEN|BRAVE_API_KEY|EXA_API_KEY|TAVILY_API_KEY|OPENCLI_TOKEN|REDDIT_CLIENT_SECRET|YOUTUBE_API_KEY|LISTENNOTES_API_KEY|PRODUCTHUNT_API_TOKEN|PATENTSVIEW_API_KEY|CRAWL4AI_API_TOKEN|DEEP_RESEARCH_API_TOKEN|SEARCH_LLM_API_TOKEN|EMBEDDING_SIDECAR_API_TOKEN|OPENAI_API_KEY|GROQ_API_KEY)[=:]\s*\S+/gi,
  /api[Kk]ey["']?\s*[:=]\s*["']?\S+/gi,
  /api_?key\s*[:=]\s*\S+/gi,
];

export function sanitizeExternalOutput(text: string): string {
  let sanitized = text;
  for (const pattern of SECRET_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      const sep = match.search(/[=:]\s*/);
      return sep >= 0 ? match.slice(0, sep + 1) + '***' : '***';
    });
  }
  return sanitized;
}

async function runFirstUsable(
  platform: string,
  candidates: ExternalCandidate[],
  action: string,
  input: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<CommandResult & { backend: string }> {
  if (options.signal?.aborted) throw abortError();
  const ordered = orderCandidates(platform, candidates, options.env ?? process.env);
  const failures: string[] = [];

  for (const candidate of ordered) {
    let commandArgs: string[];
    try {
      commandArgs = candidate.args(action, input);
    } catch (error) {
      failures.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    // Abort during a command propagates as AbortError; it is never treated as
    // a candidate failure that falls through to the next backend or archive.
    const result = await runCommand(candidate.command, commandArgs, options, COMMAND_TIMEOUT_MS);
    if (result.code === 127) {
      failures.push(`${candidate.name}: not installed (${candidate.setup})`);
      continue;
    }
    if (result.code === 0) return { ...result, stdout: sanitizeExternalOutput(result.stdout), stderr: sanitizeExternalOutput(result.stderr), backend: candidate.name };
    failures.push(`${candidate.name}: exit ${result.code}: ${tail(sanitizeExternalOutput(result.stderr || result.stdout))}`);
  }

  throw new Error(`No usable ${platform} backend. ${failures.join('; ')}`);
}

export async function runCommand(command: string, args: string[], options: ReachToolOptions, timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    const child = spawn(command, args, {
      env: externalEnvironment(command, options.env ?? process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killTimer: NodeJS.Timeout | undefined;
    // Termination is shared, but the reason is tracked separately: only a
    // caller AbortSignal produces AbortError; a wall-clock timeout resolves as
    // a non-zero CommandResult (124) so callers can retry or fall back.
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted || options.signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (aborted || options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        // Timeout is a backend failure, not caller cancellation: resolve with
        // the standard timeout exit code so runFirstUsable treats it as a
        // candidate failure eligible for fallback.
        resolve({ code: 124, stdout, stderr: `command timed out after ${timeoutMs}ms` });
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function orderedBackendMetadata(channel: ChannelDefinition, env: Record<string, string | undefined>): ChannelDefinition['backends'] {
  return orderByOverride(channel.name, channel.backends, env);
}

function orderCandidates(platform: string, candidates: ExternalCandidate[], env: Record<string, string | undefined>): ExternalCandidate[] {
  return orderByOverride(platform, candidates, env);
}

function orderByOverride<T extends { name: string }>(platform: string, candidates: T[], env: Record<string, string | undefined>): T[] {
  const override = env[`${platform.toUpperCase()}_BACKEND`] ?? env[`PI_SEARCH_${platform.toUpperCase()}_BACKEND`];
  if (!override) return candidates;
  const normalized = override.toLowerCase();
  const index = candidates.findIndex((candidate) => {
    const name = candidate.name.toLowerCase();
    return name === normalized || (normalized.length >= 3 && name.startsWith(normalized));
  });
  if (index < 0) return candidates;
  const ordered = [...candidates];
  ordered.unshift(...ordered.splice(index, 1));
  return ordered;
}

function probeArgs(backendName: string): string[] {
  if (backendName === 'twitter-cli') return ['status'];
  if (backendName === 'rdt-cli') return ['status', '--json'];
  if (backendName === 'yt-dlp') return ['--version'];
  return ['--help'];
}

function setupMessage(channel: ChannelDefinition): string {
  return channel.backends.map((backend) => `${backend.name}: ${backend.setup ?? 'built in'}`).join('; ');
}

function platformOrInfer(args: Record<string, unknown>, allowed: string[]): string {
  if (typeof args.platform === 'string' && allowed.includes(args.platform)) return args.platform;
  if (typeof args.url === 'string') {
    const host = safeHost(args.url);
    const inferred = [
      ['twitter', ['twitter.com', 'x.com']],
      ['reddit', ['reddit.com', 'redd.it']],
      ['v2ex', ['v2ex.com']],
      ['xiaohongshu', ['xiaohongshu.com', 'xhslink.com']],
      ['facebook', ['facebook.com', 'fb.com']],
      ['instagram', ['instagram.com']],
      ['youtube', ['youtube.com', 'youtu.be']],
      ['bilibili', ['bilibili.com', 'b23.tv']],
    ].find(([, hosts]) => (hosts as string[]).some((hostPart) => host.includes(hostPart)))?.[0];
    if (typeof inferred === 'string' && allowed.includes(inferred)) return inferred;
  }
  throw new Error(`platform is required. Expected one of: ${allowed.join(', ')}`);
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function topicIdFromUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return /\/t\/(\d+)/.exec(value)?.[1];
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  return boundedFetchJson(url, { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  return boundedFetchText(url, { 'User-Agent': USER_AGENT }, signal);
}

function parseFeedItems(xml: string): Array<{ title: string; url: string; summary?: string | undefined }> {
  const rssItems = [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlText(item, ['link']) ?? firstXmlText(item, ['guid']) ?? '',
      summary: firstXmlText(item, ['description', 'summary', 'content:encoded']),
    };
  });
  const atomItems = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)].map((match) => {
    const item = match[1] ?? '';
    return {
      title: firstXmlText(item, ['title']) ?? '',
      url: firstXmlAttribute(item, 'link', 'href') ?? firstXmlText(item, ['id']) ?? '',
      summary: firstXmlText(item, ['summary', 'content']),
    };
  });
  return [...rssItems, ...atomItems].filter((item) => item.title || item.url);
}

function firstXmlText(xml: string, tags: string[]): string | undefined {
  for (const tag of tags) {
    const match = new RegExp(`<${tag.replace(':', '\\:')}[^>]*>([\\s\\S]*?)<\\/${tag.replace(':', '\\:')}>`, 'i').exec(xml);
    if (match?.[1]) return cleanXml(match[1]);
  }
  return undefined;
}

function firstXmlAttribute(xml: string, tag: string, attribute: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*\\s${attribute}="([^"]+)"[^>]*>`, 'i').exec(xml);
  return match?.[1] ? cleanXml(match[1]) : undefined;
}

function cleanXml(text: string): string {
  return cleanText(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' '));
}

function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function publicUrlOrId(input: Record<string, unknown>, name = 'url or id'): string {
  if (typeof input.url === 'string') return validatePublicHttpUrl(input.url);
  return requireString(input.id, name);
}

// Credential-routing guard (not SSRF-policy restoration): cookie-bearing rdt
// invocations may only receive exact Reddit hosts. Lookalike hosts are rejected.
function requireRedditUrlOrId(input: Record<string, unknown>, name = 'id or url'): string {
  if (typeof input.url === 'string' && input.url.trim()) {
    const validated = validatePublicHttpUrl(input.url.trim());
    const host = new URL(validated).hostname.toLowerCase();
    if (host !== 'reddit.com' && host !== 'redd.it' && !host.endsWith('.reddit.com')) {
      throw new Error('rdt read: URL must be a reddit.com or redd.it host');
    }
    return validated;
  }
  return requireString(input.id, name);
}

function externalEnvironment(command: string, env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'GITHUB_TOKEN', 'GH_TOKEN', 'BRAVE_API_KEY', 'EXA_API_KEY', 'TAVILY_API_KEY',
    'SEARXNG_BASE_URL', 'NITTER_BASE_URL', 'LISTENNOTES_API_KEY', 'PRODUCTHUNT_API_TOKEN',
    'PATENTSVIEW_API_KEY', 'CRAWL4AI_BASE_URL', 'CRAWL4AI_API_TOKEN',
    'DEEP_RESEARCH_BASE_URL', 'DEEP_RESEARCH_WORKER_BASE_URL', 'DEEP_RESEARCH_API_TOKEN',
    'DEEP_RESEARCH_MODEL', 'DEEP_RESEARCH_WORKER_MODEL',
    ...(command === 'twitter' ? ['TWITTER_AUTH_TOKEN', 'TWITTER_CT0', 'TWITTER_COOKIE'] : []),
    ...(command === 'xhs' ? ['XHS_COOKIE', 'XIAOHONGSHU_COOKIE'] : []),
    ...(command === 'bili' ? ['BILIBILI_SESSDATA', 'BILIBILI_CSRF', 'BILIBILI_COOKIE'] : []),
    ...(command === 'opencli' ? ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN'] : []),
  ];
  const base = Object.fromEntries(allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key] as string]] : [])));
  return { ...cookieEnvironmentForCommand(command, env), ...base };
}

function cookieEnvironmentForCommand(command: string, env: Record<string, string | undefined>): Record<string, string> {
  if (command === 'twitter') return cookieAuthEnvironment('twitter', env);
  if (command === 'xhs') return cookieAuthEnvironment('xiaohongshu', env);
  if (command === 'bili') return cookieAuthEnvironment('bilibili', env);
  return {};
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function tail(text: string): string {
  const cleaned = text.trim();
  return cleaned.length > 1000 ? cleaned.slice(-1000) : cleaned;
}

// ── Opt-in final web fallback (PI_SEARCH_PLATFORM_WEB_FALLBACK=1) ──
// Last resort only: after live API/cookie/CLI/archive paths are exhausted.
// Never called after invalid input, auth/permission, or abort. Output uses a
// distinct data model (search-results | page-text) and is never merged into
// the platform API models.

function platformWebFallbackEnabled(env: Record<string, string | undefined>): boolean {
  return env[PLATFORM_WEB_FALLBACK_FLAG] === '1';
}

export function buildPlatformWebFallbackChildEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const allowed = [
    'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SHELL', 'LANG', 'LC_ALL', 'PYTHONIOENCODING',
    'PI_SEARCH_STATE_DIR',
  ];
  const childEnv: Record<string, string | undefined> = Object.fromEntries(
    allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key]]] : [])),
  );
  // One-shot scraping mode in the child: plain HTTP fetch only (no scrapling
  // bridge, which restarts and retries), no proxy, no cookies, no platform or
  // API credentials.
  childEnv.PI_SEARCH_SCRAPLING_ENABLED = '0';
  // The Pi-owned CLI child re-loads the environment via loadSearchMcpEnvironment
  // (cli.ts), which otherwise reads the repo `.env`/JSON config and would
  // reintroduce platform/API credentials, cookies, and proxy vars. Point at a
  // path that can never exist so the child's merged environment contains only
  // the allowlisted values above.
  childEnv.PI_SEARCH_ENV_PATH = '/dev/null/pi-atlas-web-fallback-no-env';
  return childEnv;
}

type PlatformWebFallbackExecutor = (tool: string, callArgs: Record<string, unknown>, callOptions: BackendCallOptions) => Promise<BackendCallResult>;

function platformWebFallbackExecutor(options: ReachToolOptions): PlatformWebFallbackExecutor {
  const injected = (options as Record<string, unknown>)._platformWebFallback as PlatformWebFallbackExecutor | undefined;
  if (typeof injected === 'function') return injected;
  // Smallest proven Pi-owned seam: the CLI child used by the public extension.
  const backend = new CliSearchBackend(buildPlatformWebFallbackChildEnv(options.env ?? process.env));
  return (tool, callArgs, callOptions) => backend.callTool(tool, callArgs, callOptions);
}

function fallbackAbortError(): Error {
  const error = new Error('Platform web fallback aborted');
  error.name = 'AbortError';
  return error;
}

function fallbackCallOptions(signal: AbortSignal | undefined): BackendCallOptions {
  return signal ? { signal } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function webSearchFallback(
  platform: string,
  action: string,
  query: string,
  args: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<BackendCallResult> {
  if (options.signal?.aborted) throw fallbackAbortError();
  const executor = platformWebFallbackExecutor(options);
  const result = await executor('web_search', { query, limit: numberOrDefault(args.limit, 8) }, fallbackCallOptions(options.signal));
  const details = isRecord(result.details) ? { ...result.details } : {};
  return { ...result, details: { ...details, platform, action, backend: 'web-search-fallback', dataModel: 'search-results', degraded: true } };
}

async function webPageFallback(
  platform: string,
  action: string,
  url: string,
  args: Record<string, unknown>,
  options: ReachToolOptions,
): Promise<BackendCallResult> {
  if (options.signal?.aborted) throw fallbackAbortError();
  // Defense in depth: the page fallback may only fetch canonical platform
  // URLs. Arbitrary/lookalike hosts (including localhost) are rejected even
  // if a call site ever passes a raw user URL.
  const host = safeHost(url);
  const canonicalHost = platform === 'youtube'
    ? (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com'))
    : platform === 'reddit'
      ? (host === 'reddit.com' || host === 'redd.it' || host.endsWith('.reddit.com'))
      : true;
  if (!canonicalHost || (platform === 'youtube' && !videoIdFromUrl(url))) {
    throw new Error(`web page fallback requires a canonical ${platform} URL`);
  }
  const executor = platformWebFallbackExecutor(options);
  const callArgs: Record<string, unknown> = { action: 'read', url };
  if (typeof args.maxChars === 'number') callArgs.maxChars = args.maxChars;
  const result = await executor('agentic_browse', callArgs, fallbackCallOptions(options.signal));
  const fetchedUrl = isRecord(result.details) && typeof result.details.url === 'string' ? result.details.url : url;
  return { ...result, details: { platform, action, backend: 'web-fetch-fallback', dataModel: 'page-text', degraded: true, url: fetchedUrl, requestedUrl: url } };
}

function redditFallbackPageUrl(action: string, args: Record<string, unknown>): string {
  if (action === 'read') {
    // Only canonical Reddit post IDs (explicit id, or id extracted from a
    // canonical reddit.com/redd.it URL) may be fetched. Arbitrary or lookalike
    // URLs — including localhost — are rejected before the page fallback runs.
    const id = redditPostId(args).replace(/^t3_/, '');
    return `https://www.reddit.com/comments/${encodeURIComponent(id)}`;
  }
  const sub = typeof args.subreddit === 'string' && args.subreddit.trim() ? args.subreddit.trim() : undefined;
  return sub ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/` : 'https://www.reddit.com/';
}

async function redditWebFallback(action: string, args: Record<string, unknown>, options: ReachToolOptions): Promise<BackendCallResult> {
  if (action === 'search') {
    return webSearchFallback('reddit', action, requireString(args.query, 'query'), args, options);
  }
  return webPageFallback('reddit', action, redditFallbackPageUrl(action, args), args, options);
}

function youtubeFallbackQuery(action: string, args: Record<string, unknown>): string {
  if (typeof args.query === 'string' && args.query.trim()) return args.query.trim();
  return action === 'hot' ? 'trending' : 'popular';
}
