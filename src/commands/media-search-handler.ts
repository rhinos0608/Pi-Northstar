import { AsyncLocalStorage } from 'node:async_hooks';
import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import { MAX_MEDIA_QUERY_LENGTH } from '../media/media-contract.js';
import { requireCliPositional } from '../social/social-cli-safety.js';
import type { SocialPlatform } from '../social/social-contract.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import type { NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import { attachExternalCommandFailure, cleanCommandString, commandFailure, mapExternalCommandResult } from './external-command-result.js';
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

/**
 * Strict argument gate (reject-not-clamp). Fixed messages only: rejected
 * values are never echoed, so credentials cannot leak through validation.
 */
function parseArgs(args: Record<string, unknown>): MediaSearchArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw commandFailure('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'search') {
    throw commandFailure('unsupported_action', 'media.search serves the canonical search action only');
  }
  const platform = cleanCommandString(args.platform);
  const channelAlias = cleanCommandString(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw commandFailure('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  let channel: SearchChannel;
  if (explicit === undefined) {
    throw commandFailure('invalid_request', 'platform is required');
  } else if (explicit !== 'youtube' && explicit !== 'bilibili') {
    throw commandFailure('unsupported_action', 'media.search serves youtube and bilibili only');
  } else {
    channel = explicit;
  }
  const rawQuery = args.query;
  if (rawQuery === undefined) {
    throw commandFailure('invalid_request', 'query is required');
  }
  if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
    throw commandFailure('invalid_request', 'query must be a non-empty string when provided');
  }
  const query = rawQuery.trim();
  if (query.length > MAX_MEDIA_QUERY_LENGTH) {
    throw commandFailure('invalid_request', `query exceeds maximum length of ${MAX_MEDIA_QUERY_LENGTH}`);
  }
  const safeQuery = requireCliPositional(query, 'query', channel as unknown as SocialPlatform);

  if (args.cursor !== undefined && typeof args.cursor !== 'string') {
    throw commandFailure('invalid_request', 'cursor must be a string when provided');
  }
  const cursor = cleanCommandString(args.cursor);

  let limit: number | undefined;
  if (args.limit !== undefined) {
    const cap = SEARCH_LIMIT_CAP[channel];
    if (
      typeof args.limit !== 'number' ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > cap
    ) {
      throw commandFailure('invalid_request', `limit must be an integer 1..${cap}`);
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
  return mapExternalCommandResult(envelope, context, {
    commandId: MEDIA_SEARCH_COMMAND,
    category: 'media',
    fallbackSource: 'media',
  });
}

function attachFailure(error: unknown, context: CommandContext, source: string): never {
  return attachExternalCommandFailure(error, context, {
    commandId: MEDIA_SEARCH_COMMAND,
    category: 'media',
    fallbackSource: 'media',
    source,
    failureMessage: 'Media search request failed',
  });
}

type MediaExecutor = (
  channelName: string,
  args: Record<string, unknown>,
  options: { env?: Record<string, string | undefined>; signal?: AbortSignal; lookup?: DnsLookup },
) => Promise<BackendCallResult>;

const defaultExecutor: MediaExecutor = (channelName, args, options) => executeMedia(channelName, args, options);
const scopedExecutor = new AsyncLocalStorage<MediaExecutor>();

/** Test seam: override the media executor with scoped storage without touching network/CLIs. */
export function setMediaSearchExecutor(next: MediaExecutor | undefined): void {
  if (next !== undefined) scopedExecutor.enterWith(next);
  else scopedExecutor.disable();
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
    const executor = scopedExecutor.getStore() ?? defaultExecutor;
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
      throw commandFailure('malformed_upstream', 'media backend returned no canonical envelope');
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
