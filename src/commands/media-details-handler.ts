import type { BackendCallResult } from '../backend.js';
import { executeMedia } from '../media/media.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import type { NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import { attachExternalCommandFailure, cleanCommandString, commandFailure, mapExternalCommandResult } from './external-command-result.js';

export const MEDIA_DETAILS_COMMAND = 'media.details';

type DetailsChannel = 'youtube' | 'bilibili';

/** Reject-not-clamp caps mirror the media contract per-channel selector spec. */
const DETAILS_LIMIT_CAP: Readonly<Record<DetailsChannel, number>> = {
  youtube: 50,
  bilibili: 25,
};

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'platform',
  'channel',
  'action',
  'id',
  'url',
  'limit',
  'cursor',
]);

const MAX_ID_LENGTH = 64;

interface MediaDetailsArgs {
  channel: DetailsChannel;
  id?: string;
  url?: string;
  limit?: number;
}

function inferChannel(url: string): DetailsChannel | undefined {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'youtube';
  if (host === 'bilibili.com' || host.endsWith('.bilibili.com')) return 'bilibili';
  return undefined;
}

/**
 * Strict argument gate (reject-not-clamp). Fixed messages only: rejected
 * values are never echoed, so credentials cannot leak through validation.
 */
function parseArgs(args: Record<string, unknown>): MediaDetailsArgs {
  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw commandFailure('invalid_request', `unknown request field: ${key.slice(0, 32)}`);
    }
  }
  if (args.action !== undefined && args.action !== 'details') {
    // Canonical-only: legacy 'video'/'subtitle' spellings and every other
    // action reject here — never dispatched, never generic-web substituted.
    throw commandFailure('unsupported_action', 'media.details serves the canonical details action only');
  }
  if (args.cursor !== undefined) {
    throw commandFailure(
      'pagination_not_supported',
      'media.details does not support continuation cursors in this slice',
    );
  }
  const platform = cleanCommandString(args.platform);
  const channelAlias = cleanCommandString(args.channel);
  if (platform !== undefined && channelAlias !== undefined && platform !== channelAlias) {
    throw commandFailure('invalid_request', 'platform and channel disagree');
  }
  const explicit = platform ?? channelAlias;
  const url = cleanCommandString(args.url);
  const id = cleanCommandString(args.id);
  let channel: DetailsChannel | undefined;
  if (explicit !== undefined) {
    if (explicit !== 'youtube' && explicit !== 'bilibili') {
      throw commandFailure('unsupported_action', 'media.details serves youtube and bilibili only');
    }
    channel = explicit;
  } else if (url !== undefined) {
    const inferred = inferChannel(url);
    if (inferred === undefined) throw commandFailure('invalid_request', 'platform is required');
    channel = inferred;
  } else {
    throw commandFailure('invalid_request', 'platform is required');
  }
  if (typeof args.id === 'string' && id === undefined) {
    throw commandFailure('invalid_request', 'id must be a non-empty string when provided');
  }
  if (typeof args.url === 'string' && url === undefined) {
    throw commandFailure('invalid_request', 'url must be a non-empty string when provided');
  }
  if (id !== undefined && id.length > MAX_ID_LENGTH) {
    throw commandFailure('invalid_request', `id exceeds maximum length of ${MAX_ID_LENGTH}`);
  }
  if (id === undefined && url === undefined) {
    throw commandFailure('invalid_request', 'media details requires one of: id, url');
  }
  let limit: number | undefined;
  if (args.limit !== undefined) {
    const cap = DETAILS_LIMIT_CAP[channel];
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
  return {
    channel,
    ...(id !== undefined ? { id } : {}),
    ...(url !== undefined ? { url } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function mapMediaDetailsCommandResult(
  envelope: NorthstarResultV1,
  context: CommandContext,
): NorthstarCommandResultV1 {
  return mapExternalCommandResult(envelope, context, {
    commandId: MEDIA_DETAILS_COMMAND,
    category: 'media',
    fallbackSource: 'media',
  });
}

function attachFailure(error: unknown, context: CommandContext, source: string): never {
  return attachExternalCommandFailure(error, context, {
    commandId: MEDIA_DETAILS_COMMAND,
    category: 'media',
    fallbackSource: 'media',
    source,
    failureMessage: 'Media details request failed',
  });
}

export async function executeMediaDetails(
  args: Record<string, unknown>,
  context: CommandContext,
): Promise<BackendCallResult> {
  let parsed: MediaDetailsArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context, 'media');
  }
  try {
    if (context.signal?.aborted === true) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const result = await executeMedia(
      'media',
      {
        action: 'details',
        platform: parsed.channel,
        ...(parsed.id !== undefined ? { id: parsed.id } : {}),
        ...(parsed.url !== undefined ? { url: parsed.url } : {}),
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
    const northstarCommand = mapMediaDetailsCommandResult(envelope, context);
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

export const mediaDetailsHandler = {
  commandId: MEDIA_DETAILS_COMMAND,
  execute: executeMediaDetails,
};
