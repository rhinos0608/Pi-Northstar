// Stage 2 social worker for Xiaohongshu.
//
// Command/endpoint mapping is verified against the installed CLIs only:
// - `opencli` 1.8.6 (`opencli xiaohongshu --help -f yaml`): read commands
//   search, note, comments, user, feed, saved, notifications; JSON output
//   via `-f json` (verified: `-f json` emits a JSON array of row objects).
// - `xhs-cli` 0.1.4 (`xhs --help`): read commands search, read (--comments),
//   user, user-posts, followers, following, feed, favorites; raw JSON via
//   `--json`. Comments are fetched with `xhs read <id> --comments` — the
//   `xhs comments` subcommand posts comments and is never invoked, and
//   `xhs hot` does not exist.
//
// Safety rules enforced here:
// - argv comes only from the closed mappings below; no download, mutation,
//   or browser-opening command is ever generated.
// - `xhs read` never receives `--xsec-token`; the CLI auto-resolves the
//   token from its own cache, so tokens never appear in argv we generate.
// - xsec_token values are stripped from every normalized output field.
// - `xhs` (a Python CLI) runs under buildPythonChildEnvironment().
// - `opencli` (a Node CLI) runs under openCliChildEnv() so operator-owned
//   OPENCLI_HOST/PORT/TOKEN pass through; nothing else secret-bearing does.
// - Authenticated state is read by the CLIs from their own local stores; no
//   cookie/token environment variables are passed.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  SocialError,
  socialEntityId,
  parseSocialDate,
  validateSocialEntity,
  isAdvertisedAction,
  SOCIAL_MAX_LIMIT,
  type SocialAction,
  type SocialActorV1,
  type SocialBackendPlan,
  type SocialEntityV1,
  type SocialExecutionContext,
  type SocialMetricsV1,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialRequest,
  type BackendCapability,
} from './social-contract.js';
import { buildPythonChildEnvironment } from './python-child-env.js';
import { openCliChildEnv } from './social-opencli.js';
import { redactCliDiagnostics, requireCliPositional } from './social-cli-safety.js';

// ── Runner seam ──

export interface SocialProcessRun {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  signal: AbortSignal | undefined;
}

export interface SocialProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type SocialProcessRunner = (run: SocialProcessRun) => Promise<SocialProcessResult>;

