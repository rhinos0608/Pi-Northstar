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
  SOCIAL_ACTIONS,
  SOCIAL_MAX_LIMIT,
  SocialError,
  type SocialAction,
  type SocialPlatform,
} from '../social/social-contract.js';
import type { NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import { attachExternalCommandFailure, cleanCommandString, commandFailure, mapExternalCommandResult } from './external-command-result.js';

export const SOCIAL_READ_COMMAND = 'social.read';

/** Canonical non-search social actions. Derive from the owning registry so
 * the command/backend route cannot drift from the public social schema. */
const READ_ACTIONS: ReadonlySet<string> = new Set(SOCIAL_ACTIONS.filter((action) => action !== 'search'));
const READ_ACTION_LIST = SOCIAL_ACTIONS.filter((action) => action !== 'search').join(', ');

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
      throw commandFailure('invalid_request', `unknown social.read field: ${key.slice(0, 32)}`);
    }
  }
  const rawAction = args.action;
  if (rawAction === undefined || rawAction === null) {
    throw commandFailure('invalid_request', `social.read requires one of: ${READ_ACTION_LIST}`);
  }
  if (typeof rawAction !== 'string' || rawAction.trim().length === 0) {
    throw commandFailure('invalid_request', 'action must be a non-empty string when provided');
  }
  const actionName = rawAction.trim();
  if (!READ_ACTIONS.has(actionName)) {
    // Canonical-only: legacy spellings and out-of-slice actions reject here —
    // never dispatched, never generic-web substituted.
    throw commandFailure('unsupported_action', `social.read serves ${READ_ACTION_LIST} only`);
  }
  const action = actionName as SocialAction;
  const rawPlatform = args.platform;
  if (typeof rawPlatform !== 'string' || !isSocialPlatform(rawPlatform)) {
    throw commandFailure('invalid_request', 'platform is required');
  }
  const platform: SocialPlatform = rawPlatform;
  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    throw commandFailure('invalid_request', 'cursor must be a string when provided');
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
      throw commandFailure('invalid_request', `limit must be an integer 1..${cap}`);
    }
    limit = args.limit;
  }
  const forward: Record<string, unknown> = { platform, action };
  for (const field of ['query', 'postId', 'commentId', 'user', 'community', 'topic', 'url', 'feedVariant', 'sort', 'timeRange', 'cursor'] as const) {
    const value = cleanCommandString(args[field]);
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
  return mapExternalCommandResult(envelope, context, {
    commandId: SOCIAL_READ_COMMAND,
    category: 'social',
    fallbackSource: 'social',
  });
}

/** Terminal failures stay terminal; only SocialError retryables may retry. */
function attachFailure(error: unknown, context: CommandContext, source: string): never {
  return attachExternalCommandFailure(error, context, {
    commandId: SOCIAL_READ_COMMAND,
    category: 'social',
    fallbackSource: 'social',
    source,
    failureMessage: 'Social read request failed',
    retryable: (candidate) => candidate instanceof SocialError ? candidate.retryable : false,
  });
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
      throw commandFailure('malformed_upstream', 'social backend returned no canonical envelope');
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
