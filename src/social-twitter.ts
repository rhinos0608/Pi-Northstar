// Stage 2 social platform worker for Twitter/X.
//
// Owns the closed command mapping, fixture normalization, and backend plans
// for the two verified Twitter backends:
//   - `twitter-cli` 0.8.5 (Python, cookie session in its trusted local store;
//     spawned with buildPythonChildEnvironment())
//   - `opencli-twitter` (OpenCLI 1.8.6, `twitter` site commands, always `-f json`;
//     spawned with openCliChildEnv() so operator-owned OPENCLI_* passes through)
//
// Workers never choose global fallback order; the central integrator
// (src/social.ts) selects among the declared plans. Twitter pagination is
// `none` for every operation: limit only, no fabricated cursors.
//
// Safety invariants:
//   - argv is generated only from the closed mappings below; no download,
//     write, file-output, or mutation command is ever emitted.
//   - trending/notifications are OpenCLI-only (twitter-cli has no such read
//     commands), matching the Stage 2 capability table.

import { spawn } from 'node:child_process';
import { resolveCliCommand } from './cli-command.js';
import { buildPythonChildEnvironment } from './python-child-env.js';
import { redactCliDiagnostics, requireCliPositional } from './social-cli-safety.js';
import { openCliChildEnv } from './social-opencli.js';
import {
  SocialError,
  parseSocialDate,
  selectorSpecFor,
  socialEntityId,
  validateSocialPage,
  type BackendActionCapability,
  type BackendCapability,
  type SocialActorV1,
  type SocialBackendPlan,
  type SocialCommentV1,
  type SocialEntityV1,
  type SocialExecutionContext,
  type SocialMetricsV1,
  type SocialAccountV1,
  type SocialNotificationV1,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialPostV1,
  type SocialRequest,
  type SocialTopicV1,
} from './social-contract.js';

export const TWITTER_COMMAND_TIMEOUT_MS = 120_000;
const MAX_CHILD_OUTPUT_CHARS = 2_000_000;
const TWITTER_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;
const TWITTER_ID_PATTERN = /^\d{1,25}$/;

// ── Capability declarations (single source of truth for this worker) ──

function operations(
  entries: ReadonlyArray<{ action: BackendActionCapability['action']; upstreamAction: readonly string[] }>,
): BackendActionCapability[] {
  return entries.map(({ action, upstreamAction }) => ({
    action,
    upstreamAction,
    auth: ['cookie' as const],
    pagination: 'none' as const,
    required: selectorSpecFor('twitter', action).required ?? [],
    maxLimit: 100,
  }));
}

export const TWITTER_BACKEND_CAPABILITIES: readonly BackendCapability[] = [
  {
    name: 'twitter-cli',
    type: 'external',
    command: 'twitter',
    verifiedVersion: '0.8.5',
    operations: operations([
      { action: 'search', upstreamAction: ['search'] },
      { action: 'get_post', upstreamAction: ['tweet'] },
      { action: 'get_thread', upstreamAction: ['tweet'] },
      { action: 'get_comments', upstreamAction: ['tweet'] },
      { action: 'get_comment_replies', upstreamAction: ['tweet'] },
      { action: 'get_profile', upstreamAction: ['user'] },
      { action: 'get_user_posts', upstreamAction: ['user-posts'] },
      { action: 'get_followers', upstreamAction: ['followers'] },
      { action: 'get_following', upstreamAction: ['following'] },
      { action: 'get_feed', upstreamAction: ['feed'] },
      { action: 'get_saved', upstreamAction: ['bookmarks'] },
    ]),
  },
  {
    name: 'opencli-twitter',
    type: 'external',
    command: 'opencli',
    verifiedVersion: '1.8.6',
    operations: operations([
      { action: 'search', upstreamAction: ['twitter', 'search'] },
      { action: 'get_post', upstreamAction: ['twitter', 'thread'] },
      { action: 'get_thread', upstreamAction: ['twitter', 'thread'] },
      { action: 'get_comments', upstreamAction: ['twitter', 'thread'] },
      { action: 'get_comment_replies', upstreamAction: ['twitter', 'thread'] },
      { action: 'get_profile', upstreamAction: ['twitter', 'profile'] },
      { action: 'get_user_posts', upstreamAction: ['twitter', 'tweets'] },
      { action: 'get_followers', upstreamAction: ['twitter', 'followers'] },
      { action: 'get_following', upstreamAction: ['twitter', 'following'] },
      { action: 'get_feed', upstreamAction: ['twitter', 'timeline'] },
      { action: 'get_trending', upstreamAction: ['twitter', 'trending'] },
      { action: 'get_saved', upstreamAction: ['twitter', 'bookmarks'] },
      { action: 'get_notifications', upstreamAction: ['twitter', 'notifications'] },
    ]),
  },
];

