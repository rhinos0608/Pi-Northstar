import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import type { NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import { attachExternalCommandFailure, cleanCommandString, commandFailure, mapExternalCommandResult } from './external-command-result.js';

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

/**
 * Strict argument gate (reject-not-clamp). The rss channel is pinned: any
 * other platform rejects as unsupported_action. Fixed messages only —
 * rejected values are never echoed.
 */
function parseArgs(args: Record<string, unknown>): MediaFeedArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw commandFailure('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'feed') {
    throw commandFailure('unsupported_action', 'media.feed serves the canonical feed action only');
  }
  if (args.cursor !== undefined) {
    throw commandFailure(
      'pagination_not_supported',
      'media.feed does not support continuation cursors in this slice',
    );
  }
  const platform = cleanCommandString(args.platform);
  const channelAlias = cleanCommandString(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw commandFailure('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  if (explicit !== undefined && explicit !== 'rss') {
    throw commandFailure('unsupported_action', 'media.feed serves the rss channel only');
  }
  const url = cleanCommandString(args.url);
  if (typeof args.url === 'string' && url === undefined) {
    throw commandFailure('invalid_request', 'url must be a non-empty string when provided');
  }
  if (url === undefined) {
    throw commandFailure('invalid_request', 'media feed requires url');
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
      throw commandFailure('invalid_request', `limit must be an integer 1..${FEED_LIMIT_CAP}`);
    }
    limit = args.limit;
  }
  return { url, ...(limit !== undefined ? { limit } : {}) };
}

export function mapMediaFeedCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
): NorthstarCommandResultV1 {
  return mapExternalCommandResult(envelope, context, {
    commandId: MEDIA_FEED_COMMAND,
    category: 'media',
    fallbackSource: 'media',
  });
}

function attachFailure(error: unknown, context: CommandContext): never {
  return attachExternalCommandFailure(error, context, {
    commandId: MEDIA_FEED_COMMAND,
    category: 'media',
    fallbackSource: 'media',
    failureMessage: 'Media feed request failed',
  });
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
      throw commandFailure('malformed_upstream', 'media backend returned no canonical envelope');
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
