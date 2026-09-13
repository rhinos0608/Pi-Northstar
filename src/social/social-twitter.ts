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

import { spawnCliCommand } from '../process/cli-command.js';
import { buildPythonChildEnvironment } from '../process/python-child-env.js';
import { redactCliDiagnostics, requireCliPositional } from './social-cli-safety.js';
import { openCliChildEnv } from './social-opencli.js';
import {
  SocialError,
  selectorSpecFor,
  type BackendActionCapability,
  type BackendCapability,
  type SocialBackendPlan,
  type SocialExecutionContext,
  type SocialPageV1,
  type SocialPlatformWorker,
  type SocialRequest,
} from './social-contract.js';
import { normalizeTwitterPayload } from './social-twitter-normalize.js';

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
    // win32: bare commands resolve via PATHEXT; .cmd/.bat shims run through
    // cmd.exe with pre-quoted argv (shell:false cannot execute them — spawn
    // EINVAL; shell:true concatenates args unescaped). See cli-command.ts.
    const child = spawnCliCommand(invocation.command, invocation.args, {
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
    if (plan.backend === 'twitter-cli' || plan.backend === 'opencli-twitter') {
      return normalizeTwitterPayload(request, plan.backend, payload);
    }
    throw new SocialError('backend_unavailable', `unknown Twitter backend: ${plan.backend}`, {
      platform: 'twitter', backend: plan.backend, retryable: false,
    });
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