const TWITTER_CLI_CAPABILITY = TWITTER_BACKEND_CAPABILITIES[0]!;
const OPENCLI_CAPABILITY = TWITTER_BACKEND_CAPABILITIES[1]!;

// ── Closed argv mapping ──
// Every argv starts with the command's read subcommand and uses the request's
// validated selectors only. No flag outside these tables is ever emitted: no
// download, no file-output (-o/--output), no mutation command.

function normalizeHandle(raw: string): string {
  const vetted = requireCliPositional(raw, 'user', 'twitter');
  const handle = vetted.replace(/^@+/, '');
  if (!TWITTER_HANDLE_PATTERN.test(handle)) {
    throw new SocialError('invalid_request', 'invalid Twitter handle');
  }
  return handle;
}

function normalizeTweetId(raw: string, field: 'postId' | 'commentId'): string {
  const vetted = requireCliPositional(raw, field, 'twitter');
  if (!TWITTER_ID_PATTERN.test(vetted)) {
    throw new SocialError('invalid_request', `invalid Twitter ${field}`);
  }
  return vetted;
}

export function twitterCliArgs(request: SocialRequest): string[] {
  const limit = String(request.limit);
  const since = request.timeRange !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(request.timeRange)
    ? ['--since', request.timeRange]
    : [];
  switch (request.action) {
    case 'search': {
      const query = requireCliPositional(request.query, 'query', 'twitter');
      const type = request.sort === 'top' || request.sort === 'latest' ? ['-t', request.sort] : [];
      return ['search', query, '-n', limit, ...type, ...since, '--json'];
    }
    case 'get_post':
      return ['tweet', normalizeTweetId(request.postId!, 'postId'), '--json'];
    case 'get_thread':
    case 'get_comments':
      return ['tweet', normalizeTweetId(request.postId!, 'postId'), '-n', limit, '--json'];
    case 'get_comment_replies':
      return ['tweet', normalizeTweetId(request.commentId!, 'commentId'), '-n', limit, '--json'];
    case 'get_profile':
      return ['user', normalizeHandle(request.user!), '--json'];
    case 'get_user_posts':
      return ['user-posts', normalizeHandle(request.user!), '-n', limit, '--json'];
    case 'get_followers':
      return ['followers', normalizeHandle(request.user!), '-n', limit, '--json'];
    case 'get_following':
      return ['following', normalizeHandle(request.user!), '-n', limit, '--json'];
    case 'get_feed': {
      const type = request.feedVariant === 'for-you' || request.feedVariant === 'following'
        ? ['-t', request.feedVariant]
        : [];
      return ['feed', '-n', limit, ...type, '--json'];
    }
    case 'get_saved':
      return ['bookmarks', '-n', limit, '--json'];
    default:
      throw new SocialError('backend_unavailable', `twitter-cli has no read operation for ${request.action}`, {
        platform: 'twitter', backend: 'twitter-cli', retryable: false,
      });
  }
}

export function openCliTwitterArgs(request: SocialRequest): string[] {
  const limit = String(request.limit);
  switch (request.action) {
    case 'search': {
      const query = requireCliPositional(request.query, 'query', 'twitter');
      const product = request.sort === 'top' || request.sort === 'live' ? ['--product', request.sort] : [];
      return ['twitter', 'search', query, '--limit', limit, ...product, '-f', 'json'];
    }
    case 'get_post':
    case 'get_thread':
    case 'get_comments':
      return ['twitter', 'thread', normalizeTweetId(request.postId!, 'postId'), '--limit', limit, '-f', 'json'];
    case 'get_comment_replies':
      return ['twitter', 'thread', normalizeTweetId(request.commentId!, 'commentId'), '--limit', limit, '-f', 'json'];
    case 'get_profile':
      return ['twitter', 'profile', normalizeHandle(request.user!), '-f', 'json'];
    case 'get_user_posts':
      return ['twitter', 'tweets', normalizeHandle(request.user!), '--limit', limit, '-f', 'json'];
    case 'get_followers':
      return ['twitter', 'followers', normalizeHandle(request.user!), '--limit', limit, '-f', 'json'];
    case 'get_following':
      return ['twitter', 'following', normalizeHandle(request.user!), '--limit', limit, '-f', 'json'];
    case 'get_feed': {
      const type = request.feedVariant === 'for-you' || request.feedVariant === 'following'
        ? ['--type', request.feedVariant]
        : [];
      return ['twitter', 'timeline', '--limit', limit, ...type, '-f', 'json'];
    }
    case 'get_trending':
      return ['twitter', 'trending', '--limit', limit, '-f', 'json'];
    case 'get_saved':
      return ['twitter', 'bookmarks', '--limit', limit, '-f', 'json'];
    case 'get_notifications':
      return ['twitter', 'notifications', '--limit', limit, '-f', 'json'];
    default:
      throw new SocialError('backend_unavailable', `OpenCLI twitter has no read operation for ${request.action}`, {
        platform: 'twitter', backend: 'opencli-twitter', retryable: false,
      });
  }
}

