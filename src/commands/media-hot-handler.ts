import { AsyncLocalStorage } from 'node:async_hooks';
import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import type { DnsLookup } from '../network-policy.js';

export const MEDIA_HOT_COMMAND = 'media.hot';

type HotChannel = 'youtube' | 'bilibili';

/** Reject-not-clamp caps mirror the media contract per-channel selector spec. */
const HOT_LIMIT_CAP: Readonly<Record<HotChannel, number>> = {
  youtube: 50,
  bilibili: 25,
};

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'channel',
  'action',
  'limit',
  'cursor',
]);

interface MediaHotArgs {
  channel: HotChannel;
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
function parseArgs(args: Record<string, unknown>): MediaHotArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw fail('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'hot') {
    throw fail('unsupported_action', 'media.hot serves the canonical hot action only');
  }
  const platform = clean(args.platform);
  const channelAlias = clean(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw fail('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  let channel: HotChannel;
  if (explicit === undefined) {
    throw fail('invalid_request', 'platform is required');
  } else if (explicit !== 'youtube' && explicit !== 'bilibili') {
    throw fail('unsupported_action', 'media.hot serves youtube and bilibili only');
  } else {
    channel = explicit;
  }

  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    throw fail('invalid_request', 'cursor must be a string when provided');
  }
  const cursor = clean(args.cursor);

  let limit: number | undefined;
  if (args.limit !== undefined) {
    const cap = HOT_LIMIT_CAP[channel];
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
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

export function mapMediaHotCommandResult(
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
    commandId: MEDIA_HOT_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: unique.map((name) => ({ kind: 'external' as const, name })),
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_HOT_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_HOT_COMMAND],
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
    commandId: MEDIA_HOT_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: backendOf(error) ?? source }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: MEDIA_HOT_COMMAND,
    attemptedSurfaces: [context.surface, MEDIA_HOT_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message: error instanceof Error ? error.message : 'Media hot request failed',
      retryable,
      category: code === 'cancelled' ? 'cancelled' : 'media',
    },
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  const target = error instanceof Error ? error : new Error('Media hot request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

type MediaExecutor = (
  channelName: string,
  args: Record<string, unknown>,
  options: { env?: Record<string, string | undefined>; signal?: AbortSignal; lookup?: DnsLookup },
) => Promise<BackendCallResult>;

const defaultExecutor: MediaExecutor = (channelName, args, options) => executeMedia(channelName, args, options);
const scopedExecutor = new AsyncLocalStorage<MediaExecutor>();

/** Test seam: override the media executor with scoped storage without touching network/CLIs. */
export function setMediaHotExecutor(next: MediaExecutor | undefined): void {
  if (next !== undefined) scopedExecutor.enterWith(next);
  else scopedExecutor.disable();
}

export async function executeMediaHot(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: MediaHotArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context, 'media');
  }
  try {
    if (context.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const executor = scopedExecutor.getStore() ?? defaultExecutor;
    const result = await executor(
      'media',
      {
        action: 'hot',
        platform: parsed.channel,
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
    const northstarCommand = mapMediaHotCommandResult(envelope, context);
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

export const mediaHotHandler = {
  commandId: MEDIA_HOT_COMMAND,
  execute: executeMediaHot,
};
