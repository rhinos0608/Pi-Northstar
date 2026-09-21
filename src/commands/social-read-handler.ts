import { AsyncLocalStorage } from 'node:async_hooks';
import type { BackendCallResult } from '../backend.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import {
  executeSocial,
  type ExecuteSocialOptions,
} from '../social/social.js';
import {
  isSocialPlatform,
  selectorSpecFor,
  SOCIAL_MAX_LIMIT,
  SocialError,
  type SocialAction,
  type SocialPlatform,
} from '../social/social-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const SOCIAL_READ_COMMAND = 'social.read';

/** Read surface: single-post/thread/comments/profile/community/feed/followers/user-posts/trending/community-posts reads. */
const READ_ACTIONS: ReadonlySet<string> = new Set([
  'get_post',
  'get_thread',
  'get_comments',
  'get_profile',
  'get_community',
  'get_feed',
  'get_followers',
  'get_user_posts',
  'get_trending',
  'get_community_posts',
]);

const READ_ACTION_LIST = 'get_post, get_thread, get_comments, get_profile, get_community, get_feed, get_followers, get_user_posts, get_trending, get_community_posts';

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'action',
  'query',
  'postId',
  'commentId',
  'user',
  'community',
  'topic',
  'url',
  'feedVariant',
  'sort',
  'timeRange',
  'includeReplies',
  'limit',
  'cursor',
]);

interface SocialReadArgs {
  platform: SocialPlatform;
  action: SocialAction;
  forward: Record<string, unknown>;
  limit?: number;
}

function fail(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function backendOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    typeof (error as { backend?: unknown }).backend === 'string'
    ? (error as { backend: string }).backend
    : undefined;
}

function retryableOf(error: unknown): boolean {
  return error instanceof SocialError ? error.retryable : false;
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Strict argument gate (reject-not-clamp). Fixed messages only: rejected
 * values are never echoed, so credentials cannot leak through validation.
 * Limit bounds come from the owning contract selector spec; omitted limit
 * uses the contract default downstream. Cursors pass through — the contract
 * owns opaque cursor binding (cursor_invalid/cursor_mismatch stay terminal).
 */
function parseArgs(args: Record<string, unknown>): SocialReadArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw fail('invalid_request', `unknown social.read field: ${key.slice(0, 32)}`);
    }
  }
  const rawAction = args.action;
  if (rawAction === undefined || rawAction === null) {
    throw fail('invalid_request', `social.read requires one of: ${READ_ACTION_LIST}`);
  }
  if (typeof rawAction !== 'string' || rawAction.trim().length === 0) {
    throw fail('invalid_request', 'action must be a non-empty string when provided');
  }
  const actionName = rawAction.trim();
  if (!READ_ACTIONS.has(actionName)) {
    // Canonical-only: legacy spellings and out-of-slice actions reject here —
    // never dispatched, never generic-web substituted.
    throw fail('unsupported_action', `social.read serves ${READ_ACTION_LIST} only`);
  }
  const action = actionName as SocialAction;
  const rawPlatform = args.platform;
  if (typeof rawPlatform !== 'string' || !isSocialPlatform(rawPlatform)) {
    throw fail('invalid_request', 'platform is required');
  }
  const platform: SocialPlatform = rawPlatform;
  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    throw fail('invalid_request', 'cursor must be a string when provided');
  }
  const cap = selectorSpecFor(platform, action).maxLimit ?? SOCIAL_MAX_LIMIT;
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > cap
    ) {
      // Reject-not-clamp: the contract would clamp; this seam rejects instead.
      throw fail('invalid_request', `limit must be an integer 1..${cap}`);
    }
    limit = args.limit;
  }
  const forward: Record<string, unknown> = { platform, action };
  for (const field of ['query', 'postId', 'commentId', 'user', 'community', 'topic', 'url', 'feedVariant', 'sort', 'timeRange', 'cursor'] as const) {
    const value = clean(args[field]);
    if (value !== undefined) forward[field] = value;
  }
  if (typeof args.includeReplies === 'boolean') forward.includeReplies = args.includeReplies;
  if (limit !== undefined) forward.limit = limit;
  return { platform, action, forward, ...(limit !== undefined ? { limit } : {}) };
}

export function mapSocialReadCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
): NorthstarCommandResultV1 {
  const outcome =
    envelope.status === 'ok'
      ? 'success'
      : envelope.status === 'empty'
        ? 'empty'
        : envelope.status === 'partial'
          ? 'partial'
          : envelope.status === 'degraded'
            ? 'degraded'
            : 'failed';
  const firstError = envelope.errors[0];
  const names = envelope.sources.map((entry) => entry.source);
  const fallback =
    typeof envelope.request.channel === 'string' && envelope.request.channel.length > 0
      ? envelope.request.channel
      : 'social';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: SOCIAL_READ_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: unique.map((name) => ({ kind: 'external' as const, name })),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: SOCIAL_READ_COMMAND,
    attemptedSurfaces: [context.surface, SOCIAL_READ_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? {
          error: {
            code: firstError.code,
            message: firstError.message,
            retryable: firstError.retryable,
            category: 'social',
          },
        }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

/** Terminal failures stay terminal; only SocialError retryables may retry. */
function attachFailure(error: unknown, context: CommandContext, source: string): never {
  const aborted =
    context.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
  const code = aborted ? 'cancelled' : errorCode(error);
  const retryable = aborted ? false : retryableOf(error);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: SOCIAL_READ_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: backendOf(error) ?? source }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: SOCIAL_READ_COMMAND,
    attemptedSurfaces: [context.surface, SOCIAL_READ_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Social read request failed',
      retryable,
      category: code === 'cancelled' ? 'cancelled' : 'social',
    },
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  const target = error instanceof Error ? error : new Error('Social read request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export type SocialExecutor = (
  args: Record<string, unknown>,
  options: ExecuteSocialOptions,
) => Promise<BackendCallResult>;

export interface SocialReadOptions {
  executor?: SocialExecutor;
}

const defaultExecutor: SocialExecutor = (args, options) => executeSocial(args, options);
const scopedExecutor = new AsyncLocalStorage<SocialExecutor>();

/** Test seam: override the social executor with scoped storage without touching network/CLIs. */
export function setSocialReadExecutor(next: SocialExecutor | undefined): void {
  if (next !== undefined) scopedExecutor.enterWith(next);
  else scopedExecutor.disable();
}

export async function executeSocialRead(
  args: Record<string, unknown>,
  context: CommandContext,
  options?: SocialReadOptions,
): Promise<BackendCallResult> {
  let parsed: SocialReadArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context, 'social');
  }
  try {
    if (context.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const executor = options?.executor ?? (context as { executor?: SocialExecutor }).executor ?? scopedExecutor.getStore() ?? defaultExecutor;
    const result = await executor(parsed.forward, {
      env: context.env,
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    const envelope = (result.details as Record<string, unknown> | undefined)?.northstar as
      | NorthstarResultV1
      | undefined;
    if (envelope === undefined || typeof envelope !== 'object') {
      throw fail('malformed_upstream', 'social backend returned no canonical envelope');
    }
    const northstarCommand = mapSocialReadCommandResult(envelope, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context, parsed.platform);
  }
}

export const socialReadHandler = {
  commandId: SOCIAL_READ_COMMAND,
  execute: executeSocialRead,
};
