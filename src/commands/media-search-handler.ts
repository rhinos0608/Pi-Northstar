import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import { MAX_MEDIA_QUERY_LENGTH } from '../media/media-contract.js';
import { requireCliPositional } from '../social/social-cli-safety.js';
import type { SocialPlatform } from '../social/social-contract.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import type { DnsLookup } from '../network-policy.js';

export const MEDIA_SEARCH_COMMAND = 'media.search';

type SearchChannel = 'youtube' | 'bilibili';

/** Reject-not-clamp caps mirror the media contract per-channel selector spec. */
const SEARCH_LIMIT_CAP: Readonly<Record<SearchChannel, number>> = {
  youtube: 50,
  bilibili: 25,
};

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'channel',
  'action',
  'query',
  'limit',
  'cursor',
]);

interface MediaSearchArgs {
  channel: SearchChannel;
  query: string;
  limit?: number;
  cursor?: string;
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
 * Strict argument gate (reject-not-clamp). Fixed messages only: rejected
 * values are never echoed, so credentials cannot leak through validation.
 */
function parseArgs(args: Record<string, unknown>): MediaSearchArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw fail('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'search') {
    throw fail('unsupported_action', 'media.search serves the canonical search action only');
  }
  const platform = clean(args.platform);
  const channelAlias = clean(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw fail('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  let channel: SearchChannel;
  if (explicit === undefined) {
    throw fail('invalid_request', 'platform is required');
  } else if (explicit !== 'youtube' && explicit !== 'bilibili') {
    throw fail('unsupported_action', 'media.search serves youtube and bilibili only');
  } else {
    channel = explicit;
  }
  const rawQuery = args.query;
  if (rawQuery === undefined) {
    throw fail('invalid_request', 'query is required');
  }
  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    throw fail('invalid_request', 'query must be a non-empty string when provided');
  }
  const query = rawQuery.trim();
  if (query.length > MAX_MEDIA_QUERY_LENGTH) {
    throw fail('invalid_request', `query exceeds maximum length of ${MAX_MEDIA_QUERY_LENGTH}`);
  }
  const safeQuery = requireCliPositional(query, 'query', channel as unknown as SocialPlatform);

  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    throw fail('invalid_request', 'cursor must be a string when provided');
  }
  const cursor = clean(args.cursor);

  let limit: number | undefined;
  if (args.limit !== undefined) {
    const cap = SEARCH_LIMIT_CAP[channel];
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > cap
    ) {
      throw fail('invalid_request', `limit must be an integer 1..${cap}`);
    }
    limit = args.limit;
  }
  return {
    channel,
    query: safeQuery,
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

export function mapMediaSearchCommandResult(
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
      : 'media';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: MEDIA_SEARCH_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: unique.map((name) => ({ kind: 'external' as const, name })),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_SEARCH_COMMAND],
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

function attachFailure(error: unknown, context: CommandContext, source: string): never {
  const aborted =
    context.signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
  const code = aborted ? 'cancelled' : errorCode(error);
  const retryable = retryableCode(code);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: MEDIA_SEARCH_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: backendOf(error) ?? source }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_SEARCH_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Media search request failed',
      retryable,
      category: code === 'cancelled' ? 'cancelled' : 'media',
    },
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  const target = error instanceof Error ? error : new Error('Media search request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

type MediaExecutor = (
  channelName: string,
  args: Record<string, unknown>,
  options: { env?: Record<string, string | undefined>; signal?: AbortSignal; lookup?: DnsLookup },
) => Promise<BackendCallResult>;

const defaultExecutor: MediaExecutor = (channelName, args, options) => executeMedia(channelName, args, options);

let executor: MediaExecutor = defaultExecutor;

export function setMediaSearchExecutor(next: MediaExecutor | undefined): void {
  executor = next ?? defaultExecutor;
}

export async function executeMediaSearch(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: MediaSearchArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context, 'media');
  }
  try {
    if (context.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const result = await executor(
      'media',
      {
        action: 'search',
        platform: parsed.channel,
        query: parsed.query,
        ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
      },
      {
        env: context.env,
        ...(context.signal !== undefined ? { signal: context.signal } : {}),
        ...(context.lookup !== undefined ? { lookup: context.lookup } : {}),
      },
    );
    const envelope = (result.details as Record<string, unknown> | undefined)?.northstar as
      | NorthstarResultV1
      | undefined;
    if (envelope === undefined || typeof envelope !== 'object') {
      throw fail('malformed_upstream', 'media backend returned no canonical envelope');
    }
    const northstarCommand = mapMediaSearchCommandResult(envelope, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context, parsed.channel);
  }
}

export const mediaSearchHandler = {
  commandId: MEDIA_SEARCH_COMMAND,
  execute: executeMediaSearch,
};