const MAX_OUTPUT_CHARS = 2_000_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Default runner: bounded spawn, abort kills the child and never falls through. */
export const defaultSocialProcessRunner: SocialProcessRunner = (run) =>
  new Promise<SocialProcessResult>((resolve, reject) => {
    const { command, args, env, signal } = run;
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = () => {
      child.kill('SIGTERM');
      child.kill('SIGKILL');
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      terminate();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminate();
      resolve({ code: 124, stdout, stderr: `command timed out after ${DEFAULT_COMMAND_TIMEOUT_MS}ms` });
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = (stdout + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + String(chunk)).slice(-MAX_OUTPUT_CHARS);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      resolve({ code: error.code === 'ENOENT' ? 127 : 1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

// ── Capability declarations (verified upstream mappings) ──

export const OPENCLI_XIAOHONGSHU_CAPABILITY: BackendCapability = {
  name: 'opencli-xiaohongshu',
  type: 'external',
  command: 'opencli',
  verifiedVersion: '1.8.6',
  operations: [
    { action: 'search', upstreamAction: ['search'], auth: ['cookie'], pagination: 'none', required: ['query'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_post', upstreamAction: ['note'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_comments', upstreamAction: ['comments'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: 50 },
    { action: 'get_user_posts', upstreamAction: ['user'], auth: ['cookie'], pagination: 'none', required: ['user'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_feed', upstreamAction: ['feed'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_saved', upstreamAction: ['saved'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_notifications', upstreamAction: ['notifications'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
  ],
};

export const XHS_CLI_CAPABILITY: BackendCapability = {
  name: 'xhs-cli',
  type: 'external',
  command: 'xhs',
  verifiedVersion: '0.1.4',
  operations: [
    { action: 'search', upstreamAction: ['search'], auth: ['cookie'], pagination: 'none', required: ['query'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_post', upstreamAction: ['read', '--json'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    // Comments must always come from `xhs read <id> --comments`; never
    // `xhs comments` (a write command) or `xhs hot` (does not exist).
    { action: 'get_comments', upstreamAction: ['read', '--comments', '--json'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_profile', upstreamAction: ['user'], auth: ['cookie'], pagination: 'none', required: ['user'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_user_posts', upstreamAction: ['user-posts', '--json'], auth: ['cookie'], pagination: 'none', required: ['user'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_followers', upstreamAction: ['followers', '--json'], auth: ['cookie'], pagination: 'none', required: ['user'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_following', upstreamAction: ['following', '--json'], auth: ['cookie'], pagination: 'none', required: ['user'], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_feed', upstreamAction: ['feed', '--json'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
    { action: 'get_saved', upstreamAction: ['favorites', '--max', '--json'], auth: ['cookie'], pagination: 'none', required: [], maxLimit: SOCIAL_MAX_LIMIT },
  ],
};

// ── Closed argv mappings ──
// One argv builder per (backend, canonical action). Nothing else spawns.

// ── Selector guards (defense in depth; the contract validates first) ──
// Note ids are the 24-hex object ids verified in fixtures, URL extraction,
// and noteIdFromUrl. User selectors cover the verified fixture shapes
// (letter/digit/_/- ids such as user-1, u1, red_id_1). Anything else — in
// particular values shaped like CLI flags (--xsec-token=..., --dump-cookies)
// — throws invalid_request before argv is built, so spawn never sees it.
const XHS_NOTE_ID_RE = /^[0-9a-f]{24}$/i;
const XHS_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;
const XHS_URL_HOSTS: readonly string[] = ['xiaohongshu.com', 'xhslink.com'];

function requireXhsNoteId(request: SocialRequest): string {
  const value = request.postId;
  if (typeof value !== 'string' || !XHS_NOTE_ID_RE.test(value)) {
    throw new SocialError('invalid_request', `postId is missing or not a valid Xiaohongshu note id`, { platform: 'xiaohongshu' });
  }
  return value;
}

function requireXhsUser(request: SocialRequest): string {
  const value = request.user;
  if (typeof value !== 'string' || !XHS_USER_RE.test(value)) {
    throw new SocialError('invalid_request', `user is missing or not a valid Xiaohongshu user id`, { platform: 'xiaohongshu' });
  }
  return value;
}

/** Search query for positional argv slots. Shared requireCliPositional
 *  rejects missing/blank and option-shaped values (leading `-` after trim)
 *  so the query can never be parsed as a CLI flag. Interior hyphens,
 *  spaces, and multilingual text pass through untouched (trimmed). */
function requireXhsQuery(request: SocialRequest): string {
  return requireCliPositional(request.query, 'query', 'xiaohongshu');
}

/** Pass through a caller-supplied URL only when it parses as an http(s)
 *  Xiaohongshu URL; flag-shaped values never parse and are rejected. */
function requireXhsNoteUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SocialError('invalid_request', `url is not a valid Xiaohongshu URL`, { platform: 'xiaohongshu' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SocialError('invalid_request', `url scheme must be http or https`, { platform: 'xiaohongshu' });
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SocialError('invalid_request', `url must not contain credentials`, { platform: 'xiaohongshu' });
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = XHS_URL_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!allowed) {
    throw new SocialError('invalid_request', `not a valid xiaohongshu.com note URL`, { platform: 'xiaohongshu' });
  }
  return url;
}

/** Note reference for opencli note/comments positionals: full URL when the
 *  request supplied one, else the canonical explore URL for the note id. */
function opencliNoteRef(request: SocialRequest): string {
  if (request.url !== undefined) return requireXhsNoteUrl(request.url);
  return `https://www.xiaohongshu.com/explore/${requireXhsNoteId(request)}`;
}

const OPENCLI_ARGV: Readonly<Partial<Record<SocialAction, (request: SocialRequest, limit: number) => readonly string[]>>> = {
  search: (request, limit) => ['xiaohongshu', 'search', requireXhsQuery(request), '--limit', String(limit), '-f', 'json'],
  get_post: (request) => ['xiaohongshu', 'note', opencliNoteRef(request), '-f', 'json'],
  get_comments: (request, limit) => [
    'xiaohongshu', 'comments', opencliNoteRef(request),
    '--limit', String(Math.min(limit, 50)),
    ...(request.includeReplies === true ? ['--with-replies'] : []),
    '-f', 'json',
  ],
  get_user_posts: (request, limit) => ['xiaohongshu', 'user', requireXhsUser(request), '--limit', String(limit), '-f', 'json'],
  get_feed: (_request, limit) => ['xiaohongshu', 'feed', '--limit', String(limit), '-f', 'json'],
  get_saved: (_request, limit) => ['xiaohongshu', 'saved', '--limit', String(limit), '-f', 'json'],
  // Notification type is a closed enum; unknown feedVariant values are omitted.
  get_notifications: (request, limit) => [
    'xiaohongshu', 'notifications',
    ...(request.feedVariant === 'mentions' || request.feedVariant === 'likes' || request.feedVariant === 'connections'
      ? ['--type', request.feedVariant]
      : []),
    '--limit', String(limit),
    '-f', 'json',
  ],
};

/** xhs-cli subcommands the worker may ever spawn. `read --comments` covers
 *  get_comments; `comment`, `post`, `delete`, `favorite`, `like`, `follow`,
 *  `unfollow`, `login`, `logout`, `topics` are mutation or out-of-contract
 *  commands and never appear. */
const XHS_CLI_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'search', 'read', 'user', 'user-posts', 'followers', 'following', 'feed', 'favorites',
]);

const XHS_ARGV: Readonly<Partial<Record<SocialAction, (request: SocialRequest, limit: number) => readonly string[]>>> = {
  search: (request) => ['search', requireXhsQuery(request), '--json'],
  get_post: (request) => ['read', requireXhsNoteId(request), '--json'],
  get_comments: (request) => ['read', requireXhsNoteId(request), '--comments', '--json'],
  get_profile: (request) => ['user', requireXhsUser(request), '--json'],
  get_user_posts: (request) => ['user-posts', requireXhsUser(request), '--json'],
  get_followers: (request) => ['followers', requireXhsUser(request), '--json'],
  get_following: (request) => ['following', requireXhsUser(request), '--json'],
  get_feed: () => ['feed', '--json'],
  get_saved: (_request, limit) => ['favorites', '--max', String(limit), '--json'],
};

export function opencliArgvFor(action: SocialAction, request: SocialRequest, limit: number): readonly string[] | undefined {
  return OPENCLI_ARGV[action]?.(request, limit);
}

export function xhsCliArgvFor(action: SocialAction, request: SocialRequest, limit: number): readonly string[] | undefined {
  return XHS_ARGV[action]?.(request, limit);
}

// ── Worker ──

export interface XiaohongshuWorkerOptions {
  runner?: SocialProcessRunner;
  opencliCommand?: string;
  xhsCommand?: string;
  /** Parent env handed to buildPythonChildEnvironment(); defaults to process.env. */
  childEnv?: Record<string, string | undefined>;
}

export const OPENCLI_BACKEND = 'opencli-xiaohongshu';
export const XHS_BACKEND = 'xhs-cli';

export function createXiaohongshuWorker(options: XiaohongshuWorkerOptions = {}): SocialPlatformWorker {
  const runner = options.runner ?? defaultSocialProcessRunner;
  const opencliCommand = options.opencliCommand ?? 'opencli';
  const xhsCommand = options.xhsCommand ?? 'xhs';
  const envSource = options.childEnv ?? process.env;
  const xhsEnv = buildPythonChildEnvironment(options.childEnv);
  const opencliEnv = openCliChildEnv(envSource);
  // Exact operator-owned values that must never echo back in diagnostics
  // (bare echoes carry no `LABEL=value` shape for pattern redaction).
  const sensitiveEnvValues = Object.values(opencliEnv).filter((value) => value.length > 0);

  function plan(backend: string, command: string, argv: readonly string[], env: Record<string, string>): SocialBackendPlan {
    return {
      backend,
      authTier: 'cookie',
      pagination: 'none',
      async execute(signal?: AbortSignal): Promise<unknown> {
        const result = await runner({ command, args: argv, env, signal });
        if (result.code === 127) {
          throw new SocialError('backend_unavailable', `${backend}: command not installed`, { platform: 'xiaohongshu', backend, retryable: false });
        }
        if (result.code !== 0) {
          const detail = redactCliDiagnostics(tail(result.stderr || result.stdout), sensitiveEnvValues);
          throw new SocialError(
            'upstream_error',
            `${backend}: exit ${result.code}: ${detail}`,
            { platform: 'xiaohongshu', backend },
          );
        }
        const output = result.stdout.trim();
        if (output.length === 0) {
          throw new SocialError('malformed_upstream', `${backend}: empty stdout on exit 0`, { platform: 'xiaohongshu', backend });
        }
        try {
          return JSON.parse(output) as unknown;
        } catch (error) {
          throw new SocialError('malformed_upstream', `${backend}: stdout is not valid JSON`, { platform: 'xiaohongshu', backend, cause: error });
        }
      },
    };
  }

  return {
    platforms: ['xiaohongshu'],
    async plans(request: SocialRequest, _context: SocialExecutionContext): Promise<readonly SocialBackendPlan[]> {
      if (!isAdvertisedAction('xiaohongshu', request.action)) {
        throw new SocialError('unsupported_action', `Unsupported xiaohongshu action`, { platform: 'xiaohongshu' });
      }
      const plans: SocialBackendPlan[] = [];
      // Backend preference (Stage 2 contract): OpenCLI first, xhs-cli second.
      const opencliArgs = opencliArgvFor(request.action, request, request.limit);
      if (opencliArgs !== undefined) {
        plans.push(plan(OPENCLI_BACKEND, opencliCommand, opencliArgs, opencliEnv));
      }
      const xhsArgs = xhsCliArgvFor(request.action, request, request.limit);
      if (xhsArgs !== undefined) {
        if (!XHS_CLI_READ_SUBCOMMANDS.has(xhsArgs[0]!)) {
          throw new SocialError('invalid_request', `refusing to spawn xhs subcommand`, { platform: 'xiaohongshu' });
        }
        plans.push(plan(XHS_BACKEND, xhsCommand, xhsArgs, xhsEnv));
      }
      if (plans.length === 0) {
        throw new SocialError('unsupported_action', `no verified backend for xiaohongshu action`, { platform: 'xiaohongshu' });
      }
      return plans;
    },
    normalize(request: SocialRequest, plan: SocialBackendPlan, payload: unknown): SocialPageV1 {
      if (plan.backend === OPENCLI_BACKEND) return normalizeOpencli(request, payload);
      if (plan.backend === XHS_BACKEND) return normalizeXhsCli(request, payload);
      throw new SocialError('backend_unavailable', `unknown backend plan: ${plan.backend}`, { platform: 'xiaohongshu' });
    },
  };
}

function tail(text: string, max = 300): string {
  const flat = text.trim();
  return flat.length > max ? flat.slice(-max) : flat;
}

// ── xsec_token stripping ──

/** Remove xsec_token from URL query strings and from raw text occurrences. */
export function stripXsecToken(value: string): string {
  const stripped = value.replace(/([?&])xsec_token=[^&#]*&?/gi, '$1');
  return stripped.replace(/xsec_token[=:]\s*\S+/gi, 'xsec_token=***');
}

export function stripXsecTokenUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.searchParams.has('xsec_token')) {
      parsed.searchParams.delete('xsec_token');
      return parsed.toString();
    }
  } catch {
    // Not a URL: fall through to text-level stripping.
  }
  return stripXsecToken(value);
}

// ── Shared normalization helpers ──

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Parse XHS-style counts: numbers, numeric strings, and 万/亿 suffixes.
 *  Non-numeric values (e.g. "赞") are omitted, never zeroed. */
export function parseXhsCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0) return undefined;
  const multiplier = text.endsWith('万') ? 10_000 : text.endsWith('亿') ? 100_000_000 : 1;
  const numeric = Number.parseFloat(text.replace(/[,万亿]/g, ''));
  if (!Number.isFinite(numeric) || numeric < 0) return undefined;
  return numeric * multiplier;
}

function hashId(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('|'), 'utf8').digest('hex').slice(0, 16);
}

function actorFrom(user: unknown): SocialActorV1 | undefined {
  const userRecord = record(user);
  if (userRecord === undefined) return undefined;
  const id = pickString(userRecord.userId, userRecord.user_id, userRecord.id);
  const nickname = pickString(userRecord.nickname, userRecord.nick_name, userRecord.displayName);
  const profileUrlRaw = pickString(userRecord.profileUrl, userRecord.profile_url);
  if (id === undefined && nickname === undefined && profileUrlRaw === undefined) return undefined;
  const actor: SocialActorV1 = {};
  if (id !== undefined) actor.id = id;
  if (nickname !== undefined) actor.displayName = nickname;
  if (profileUrlRaw !== undefined) actor.profileUrl = stripXsecTokenUrl(profileUrlRaw);
  return actor;
}

function actorFromName(name: unknown): SocialActorV1 | undefined {
  const displayName = pickString(name);
  return displayName !== undefined ? { displayName } : undefined;
}

function metricsFromInteract(interact: unknown): SocialMetricsV1 | undefined {
  const interactRecord = record(interact);
  if (interactRecord === undefined) return undefined;
  const metrics: SocialMetricsV1 = {};
  const assign = (key: keyof SocialMetricsV1, ...candidates: unknown[]) => {
    for (const candidate of candidates) {
      const parsed = parseXhsCount(candidate);
      if (parsed !== undefined) {
        metrics[key] = parsed;
        return;
      }
    }
  };
  assign('likes', interactRecord.liked_count, interactRecord.likedCount);
  assign('saves', interactRecord.collected_count, interactRecord.collectedCount);
  assign('comments', interactRecord.comment_count, interactRecord.commentCount);
  assign('shares', interactRecord.share_count, interactRecord.shareCount);
  return Object.keys(metrics).length > 0 ? metrics : undefined;
}

function canonicalNoteUrl(noteId: string): string {
  return `https://www.xiaohongshu.com/explore/${noteId}`;
}

function requireRows(payload: unknown, containerKeys: readonly string[], backend: string): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = record(payload);
  if (root !== undefined) {
    for (const key of containerKeys) {
      if (Array.isArray(root[key])) return root[key];
    }
  }
  throw new SocialError('malformed_upstream', `${backend}: payload has no row list`, { platform: 'xiaohongshu', backend });
}

// ── xhs-cli normalization (shapes verified from xhs-cli 0.1.4 cli.py) ──

interface NoteLikeRowResult {
  entity: SocialEntityV1;
  warning?: string;
}

/** Build a note-like entity from an XHS note_card/item row. Returns the error
 *  reason when the row lacks an id (malformed). */
function noteLikeEntity(
  row: Record<string, unknown>,
  wantKind: 'social_post' | 'social_reference',
): NoteLikeRowResult | { error: string } {
  const card = record(row.note_card) ?? record(row.noteCard) ?? row;
  const nativeId = pickString(row.id, row.note_id, row.noteId, card.note_id, card.id);
  if (nativeId === undefined) {
    return { error: 'row has no note id' };
  }
  const title = pickString(card.display_title, card.displayTitle, card.title);
  const desc = pickString(card.desc, card.text);
  const author = actorFrom(card.user);
  const metrics = metricsFromInteract(record(card.interact_info) ?? record(card.interactInfo));
  const publishedAt = parseSocialDate(card.time);
  const base = {
    version: 1 as const,
    platform: 'xiaohongshu' as const,
    backend: XHS_BACKEND,
    platformId: nativeId,
    url: stripXsecTokenUrl(canonicalNoteUrl(nativeId)),
  };
  if (wantKind === 'social_reference') {
    const entity: SocialEntityV1 = {
      ...base,
      kind: 'social_reference',
      id: socialEntityId('xiaohongshu', 'social_reference', nativeId),
      ...(publishedAt !== undefined ? { publishedAt } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
    };
    return { entity };
  }
  const entity: SocialEntityV1 = {
    ...base,
    kind: 'social_post',
    id: socialEntityId('xiaohongshu', 'social_post', nativeId),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    contentType: 'note',
    ...(title !== undefined ? { title } : {}),
    ...(desc !== undefined ? { text: desc } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
  };
  return { entity };
}

function xhsCommentEntity(
  comment: Record<string, unknown>,
  postEntityId: string,
): NoteLikeRowResult | { error: string } {
  const commentId = pickString(comment.id, comment.comment_id);
  const text = pickString(comment.content);
  if (commentId === undefined) return { error: 'comment row without id' };
  if (text === undefined) return { error: 'comment row without content' };
  const created = parseSocialDate(comment.create_time);
  const parent = pickString(comment.parent_comment_id);
  const author = actorFrom(record(comment.user_info) ?? record(comment.userInfo));
  const metrics = metricsFromInteract({ liked_count: comment.like_count ?? comment.likeCount });
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_comment',
    id: socialEntityId('xiaohongshu', 'social_comment', commentId),
    platform: 'xiaohongshu',
    backend: XHS_BACKEND,
    ...(created !== undefined ? { publishedAt: created } : {}),
    postId: postEntityId,
    ...(parent !== undefined ? { parentCommentId: socialEntityId('xiaohongshu', 'social_comment', parent) } : {}),
    text,
    ...(author !== undefined ? { author } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
  };
  return { entity };
}

function xhsProfileEntity(payload: unknown): NoteLikeRowResult | { error: string } {
  const root = record(payload);
  if (root === undefined) return { error: 'payload is not an object' };
  const userPage = record(root.userPageData) ?? record(root.user_page_data);
  const basic = record(userPage?.basicInfo) ?? record(userPage?.basic_info)
    ?? record(root.basicInfo) ?? record(root.basic_info) ?? root;
  const userRecord = record(root.userInfo) ?? record(root.user_info);
  const userId = pickString(basic.userId, basic.user_id, basic.id, userRecord?.userId, userRecord?.user_id);
  if (userId === undefined) return { error: 'profile payload has no user id' };
  const nickname = pickString(basic.nickname, basic.nick_name);
  const handle = pickString(basic.redId, basic.red_id);
  const bio = pickString(basic.desc, basic.description);
  const metrics: SocialMetricsV1 = {};
  const interactions = Array.isArray(userPage?.interactions) ? userPage?.interactions : Array.isArray(root.interactions) ? root.interactions : [];
  for (const raw of interactions) {
    const item = record(raw);
    if (item === undefined) continue;
    const name = pickString(item.name, item.type);
    const count = parseXhsCount(item.count ?? item.value);
    if (name === undefined || count === undefined) continue;
    if (name === 'fans' || name === '粉丝') metrics.followers = count;
    else if (name === 'follows' || name === '关注') metrics.following = count;
  }
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('xiaohongshu', 'social_account', userId),
    platform: 'xiaohongshu',
    backend: XHS_BACKEND,
    platformId: userId,
    ...(handle !== undefined ? { handle } : {}),
    ...(nickname !== undefined ? { displayName: nickname } : {}),
    ...(bio !== undefined ? { bio } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
  return { entity };
}

function xhsProfileFromUserRecord(user: Record<string, unknown>): NoteLikeRowResult | { error: string } {
  const userId = pickString(user.userId, user.user_id, user.id);
  if (userId === undefined) return { error: 'user row without id' };
  const nickname = pickString(user.nickname, user.nick_name);
  const handle = pickString(user.redId, user.red_id);
  const entity: SocialEntityV1 = {
    version: 1,
    kind: 'social_account',
    id: socialEntityId('xiaohongshu', 'social_account', userId),
    platform: 'xiaohongshu',
    backend: XHS_BACKEND,
    platformId: userId,
    ...(handle !== undefined ? { handle } : {}),
    ...(nickname !== undefined ? { displayName: nickname } : {}),
  };
  return { entity };
}

function normalizeXhsCli(request: SocialRequest, payload: unknown): SocialPageV1 {
  const warnings: string[] = [];
  let partial = false;
  const entities: SocialEntityV1[] = [];

  switch (request.action) {
    case 'get_post':
    case 'get_comments': {
      const root = record(payload);
      if (root === undefined) {
        throw new SocialError('malformed_upstream', 'xhs-cli read payload is not an object', { platform: 'xiaohongshu', backend: XHS_BACKEND });
      }
      const note = record(root.note);
      if (note !== undefined) {
        const nativeId = pickString(note.note_id, note.id, request.postId);
        if (nativeId !== undefined) {
        const interact = record(note.interact_info) ?? record(note.interactInfo);
        const publishedAt = parseSocialDate(note.time);
        const title = pickString(note.title);
        const desc = pickString(note.desc);
        const author = actorFrom(note.user);
        const metrics = metricsFromInteract(interact);
        const postEntityId = socialEntityId('xiaohongshu', 'social_post', nativeId);
        entities.push({
          version: 1,
          kind: 'social_post',
          id: postEntityId,
          platform: 'xiaohongshu',
          backend: XHS_BACKEND,
          platformId: nativeId,
          url: stripXsecTokenUrl(canonicalNoteUrl(nativeId)),
          ...(publishedAt !== undefined ? { publishedAt } : {}),
          contentType: 'note',
          ...(title !== undefined ? { title } : {}),
          ...(desc !== undefined ? { text: desc } : {}),
          ...(author !== undefined ? { author } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
        });
        const comments = Array.isArray(root.comments) ? root.comments : record(root.comments)?.comments;
        if (Array.isArray(comments)) {
          for (const raw of comments) {
            const comment = record(raw);
            if (comment === undefined) {
              partial = true;
              warnings.push('dropped malformed comment row');
              continue;
            }
            const built = xhsCommentEntity(comment, postEntityId);
            if ('error' in built) {
              partial = true;
              warnings.push(`dropped ${built.error}`);
              continue;
            }
            entities.push(built.entity);
          }
        }
        }
      }
      if (request.action === 'get_post' && entities.length !== 1) {
        throw new SocialError('not_found', `xiaohongshu post not found`, { platform: 'xiaohongshu', backend: XHS_BACKEND });
      }
      break;
    }
    case 'get_profile': {
      const profile = xhsProfileEntity(payload);
      if ('error' in profile) {
        throw new SocialError('not_found', `xiaohongshu profile not found`, { platform: 'xiaohongshu', backend: XHS_BACKEND });
      }
      entities.push(profile.entity);
      break;
    }
    case 'search': {
      for (const raw of requireRows(payload, ['items', 'notes'], XHS_BACKEND)) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed search row');
          continue;
        }
        const built = noteLikeEntity(row, 'social_reference');
        if ('error' in built) {
          partial = true;
          warnings.push(`dropped search row: ${built.error}`);
          continue;
        }
        entities.push(built.entity);
      }
      break;
    }
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved': {
      for (const raw of requireRows(payload, ['items', 'notes'], XHS_BACKEND)) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed row');
          continue;
        }
        const built = noteLikeEntity(row, 'social_post');
        if ('error' in built) {
          partial = true;
          warnings.push(`dropped row: ${built.error}`);
          continue;
        }
        entities.push(built.entity);
      }
      break;
    }
    case 'get_followers':
    case 'get_following': {
      for (const raw of requireRows(payload, [], XHS_BACKEND)) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed user row');
          continue;
        }
        const built = xhsProfileFromUserRecord(row);
        if ('error' in built) {
          partial = true;
          warnings.push(`dropped ${built.error}`);
          continue;
        }
        entities.push(built.entity);
      }
      break;
    }
    default:
      throw new SocialError('invalid_request', `xhs-cli backend does not implement this action`, { platform: 'xiaohongshu', backend: XHS_BACKEND });
  }

  return finishPage(entities, request, warnings, partial, XHS_BACKEND);
}

// ── opencli normalization (row shapes from verified 1.8.6 column lists) ──

function noteIdFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    for (let index = 0; index < segments.length; index++) {
      if ((segments[index] === 'explore' || segments[index] === 'item') && segments[index + 1] !== undefined) {
        const candidate = segments[index + 1]!;
        if (/^[0-9a-f]{24}$/i.test(candidate)) return candidate.toLowerCase();
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function normalizeOpencli(request: SocialRequest, payload: unknown): SocialPageV1 {
  const warnings: string[] = [];
  let partial = false;
  const entities: SocialEntityV1[] = [];
  if (!Array.isArray(payload)) {
    throw new SocialError('malformed_upstream', 'opencli-xiaohongshu: payload is not a JSON row array', { platform: 'xiaohongshu', backend: OPENCLI_BACKEND });
  }

  switch (request.action) {
    case 'search': {
      for (const raw of payload) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed search row');
          continue;
        }
        const title = pickString(row.title);
        const urlRaw = pickString(row.url);
        const url = urlRaw !== undefined ? stripXsecTokenUrl(urlRaw) : undefined;
        const noteId = urlRaw !== undefined ? noteIdFromUrl(urlRaw) : undefined;
        const metrics: SocialMetricsV1 = {};
        const likes = parseXhsCount(row.likes);
        if (likes !== undefined) metrics.likes = likes;
        const author = actorFromName(row.author);
        const publishedAt = parseSocialDate(row.published_at);
        if (noteId !== undefined) {
          entities.push({
            version: 1,
            kind: 'social_reference',
            id: socialEntityId('xiaohongshu', 'social_reference', noteId),
            platform: 'xiaohongshu',
            backend: OPENCLI_BACKEND,
            platformId: noteId,
            ...(url !== undefined ? { url } : {}),
            ...(publishedAt !== undefined ? { publishedAt } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(author !== undefined ? { author } : {}),
            ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
          });
        } else {
          // No note id available: hash-derived id, flagged by warning.
          entities.push({
            version: 1,
            kind: 'social_reference',
            id: socialEntityId('xiaohongshu', 'social_reference', hashId([pickString(row.author) ?? '', title ?? ''])),
            platform: 'xiaohongshu',
            backend: OPENCLI_BACKEND,
            ...(url !== undefined ? { url } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(author !== undefined ? { author } : {}),
            ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
          });
          warnings.push('search row id derived from content hash');
        }
      }
      break;
    }
    case 'get_post': {
      const fields = new Map<string, unknown>();
      for (const raw of payload) {
        const row = record(raw);
        const field = row === undefined ? undefined : pickString(row.field);
        if (row === undefined || field === undefined) {
          partial = true;
          warnings.push('dropped malformed note field row');
          continue;
        }
        fields.set(field, row.value);
      }
      const noteId = pickString(fields.get('note_id'), fields.get('id'), fields.get('noteId'), request.postId);
      if (noteId === undefined) {
        throw new SocialError('not_found', `xiaohongshu post not found`, { platform: 'xiaohongshu', backend: OPENCLI_BACKEND });
      }
      const metrics: SocialMetricsV1 = {};
      const likes = parseXhsCount(fields.get('liked_count') ?? fields.get('liked') ?? fields.get('likes'));
      if (likes !== undefined) metrics.likes = likes;
      const saves = parseXhsCount(fields.get('collected_count') ?? fields.get('collected'));
      if (saves !== undefined) metrics.saves = saves;
      const comments = parseXhsCount(fields.get('comment_count') ?? fields.get('comments'));
      if (comments !== undefined) metrics.comments = comments;
      const shares = parseXhsCount(fields.get('share_count') ?? fields.get('shares'));
      if (shares !== undefined) metrics.shares = shares;
      const title = pickString(fields.get('title'));
      const text = pickString(fields.get('desc'), fields.get('content'));
      const author = actorFrom({ id: fields.get('user_id'), nickname: fields.get('nickname') ?? fields.get('author') });
      const publishedAt = parseSocialDate(fields.get('time') ?? fields.get('published_at'));
      entities.push({
        version: 1,
        kind: 'social_post',
        id: socialEntityId('xiaohongshu', 'social_post', noteId),
        platform: 'xiaohongshu',
        backend: OPENCLI_BACKEND,
        platformId: noteId,
        url: canonicalNoteUrl(noteId),
        ...(publishedAt !== undefined ? { publishedAt } : {}),
        contentType: 'note',
        ...(title !== undefined ? { title } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      });
      break;
    }
    case 'get_comments': {
      if (request.postId === undefined) {
        throw new SocialError('invalid_request', 'opencli-xiaohongshu get_comments requires postId', { platform: 'xiaohongshu', backend: OPENCLI_BACKEND });
      }
      const postEntityId = socialEntityId('xiaohongshu', 'social_post', request.postId);
      for (const raw of payload) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed comment row');
          continue;
        }
        const text = pickString(row.text);
        if (text === undefined) {
          partial = true;
          warnings.push('dropped comment row without text');
          continue;
        }
        const userId = pickString(row.userId, row.user_id);
        const rank = typeof row.rank === 'number' && Number.isFinite(row.rank) ? row.rank : undefined;
        const nativeId = pickString(row.id, row.commentId, row.comment_id)
          ?? (userId !== undefined && rank !== undefined ? `${userId}:${rank}` : undefined);
        if (nativeId === undefined) {
          partial = true;
          warnings.push('dropped comment row without id');
          continue;
        }
        const parent = pickString(row.reply_to, row.replyTo);
        const created = parseSocialDate(row.time);
        const profileUrl = typeof row.profileUrl === 'string' && row.profileUrl.length > 0
          ? stripXsecTokenUrl(row.profileUrl)
          : undefined;
        const author: SocialActorV1 | undefined = userId === undefined && pickString(row.author) === undefined && profileUrl === undefined
          ? undefined
          : {
              ...(userId !== undefined ? { id: userId } : {}),
              ...(pickString(row.author) !== undefined ? { displayName: pickString(row.author)! } : {}),
              ...(profileUrl !== undefined ? { profileUrl } : {}),
            };
        const metrics: SocialMetricsV1 = {};
        const likes = parseXhsCount(row.likes);
        if (likes !== undefined) metrics.likes = likes;
        const entity: SocialEntityV1 = {
          version: 1,
          kind: 'social_comment',
          id: socialEntityId('xiaohongshu', 'social_comment', nativeId),
          platform: 'xiaohongshu',
          backend: OPENCLI_BACKEND,
          ...(created !== undefined ? { publishedAt: created } : {}),
          postId: postEntityId,
          text,
          ...(parent !== undefined ? { parentCommentId: socialEntityId('xiaohongshu', 'social_comment', parent) } : {}),
          ...(author !== undefined ? { author } : {}),
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        };
        entities.push(entity);
      }
      break;
    }
    case 'get_user_posts':
    case 'get_feed':
    case 'get_saved': {
      for (const raw of payload) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed row');
          continue;
        }
        const nativeId = pickString(row.id, row.note_id);
        const title = pickString(row.title);
        if (nativeId === undefined && title === undefined) {
          partial = true;
          warnings.push('dropped row without id or title');
          continue;
        }
        // Rows without a native note id get a hash-derived id plus warning.
        const idSource = nativeId ?? hashId([title ?? '']);
        const metrics: SocialMetricsV1 = {};
        const likes = parseXhsCount(row.likes);
        if (likes !== undefined) metrics.likes = likes;
        const author = row.author !== undefined ? actorFromName(row.author) : actorFrom(row.user);
        const urlRaw = pickString(row.url);
        const url = urlRaw !== undefined ? stripXsecTokenUrl(urlRaw) : undefined;
        entities.push({
          version: 1,
          kind: 'social_post',
          id: socialEntityId('xiaohongshu', 'social_post', idSource),
          platform: 'xiaohongshu',
          backend: OPENCLI_BACKEND,
          ...(nativeId !== undefined ? { platformId: nativeId } : {}),
          ...(url !== undefined ? { url } : {}),
          contentType: 'note',
          ...(title !== undefined ? { title } : {}),
          ...(author !== undefined ? { author } : {}),
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        });
        if (nativeId === undefined) warnings.push('row id derived from content hash');
      }
      break;
    }
    case 'get_notifications': {
      for (const raw of payload) {
        const row = record(raw);
        if (row === undefined) {
          partial = true;
          warnings.push('dropped malformed notification row');
          continue;
        }
        const text = pickString(row.content);
        const action = pickString(row.action);
        if (text === undefined && action === undefined) {
          partial = true;
          warnings.push('dropped notification row without content');
          continue;
        }
        const actor = row.user !== undefined ? actorFromName(row.user) : undefined;
        const publishedAt = parseSocialDate(row.time);
        entities.push({
          version: 1,
          kind: 'social_notification',
          id: socialEntityId('xiaohongshu', 'social_notification', hashId([String(row.rank ?? ''), action ?? '', text ?? ''])),
          platform: 'xiaohongshu',
          backend: OPENCLI_BACKEND,
          ...(publishedAt !== undefined ? { publishedAt } : {}),
          ...(action !== undefined ? { type: action } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(actor !== undefined ? { actor } : {}),
        });
        warnings.push('notification id derived from content hash');
      }
      break;
    }
    default:
      throw new SocialError('invalid_request', `opencli-xiaohongshu backend does not implement this action`, { platform: 'xiaohongshu', backend: OPENCLI_BACKEND });
  }

  return finishPage(entities, request, warnings, partial, OPENCLI_BACKEND);
}

function finishPage(
  entities: SocialEntityV1[],
  request: SocialRequest,
  warnings: string[],
  partial: boolean,
  backend: string,
): SocialPageV1 {
  const limited = entities.slice(0, request.limit);
  const finalWarnings = [...warnings];
  if (limited.length < entities.length) finalWarnings.push(`truncated ${entities.length - limited.length} rows to limit`);

  const valid: SocialEntityV1[] = [];
  const validated = backend === OPENCLI_BACKEND; // xhs entities are validated too, below.
  void validated;
  for (const entity of limited) {
    const check = validateSocialEntity(entity);
    if (check.ok) {
      valid.push(entity);
    } else {
      finalWarnings.push(`dropped invalid entity: ${check.issues.join('; ')}`);
    }
  }
  return {
    entities: valid,
    pagination: {
      supported: false,
      limit: request.limit,
      returned: valid.length,
      hasMore: false,
    },
    partial: partial || valid.length < limited.length,
    warnings: finalWarnings,
  };
}

/** Singleton worker with default process spawning. */
export const xiaohongshuWorker: SocialPlatformWorker = createXiaohongshuWorker();