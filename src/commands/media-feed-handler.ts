import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const MEDIA_FEED_COMMAND = 'media.feed';

/** Reject-not-clamp cap mirrors the media contract rss feed selector spec. */
const FEED_LIMIT_CAP = 50;

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'channel',
  'action',
  'url',
  'limit',
  'cursor',
]);

interface MediaFeedArgs {
  url: string;
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

/** Terminal failures stay terminal; only transient backend classes are retryable. */
function retryableCode(code: string): boolean {
  return (
    code === 'rate_limited' ||
    code === 'backend_unavailable' ||
    code === 'upstream_error' ||
    code === 'malformed_upstream' ||
    code === 'timeout'
  );
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Strict argument gate (reject-not-clamp). The rss channel is pinned: any
 * other platform rejects as unsupported_action. Fixed messages only —
 * rejected values are never echoed.
 */
function parseArgs(args: Record<string, unknown>): MediaFeedArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw fail('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'feed') {
    throw fail('unsupported_action', 'media.feed serves the canonical feed action only');
  }
  if (args.cursor !== undefined) {
    throw fail(
      'pagination_not_supported',
      'media.feed does not support continuation cursors in this slice',
    );
  }
  const platform = clean(args.platform);
  const channelAlias = clean(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw fail('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  if (explicit !== undefined && explicit !== 'rss') {
    throw fail('unsupported_action', 'media.feed serves the rss channel only');
  }
  const url = clean(args.url);
  if (typeof args.url === 'string' && url === undefined) {
    throw fail('invalid_request', 'url must be a non-empty string when provided');
  }
  if (url === undefined) {
    throw fail('invalid_request', 'media feed requires url');
  }
  let limit: number | undefined;
  if (args.limit !== undefined) {
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > FEED_LIMIT_CAP
    ) {
      // Reject-not-clamp: the contract would clamp; this seam rejects instead.
      throw fail('invalid_request', `limit must be an integer 1..${FEED_LIMIT_CAP}`);
    }
    limit = args.limit;
  }
  return { url, ...(limit !== undefined ? { limit } : {}) };
}

export function mapMediaFeedCommandResult(
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
      : 'rss';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: MEDIA_FEED_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: unique.map((name) => ({ kind: 'external' as const, name })),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_FEED_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_FEED_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? {
          error: {
            code: firstError.code,
            message: firstError.message,
            retryable: firstError.retryable,
            category: 'media',
          },
        }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const aborted =
    context.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
  const code = aborted ? 'cancelled' : errorCode(error);
  const retryable = retryableCode(code);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: MEDIA_FEED_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: backendOf(error) ?? 'rss' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_FEED_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_FEED_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Media feed request failed',
      retryable,
      category: code === 'cancelled' ? 'cancelled' : 'media',
    },
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  const target = error instanceof Error ? error : new Error('Media feed request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeMediaFeed(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: MediaFeedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }
  try {
    if (context.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const result = await executeMedia(
      'media',
      {
        action: 'feed',
        platform: 'rss',
        url: parsed.url,
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
      },
      { env: context.env, ...(context.signal !== undefined ? { signal: context.signal } : {}), ...(context.lookup !== undefined ? { lookup: context.lookup } : {}) },
    );
    const envelope = (result.details as Record<string, unknown> | undefined)?.northstar as
      | NorthstarResultV1
      | undefined;
    if (envelope === undefined || typeof envelope !== 'object') {
      throw fail('malformed_upstream', 'media backend returned no canonical envelope');
    }
    const northstarCommand = mapMediaFeedCommandResult(envelope, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const mediaFeedHandler = {
  commandId: MEDIA_FEED_COMMAND,
  execute: executeMediaFeed,
};
