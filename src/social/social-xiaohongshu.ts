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

import { spawnCliCommand } from '../process/cli-command.js';

import {
  SocialError,
  isAdvertisedAction,
  SOCIAL_MAX_LIMIT,
  type SocialAction,
  type SocialBackendPlan,
  type SocialExecutionContext,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialRequest,
  type BackendCapability,
} from './social-contract.js';
import { normalizeXiaohongshuPayload } from './social-xiaohongshu-normalize.js';
import { buildPythonChildEnvironment } from '../process/python-child-env.js';
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
    // win32: bare commands resolve via PATHEXT; .cmd/.bat shims run through
    // cmd.exe with pre-quoted argv (shell:false cannot execute them — spawn
    // EINVAL; shell:true concatenates args unescaped). See cli-command.ts.
    const child = spawnCliCommand(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  // Notification type is a closed enum; unknown feedVariant values reject.
  get_notifications: (request, limit) => {
    if (request.feedVariant !== undefined
      && request.feedVariant !== 'mentions' && request.feedVariant !== 'likes' && request.feedVariant !== 'connections') {
      throw new SocialError('invalid_request', `xiaohongshu get_notifications invalid feedVariant "${request.feedVariant}", expected one of: mentions, likes, connections`, { platform: 'xiaohongshu', backend: 'opencli-xiaohongshu' });
    }
    return [
      'xiaohongshu', 'notifications',
      ...(request.feedVariant !== undefined ? ['--type', request.feedVariant] : []),
      '--limit', String(limit),
      '-f', 'json',
    ];
  },
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
  get_comments: (request) => {
    // xhs-cli read --comments has no reply control: skip so OpenCLI serves includeReplies.
    if (request.includeReplies === false) {
      throw new SocialError('unsupported_action', 'xhs-cli get_comments cannot exclude replies', { platform: 'xiaohongshu', backend: 'xhs-cli' });
    }
    return ['read', requireXhsNoteId(request), '--comments', '--json'];
  },
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
      // A backend that cannot honor a validated field opts out so a capable
      // backend still serves it; genuine input errors propagate.
      let xhsArgs: readonly string[] | undefined;
      try {
        xhsArgs = xhsCliArgvFor(request.action, request, request.limit);
      } catch (error) {
        if (error instanceof SocialError && error.code === 'unsupported_action') xhsArgs = undefined;
        else throw error;
      }
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
      if (plan.backend === OPENCLI_BACKEND || plan.backend === XHS_BACKEND) {
        return normalizeXiaohongshuPayload(request, plan.backend, payload);
      }
      throw new SocialError('backend_unavailable', `unknown backend plan: ${plan.backend}`, { platform: 'xiaohongshu' });
    },
  };
}

function tail(text: string, max = 300): string {
  const flat = text.trim();
  return flat.length > max ? flat.slice(-max) : flat;
}

// ── Normalization lives in ./social-xiaohongshu-normalize.js ──


/** Singleton worker with default process spawning. */
export const xiaohongshuWorker: SocialPlatformWorker = createXiaohongshuWorker();