// ── Subprocess execution ──

export interface SocialCliInvocation {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SocialCliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SocialCliRunner = (invocation: SocialCliInvocation) => Promise<SocialCliResult>;

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function defaultRunner(invocation: SocialCliInvocation): Promise<SocialCliResult> {
  return new Promise((resolve, reject) => {
    if (invocation.signal?.aborted) {
      reject(abortError());
      return;
    }
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    // win32: CreateProcess skips PATHEXT lookup, so resolve bare commands to
    // their on-disk .cmd/.exe path first. Spawn stays shell:false — argv must
    // never reach cmd.exe parsing (shell:true concatenates args unescaped).
    const child = spawn(resolveCliCommand(invocation.command), invocation.args, {
      env: invocation.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5_000);
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, invocation.timeoutMs);
    invocation.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-MAX_CHILD_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-MAX_CHILD_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      invocation.signal?.removeEventListener('abort', onAbort);
      if (aborted || invocation.signal?.aborted) {
        reject(abortError());
        return;
      }
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      invocation.signal?.removeEventListener('abort', onAbort);
      if (aborted || invocation.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `command timed out after ${invocation.timeoutMs}ms` });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function parseCliJsonPayload(stdout: string, backend: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new SocialError('malformed_upstream', `${backend} returned empty output`, {
      platform: 'twitter', backend,
    });
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new SocialError('malformed_upstream', `${backend} returned non-JSON output`, {
      platform: 'twitter', backend, cause: error,
    });
  }
}

// ── Fixture shapes ──
// twitter-cli --json emits arrays of tweet dicts, or a single user dict for
// `user` (shapes per public-clis/twitter-cli serialization.py at v0.8.5).
// OpenCLI `-f json` prints the command's raw row array (shapes per
// jackwener/OpenCLI clis/twitter/*.js at v1.8.6).

interface TwitterCliTweetRow {
  id: unknown;
  text: unknown;
  author?: {
    id?: unknown;
    name?: unknown;
    screenName?: unknown;
    profileImageUrl?: unknown;
    verified?: unknown;
  };
  metrics?: {
    likes?: unknown;
    retweets?: unknown;
    replies?: unknown;
    quotes?: unknown;
    views?: unknown;
    bookmarks?: unknown;
  };
  createdAt?: unknown;
  createdAtISO?: unknown;
  media?: ReadonlyArray<{ type?: unknown; url?: unknown; width?: unknown; height?: unknown }>;
  articleTitle?: unknown;
  isRetweet?: unknown;
  retweetedBy?: unknown;
}

interface TwitterCliUserRow {
  id: unknown;
  name: unknown;
  screenName: unknown;
  bio?: unknown;
  followers?: unknown;
  following?: unknown;
  verified?: unknown;
  profileImageUrl?: unknown;
  createdAt?: unknown;
  createdAtISO?: unknown;
}

interface OpenCliTweetRow {
  id: unknown;
  author?: unknown;
  bio?: unknown;
  name?: unknown;
  text: unknown;
  likes?: unknown;
  retweets?: unknown;
  replies?: unknown;
  views?: unknown;
  created_at?: unknown;
  url?: unknown;
  media_urls?: unknown;
  media_posters?: unknown;
}

interface OpenCliProfileRow {
  screen_name?: unknown;
  name?: unknown;
  bio?: unknown;
  followers?: unknown;
  following?: unknown;
  verified?: unknown;
  created_at?: unknown;
}

interface OpenCliTrendRow {
  rank?: unknown;
  topic?: unknown;
  category?: unknown;
}

interface OpenCliNotificationRow {
  id: unknown;
  action?: unknown;
  author?: unknown;
  text?: unknown;
  url?: unknown;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// ── Normalization: twitter-cli ──

function twitterCliActor(row: TwitterCliTweetRow): SocialActorV1 | undefined {
  const author = row.author;
  if (typeof author !== 'object' || author === null) return undefined;
  const actor: SocialActorV1 = {};
  const id = optionalString(author.id);
  const handle = optionalString(author.screenName);
  const displayName = optionalString(author.name);
  const avatar = optionalString(author.profileImageUrl);
  if (id !== undefined) actor.id = id;
  if (handle !== undefined) actor.handle = handle;
  if (displayName !== undefined) actor.displayName = displayName;
  if (avatar !== undefined) actor.avatarUrl = avatar;
  if (author.verified === true) actor.verified = true;
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function twitterCliMetrics(row: TwitterCliTweetRow): SocialMetricsV1 | undefined {
  const metrics = row.metrics;
  if (typeof metrics !== 'object' || metrics === null) return undefined;
  const mapped: SocialMetricsV1 = {};
  const pairs: ReadonlyArray<[keyof SocialMetricsV1, unknown]> = [
    ['likes', metrics.likes],
    ['reposts', metrics.retweets],
    ['replies', metrics.replies],
    ['quotes', metrics.quotes],
    ['views', metrics.views],
    ['saves', metrics.bookmarks],
  ];
  for (const [key, value] of pairs) {
    const number = optionalFiniteNumber(value);
    if (number !== undefined) mapped[key] = number;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function twitterCliMedia(row: TwitterCliTweetRow): NonNullable<SocialPostV1['media']> | undefined {
  if (!Array.isArray(row.media) || row.media.length === 0) return undefined;
  const media: NonNullable<SocialPostV1['media']> = [];
  for (const item of row.media) {
    if (typeof item !== 'object' || item === null) continue;
    const url = optionalString(item.url);
    if (url === undefined || !isValidHttpUrl(url)) continue;
    const entry: NonNullable<SocialPostV1['media']>[number] = { url };
    if (item.type === 'photo') entry.type = 'image';
    else if (item.type === 'video') entry.type = 'video';
    else if (item.type === 'animated_gif') entry.type = 'gif';
    const width = optionalFiniteNumber(item.width);
    const height = optionalFiniteNumber(item.height);
    if (width !== undefined) entry.width = width;
    if (height !== undefined) entry.height = height;
    media.push(entry);
  }
  return media.length > 0 ? media : undefined;
}

function normalizeTwitterCliTweet(
  request: SocialRequest,
  row: TwitterCliTweetRow,
  backend: string,
  warnings: string[],
): SocialPostV1 | undefined {
  const id = typeof row.id === 'string' && row.id.trim().length > 0 ? row.id.trim() : undefined;
  if (id === undefined) {
    warnings.push('dropped tweet row without id');
    return undefined;
  }
  const title = optionalString(row.articleTitle);
  const text = optionalString(row.text);
  if (title === undefined && text === undefined) {
    warnings.push(`dropped tweet ${id} without text`);
    return undefined;
  }
  const handle = optionalString(
    row.author !== undefined && typeof row.author === 'object' ? row.author.screenName : undefined,
  );
  const publishedAt = parseSocialDate(row.createdAtISO ?? row.createdAt);
  if ((row.createdAtISO ?? row.createdAt) !== undefined && publishedAt === undefined) {
    warnings.push(`tweet ${id} has an invalid date; publishedAt omitted`);
  }
  const author = twitterCliActor(row);
  const metrics = twitterCliMetrics(row);
  const media = twitterCliMedia(row);
  const entity: SocialPostV1 = {
    version: 1,
    kind: 'social_post',
    id: socialEntityId('twitter', 'social_post', id),
    platformId: id,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle ?? 'i'}/status/${id}`,
    contentType: title !== undefined ? 'article' : 'post',
  };
  if (publishedAt !== undefined) entity.publishedAt = publishedAt;
  if (title !== undefined) entity.title = title;
  if (text !== undefined) entity.text = text;
  if (author !== undefined) entity.author = author;
  if (metrics !== undefined) entity.metrics = metrics;
  if (media !== undefined) entity.media = media;
  if (request.action === 'get_thread' || request.action === 'get_comments' || request.action === 'get_comment_replies') {
    const threadAnchor = request.postId ?? request.commentId;
    if (threadAnchor !== undefined) entity.threadId = threadAnchor;
  }
  if (row.isRetweet === true && typeof row.retweetedBy === 'string' && row.retweetedBy.length > 0) {
    warnings.push(`tweet ${id} is a retweet by @${row.retweetedBy}`);
  }
  return entity;
}

function normalizeTwitterCliProfile(
  row: TwitterCliUserRow,
  backend: string,
  warnings: string[],
): SocialAccountV1 | undefined {
  if (typeof row !== 'object' || row === null) {
    warnings.push('dropped malformed user row');
    return undefined;
  }
  const handle = optionalString(row.screenName);
  const id = optionalString(row.id);
  if (handle === undefined && id === undefined) {
    warnings.push('dropped user row without handle or id');
    return undefined;
  }
  const nativeId = handle ?? id!;
  const displayName = optionalString(row.name);
  const bio = optionalString(row.bio);
  const metrics: SocialMetricsV1 = {};
  const followers = optionalFiniteNumber(row.followers);
  const following = optionalFiniteNumber(row.following);
  if (followers !== undefined) metrics.followers = followers;
  if (following !== undefined) metrics.following = following;
  const publishedAt = parseSocialDate(row.createdAtISO ?? row.createdAt);
  if ((row.createdAtISO ?? row.createdAt) !== undefined && publishedAt === undefined) {
    warnings.push(`profile ${nativeId} has an invalid date; publishedAt omitted`);
  }
  const profile: SocialAccountV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('twitter', 'social_account', nativeId),
    platformId: nativeId,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle ?? nativeId}`,
  };
  if (publishedAt !== undefined) profile.publishedAt = publishedAt;
  if (handle !== undefined) profile.handle = handle;
  if (displayName !== undefined) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (Object.keys(metrics).length > 0) profile.metrics = metrics;
  return profile;
}

// ── Normalization: OpenCLI ──

function openCliAuthor(handle: unknown, displayName: unknown): SocialActorV1 | undefined {
  const actor: SocialActorV1 = {};
  const handleValue = optionalString(handle);
  const name = optionalString(displayName);
  if (handleValue !== undefined) actor.handle = handleValue;
  if (name !== undefined) actor.displayName = name;
  return Object.keys(actor).length > 0 ? actor : undefined;
}

function openCliMetrics(row: OpenCliTweetRow): SocialMetricsV1 | undefined {
  const mapped: SocialMetricsV1 = {};
  const pairs: ReadonlyArray<[keyof SocialMetricsV1, unknown]> = [
    ['likes', row.likes],
    ['reposts', row.retweets],
    ['replies', row.replies],
    ['views', row.views],
  ];
  for (const [key, value] of pairs) {
    const number = optionalFiniteNumber(value);
    if (number !== undefined) mapped[key] = number;
  }
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function openCliMedia(row: OpenCliTweetRow): NonNullable<SocialPostV1['media']> | undefined {
  if (!Array.isArray(row.media_urls) || row.media_urls.length === 0) return undefined;
  const posters = Array.isArray(row.media_posters) ? row.media_posters : [];
  const media: NonNullable<SocialPostV1['media']> = [];
  for (const [index, entry] of row.media_urls.entries()) {
    const url = optionalString(entry);
    if (url === undefined || !isValidHttpUrl(url)) continue;
    const item: NonNullable<SocialPostV1['media']>[number] = { url };
    const poster = optionalString(posters[index]);
    if (poster !== undefined) item.thumbnailUrl = poster;
    media.push(item);
  }
  return media.length > 0 ? media : undefined;
}

function normalizeOpenCliTweet(
  request: SocialRequest,
  row: OpenCliTweetRow,
  backend: string,
  warnings: string[],
): SocialPostV1 | undefined {
  const id = optionalString(row.id);
  if (id === undefined) {
    warnings.push('dropped tweet row without id');
    return undefined;
  }
  const text = optionalString(row.text);
  if (text === undefined) {
    warnings.push(`dropped tweet ${id} without text`);
    return undefined;
  }
  const url = optionalString(row.url);
  if (url !== undefined && !isValidHttpUrl(url)) {
    warnings.push(`tweet ${id} has an invalid url; url omitted`);
  }
  const publishedAt = parseSocialDate(row.created_at);
  if (row.created_at !== undefined && publishedAt === undefined) {
    warnings.push(`tweet ${id} has an invalid date; publishedAt omitted`);
  }
  const author = openCliAuthor(row.author, row.name);
  const metrics = openCliMetrics(row);
  const media = openCliMedia(row);
  const entity: SocialPostV1 = {
    version: 1,
    kind: 'social_post',
    id: socialEntityId('twitter', 'social_post', id),
    platformId: id,
    platform: 'twitter',
    backend,
    contentType: 'post',
    text,
  };
  if (url !== undefined && isValidHttpUrl(url)) entity.url = url;
  if (publishedAt !== undefined) entity.publishedAt = publishedAt;
  if (author !== undefined) entity.author = author;
  if (metrics !== undefined) entity.metrics = metrics;
  if (media !== undefined) entity.media = media;
  if (request.action === 'get_thread' || request.action === 'get_comments' || request.action === 'get_comment_replies') {
    const threadAnchor = request.postId ?? request.commentId;
    if (threadAnchor !== undefined) entity.threadId = threadAnchor;
  }
  return entity;
}

function normalizeOpenCliProfile(
  row: OpenCliProfileRow,
  backend: string,
  warnings: string[],
): SocialAccountV1 | undefined {
  const handle = optionalString(row.screen_name);
  if (handle === undefined) {
    warnings.push('dropped profile row without screen_name');
    return undefined;
  }
  const displayName = optionalString(row.name);
  const bio = optionalString(row.bio);
  const metrics: SocialMetricsV1 = {};
  const followers = optionalFiniteNumber(row.followers);
  const following = optionalFiniteNumber(row.following);
  if (followers !== undefined) metrics.followers = followers;
  if (following !== undefined) metrics.following = following;
  const publishedAt = parseSocialDate(row.created_at);
  if (row.created_at !== undefined && publishedAt === undefined) {
    warnings.push(`profile @${handle} has an invalid date; publishedAt omitted`);
  }
  const profile: SocialAccountV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('twitter', 'social_account', handle),
    platformId: handle,
    platform: 'twitter',
    backend,
    url: `https://x.com/${handle}`,
    handle,
  };
  if (publishedAt !== undefined) profile.publishedAt = publishedAt;
  if (displayName !== undefined) profile.displayName = displayName;
  if (bio !== undefined) profile.bio = bio;
  if (Object.keys(metrics).length > 0) profile.metrics = metrics;
  return profile;
}

// ── Page assembly ──

function pageFromEntities(
  request: SocialRequest,
  entities: readonly SocialEntityV1[],
  warnings: string[],
): SocialPageV1 {
  const page: SocialPageV1 = {
    entities: [...entities],
    pagination: {
      supported: false,
      limit: request.limit,
      returned: entities.length,
      hasMore: false,
    },
    partial: warnings.length > 0,
    warnings: [...warnings],
  };
  const validated = validateSocialPage(page);
  if (!validated.ok || validated.page === undefined) {
    throw new SocialError(
      'malformed_upstream',
      `normalized page failed validation: ${validated.issues.join('; ')}`,
      { platform: 'twitter' },
    );
  }
  return validated.page;
}

function expectList(payload: unknown, backend: string): unknown[] {
  if (!Array.isArray(payload)) {
    throw new SocialError('malformed_upstream', `${backend} payload is not a list`, {
      platform: 'twitter', backend,
    });
  }
  return payload;
}

function notFound(backend: string, message: string): never {
  throw new SocialError('not_found', message, { platform: 'twitter', backend });
}

function toComment(
  post: SocialPostV1,
  request: SocialRequest,
  parentNativeId: string | undefined,
  directParent: string | undefined,
): SocialCommentV1 {
  const platformId = post.platformId ?? post.id;
  const comment: SocialCommentV1 = {
    version: 1,
    kind: 'social_comment',
    id: socialEntityId('twitter', 'social_comment', platformId),
    platformId,
    platform: 'twitter',
    backend: post.backend,
    postId: parentNativeId ?? request.postId ?? request.commentId ?? platformId,
    depth: 1,
    text: post.text ?? '',
  };
  if (post.url !== undefined) comment.url = post.url;
  if (post.publishedAt !== undefined) comment.publishedAt = post.publishedAt;
  if (directParent !== undefined) comment.parentCommentId = directParent;
  if (post.author !== undefined) comment.author = post.author;
  if (post.metrics !== undefined) comment.metrics = post.metrics;
  return comment;
}

// ── Worker ──

export interface SocialTwitterWorkerOptions {
  /** Test seam: override subprocess execution. */
  runner?: SocialCliRunner;
  /** Parent environment passed through buildPythonChildEnvironment(). */
  parentEnv?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export class SocialTwitterWorker implements SocialPlatformWorker {
  readonly platforms = ['twitter'] as const;

  private readonly runner: SocialCliRunner;

  constructor(private readonly options: SocialTwitterWorkerOptions = {}) {
    this.runner = options.runner ?? defaultRunner;
  }

  async plans(
    request: SocialRequest,
    context: SocialExecutionContext,
  ): Promise<readonly SocialBackendPlan[]> {
    const plans: SocialBackendPlan[] = [];
    for (const capability of [TWITTER_CLI_CAPABILITY, OPENCLI_CAPABILITY]) {
      if (!capability.operations.some((operation) => operation.action === request.action)) continue;
      const args = capability === TWITTER_CLI_CAPABILITY ? twitterCliArgs(request) : openCliTwitterArgs(request);
      const self = this;
      plans.push({
        backend: capability.name,
        authTier: 'cookie',
        pagination: 'none',
        async execute(signal?: AbortSignal): Promise<unknown> {
          return self.execute(capability, args, signal ?? context.signal);
        },
      });
    }
    return plans;
  }

  normalize(request: SocialRequest, plan: SocialBackendPlan, payload: unknown): SocialPageV1 {
    const warnings: string[] = [];
    if (plan.backend === 'twitter-cli') {
      return this.normalizeTwitterCli(request, payload, warnings);
    }
    if (plan.backend === 'opencli-twitter') {
      return this.normalizeOpenCli(request, payload, warnings);
    }
    throw new SocialError('backend_unavailable', `unknown Twitter backend: ${plan.backend}`, {
      platform: 'twitter', backend: plan.backend, retryable: false,
    });
  }

  private normalizeTwitterCli(request: SocialRequest, payload: unknown, warnings: string[]): SocialPageV1 {
    const backend = 'twitter-cli';
    switch (request.action) {
      case 'get_post': {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (row === undefined || typeof row !== 'object') {
          notFound(backend, 'tweet not found');
        }
        const entity = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
        if (entity === undefined) {
          throw new SocialError('malformed_upstream', 'tweet payload is malformed', {
            platform: 'twitter', backend,
          });
        }
        return pageFromEntities(request, [entity], warnings);
      }
      case 'get_thread': {
        const rows = expectList(payload, backend);
        if (rows.length === 0) notFound(backend, 'thread not found');
        const entities: SocialEntityV1[] = [];
        const root = normalizeTwitterCliTweet(request, rows[0] as TwitterCliTweetRow, backend, warnings);
        if (root !== undefined) entities.push(root);
        for (const row of rows.slice(1)) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed reply row');
            continue;
          }
          const reply = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
          if (reply !== undefined) {
            entities.push(toComment(reply, request, request.postId, undefined));
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_comments': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows.slice(1)) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed reply row');
            continue;
          }
          const reply = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
          if (reply !== undefined) {
            entities.push(toComment(reply, request, request.postId, undefined));
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_comment_replies': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows.slice(1)) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed reply row');
            continue;
          }
          const reply = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
          if (reply !== undefined) {
            entities.push(toComment(reply, request, request.commentId, request.commentId));
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_profile': {
        const row = Array.isArray(payload) ? payload[0] : payload;
        if (row === undefined || typeof row !== 'object') {
          notFound(backend, 'profile not found');
        }
        const profile = normalizeTwitterCliProfile(row as TwitterCliUserRow, backend, warnings);
        if (profile === undefined) {
          throw new SocialError('malformed_upstream', 'profile payload is malformed', {
            platform: 'twitter', backend,
          });
        }
        return pageFromEntities(request, [profile], warnings);
      }
      case 'get_followers':
      case 'get_following':
      case 'search':
      case 'get_user_posts':
      case 'get_feed':
      case 'get_saved': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed row');
            continue;
          }
          if (request.action === 'get_followers' || request.action === 'get_following') {
            const profile = normalizeTwitterCliProfile(row as TwitterCliUserRow, backend, warnings);
            if (profile !== undefined) entities.push(profile);
          } else {
            const entity = normalizeTwitterCliTweet(request, row as TwitterCliTweetRow, backend, warnings);
            if (entity !== undefined) entities.push(entity);
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      default:
        throw new SocialError('backend_unavailable', `twitter-cli cannot serve ${request.action}`, {
          platform: 'twitter', backend, retryable: false,
        });
    }
  }

  private normalizeOpenCli(request: SocialRequest, payload: unknown, warnings: string[]): SocialPageV1 {
    const backend = 'opencli-twitter';
    switch (request.action) {
      case 'get_trending': {
        const rows = expectList(payload, backend);
        const entities: SocialTopicV1[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed trend row');
            continue;
          }
          const trend = row as OpenCliTrendRow;
          const topic = optionalString(trend.topic);
          if (topic === undefined) {
            warnings.push('dropped trend row without topic');
            continue;
          }
          const nativeId = `trend-${optionalString(trend.rank) ?? topic}`;
          const entity: SocialTopicV1 = {
            version: 1,
            kind: 'social_topic',
            id: socialEntityId('twitter', 'social_topic', nativeId),
            platform: 'twitter',
            backend,
            name: topic,
          };
          const category = optionalString(trend.category);
          if (category !== undefined) entity.description = category;
          entities.push(entity);
        }
        if (rows.length > 0) {
          warnings.push('trend ids are rank-derived, not native trend ids');
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_notifications': {
        const rows = expectList(payload, backend);
        const entities: SocialNotificationV1[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed notification row');
            continue;
          }
          const notification = row as OpenCliNotificationRow;
          const id = optionalString(notification.id);
          if (id === undefined) {
            warnings.push('dropped notification row without id');
            continue;
          }
          const url = optionalString(notification.url);
          const entity: SocialNotificationV1 = {
            version: 1,
            kind: 'social_notification',
            id: socialEntityId('twitter', 'social_notification', id),
            platformId: id,
            platform: 'twitter',
            backend,
          };
          if (url !== undefined && isValidHttpUrl(url)) entity.url = url;
          const type = optionalString(notification.action);
          if (type !== undefined) entity.type = type;
          const text = optionalString(notification.text);
          if (text !== undefined) entity.text = text;
          const handle = optionalString(notification.author);
          if (handle !== undefined) entity.actor = { handle };
          entities.push(entity);
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_profile': {
        const rows = expectList(payload, backend);
        const profile = rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null
          ? normalizeOpenCliProfile(rows[0] as OpenCliProfileRow, backend, warnings)
          : undefined;
        if (profile === undefined) {
          notFound(backend, 'profile not found');
        }
        return pageFromEntities(request, [profile], warnings);
      }
      case 'get_followers':
      case 'get_following': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed user row');
            continue;
          }
          const profile = normalizeOpenCliProfile(row as OpenCliProfileRow, backend, warnings);
          if (profile !== undefined) entities.push(profile);
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_post': {
        const rows = expectList(payload, backend);
        if (rows.length === 0) notFound(backend, 'tweet not found');
        const entity = normalizeOpenCliTweet(request, rows[0] as OpenCliTweetRow, backend, warnings);
        if (entity === undefined) {
          throw new SocialError('malformed_upstream', 'tweet payload is malformed', {
            platform: 'twitter', backend,
          });
        }
        return pageFromEntities(request, [entity], warnings);
      }
      case 'get_thread': {
        const rows = expectList(payload, backend);
        if (rows.length === 0) notFound(backend, 'thread not found');
        const entities: SocialEntityV1[] = [];
        const root = normalizeOpenCliTweet(request, rows[0] as OpenCliTweetRow, backend, warnings);
        if (root !== undefined) entities.push(root);
        for (const row of rows.slice(1)) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed reply row');
            continue;
          }
          const reply = normalizeOpenCliTweet(request, row as OpenCliTweetRow, backend, warnings);
          if (reply !== undefined) {
            entities.push(toComment(reply, request, request.postId, undefined));
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'get_comments':
      case 'get_comment_replies': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows.slice(1)) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed reply row');
            continue;
          }
          const reply = normalizeOpenCliTweet(request, row as OpenCliTweetRow, backend, warnings);
          if (reply !== undefined) {
            entities.push(toComment(reply, request, request.postId, request.commentId));
          }
        }
        return pageFromEntities(request, entities, warnings);
      }
      case 'search':
      case 'get_user_posts':
      case 'get_feed':
      case 'get_saved': {
        const rows = expectList(payload, backend);
        const entities: SocialEntityV1[] = [];
        for (const row of rows) {
          if (typeof row !== 'object' || row === null) {
            warnings.push('dropped malformed tweet row');
            continue;
          }
          const entity = normalizeOpenCliTweet(request, row as OpenCliTweetRow, backend, warnings);
          if (entity !== undefined) entities.push(entity);
        }
        return pageFromEntities(request, entities, warnings);
      }
      default:
        throw new SocialError('backend_unavailable', `OpenCLI twitter cannot serve ${request.action}`, {
          platform: 'twitter', backend, retryable: false,
        });
    }
  }

  private async execute(
    capability: BackendCapability,
    args: string[],
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const source = this.options.parentEnv ?? process.env;
    const env = capability.name === 'opencli-twitter'
      ? openCliChildEnv(source)
      : buildPythonChildEnvironment(source);
    const invocation: SocialCliInvocation = {
      command: capability.command ?? 'twitter',
      args,
      env,
      timeoutMs: this.options.timeoutMs ?? TWITTER_COMMAND_TIMEOUT_MS,
    };
    if (signal !== undefined) invocation.signal = signal;
    let result: SocialCliResult;
    try {
      result = await this.runner(invocation);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      throw new SocialError('backend_unavailable', `failed to spawn ${capability.name}`, {
        platform: 'twitter', backend: capability.name, cause: error,
      });
    }
    if (result.code === 127) {
      throw new SocialError('backend_unavailable', `${capability.name} is not installed`, {
        platform: 'twitter', backend: capability.name,
      });
    }
    if (result.code !== 0) {
      const token = env['OPENCLI_TOKEN'];
      const message = redactCliDiagnostics(
        result.stderr || result.stdout,
        token !== undefined ? [token] : [],
      );
      const code = /rate limit|too many requests/i.test(message) ? 'rate_limited' : 'upstream_error';
      throw new SocialError(code, `${capability.name} exited ${result.code}: ${message}`, {
        platform: 'twitter', backend: capability.name,
      });
    }
    return parseCliJsonPayload(result.stdout, capability.name);
  }
}
