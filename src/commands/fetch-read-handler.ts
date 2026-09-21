import type { BackendCallResult } from '../backend.js';
import { dispatchFetch, resultToSingleText, type NativeFetchOptions } from '../native-fetch.js';
import {
  type CommandOutcome,
  type CommandSource,
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import type { CommandContext } from './command-context.js';

export const FETCH_READ_COMMAND = 'fetch.read';

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'url',
  'urls',
  'query',
  'topK',
  'maxChars',
  'siteMap',
  'maxPages',
  'responseId',
  'sourceIds',
  'offset',
  'limit',
  'findText',
  'claims',
]);

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function requireSourceIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalidInput('sourceIds must be an array');
  if (value.length > 32) throw invalidInput('sourceIds must contain at most 32 entries');
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw invalidInput('sourceIds entries must be non-empty strings');
    }
    out.push(entry.trim());
  }
  return out;
}

export function parseFetchReadArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.provider !== undefined) {
    throw new Error('provider selection is operator-only (PI_SEARCH_WEB_BACKENDS); omit provider');
  }
  if (args.format !== undefined) {
    throw new Error('format is not a supported fetch field');
  }

  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidInput(`fetch.read rejects unknown field '${key}'`);
    }
  }

  const action = args.action;
  if (action !== undefined) {
    if (typeof action !== 'string' || (action !== 'read' && action !== 'retrieve' && action !== 'source_check')) {
      throw invalidInput(`Unsupported fetch action "${typeof action === 'string' ? action : ''}". Expected "read", "retrieve", or "source_check".`);
    }
  }

  // Branch 1: claims -> cached claim check (source_check)
  if (args.claims !== undefined) {
    if (args.responseId === undefined || typeof args.responseId !== 'string' || args.responseId.trim() === '') {
      throw invalidInput('source_check requires responseId');
    }
    if (!Array.isArray(args.claims) || args.claims.length < 1 || args.claims.length > 20) {
      throw invalidInput('source_check requires claims[1..20]');
    }
    for (const c of args.claims) {
      if (typeof c !== 'string' || c.trim() === '') {
        throw invalidInput('claims must contain non-empty strings');
      }
    }
    for (const forbidden of ['offset', 'limit', 'findText', 'url', 'urls', 'siteMap', 'maxPages', 'topK', 'maxChars'] as const) {
      if (args[forbidden] !== undefined) {
        throw invalidInput(`source_check rejects '${forbidden}': claim-check serves cached claims only`);
      }
    }
    if (action !== undefined && action !== 'source_check') {
      throw invalidInput(`source_check rejects action '${action}': claim-check serves cached claims only`);
    }
    const parsed: Record<string, unknown> = {
      action: 'source_check',
      responseId: (args.responseId as string).trim(),
      claims: args.claims.map((c) => String(c).trim()),
    };
    if (args.sourceIds !== undefined) {
      parsed.sourceIds = requireSourceIds(args.sourceIds);
    }
    return parsed;
  }

  // Branch 2: responseId -> cached corpus retrieve
  if (args.responseId !== undefined) {
    if (typeof args.responseId !== 'string' || args.responseId.trim() === '') {
      throw invalidInput('retrieve requires responseId');
    }
    for (const forbidden of ['url', 'urls', 'siteMap', 'maxPages', 'topK', 'maxChars', 'claims'] as const) {
      if (args[forbidden] !== undefined) {
        throw invalidInput(`retrieve rejects '${forbidden}': retrieve serves cached corpus only`);
      }
    }
    if (action !== undefined && action !== 'retrieve') {
      throw invalidInput(`retrieve rejects action '${action}': retrieve serves cached corpus only`);
    }
    const parsed: Record<string, unknown> = {
      action: 'retrieve',
      responseId: (args.responseId as string).trim(),
    };
    if (args.offset !== undefined) {
      if (typeof args.offset !== 'number' || !Number.isInteger(args.offset) || args.offset < 0) {
        throw invalidInput('offset must be a non-negative integer');
      }
      parsed.offset = args.offset;
    }
    if (args.limit !== undefined) {
      if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50000) {
        throw invalidInput('limit must be an integer 1..50000');
      }
      parsed.limit = args.limit;
    }
    if (args.findText !== undefined) {
      if (typeof args.findText !== 'string' || args.findText.trim() === '') {
        throw invalidInput('findText must be a non-empty string');
      }
      parsed.findText = args.findText.trim();
    }
    if (args.sourceIds !== undefined) {
      parsed.sourceIds = requireSourceIds(args.sourceIds);
    }
    return parsed;
  }

  // Branch 3: siteMap -> discovered same-origin URLs
  if (args.siteMap !== undefined) {
    if (action !== undefined) throw invalidInput(`sitemap rejects action '${action}'`);
    if (args.siteMap !== true) throw invalidInput('sitemap requires siteMap:true');
    if (args.url === undefined || typeof args.url !== 'string' || !isHttpUrl(args.url.trim())) {
      throw invalidInput('sitemap requires url with HTTP(S) scheme');
    }
    for (const forbidden of ['urls', 'topK', 'responseId', 'claims', 'sourceIds', 'offset', 'limit', 'findText'] as const) {
      if (args[forbidden] !== undefined) {
        throw invalidInput(`sitemap rejects '${forbidden}'`);
      }
    }
    const parsed: Record<string, unknown> = {
      url: (args.url as string).trim(),
      siteMap: true,
    };
    if (args.query !== undefined) {
      if (typeof args.query !== 'string') throw invalidInput('query must be a string');
      if (args.query.trim() !== '') parsed.query = args.query.trim();
    }
    if (args.maxPages !== undefined) {
      if (typeof args.maxPages !== 'number' || !Number.isInteger(args.maxPages) || args.maxPages < 1 || args.maxPages > 25) {
        throw invalidInput('maxPages must be an integer 1..25');
      }
      parsed.maxPages = args.maxPages;
    }
    return parsed;
  }

  // Branch 4: urls -> multi-URL read
  if (args.urls !== undefined) {
    if (action !== undefined) throw invalidInput(`multi-fetch rejects action '${action}'`);
    if (args.url !== undefined) {
      throw invalidInput('fetch accepts either url or urls[1..8], not both');
    }
    if (!Array.isArray(args.urls) || args.urls.length < 1 || args.urls.length > 8) {
      throw invalidInput('fetch requires urls[1..8]');
    }
    const cleanedUrls: string[] = [];
    for (const u of args.urls) {
      if (typeof u !== 'string' || !isHttpUrl(u.trim())) {
        throw invalidInput("fetch url must be an HTTP(S) or GitHub asset URL, got unsupported scheme or filesystem path in 'urls'");
      }
      cleanedUrls.push(u.trim());
    }
    for (const forbidden of ['siteMap', 'maxPages', 'responseId', 'claims', 'sourceIds', 'offset', 'limit', 'findText'] as const) {
      if (args[forbidden] !== undefined) {
        throw invalidInput(`multi-fetch rejects '${forbidden}'`);
      }
    }
    const parsed: Record<string, unknown> = { urls: cleanedUrls };
    if (args.query !== undefined) {
      if (typeof args.query !== 'string') throw invalidInput('query must be a string');
      if (args.query.trim() !== '') parsed.query = args.query.trim();
    }
    if (args.topK !== undefined) {
      if (typeof args.topK !== 'number' || !Number.isInteger(args.topK) || args.topK < 1 || args.topK > 20) {
        throw invalidInput('topK must be an integer 1..20');
      }
      parsed.topK = args.topK;
    }
    if (args.maxChars !== undefined) {
      if (typeof args.maxChars !== 'number' || !Number.isInteger(args.maxChars) || args.maxChars < 1 || args.maxChars > 50000) {
        throw invalidInput('maxChars must be an integer 1..50000');
      }
      parsed.maxChars = args.maxChars;
    }
    return parsed;
  }

  // Branch 5: url -> singular URL read
  if (args.url !== undefined) {
    if (action !== undefined && action !== 'read') {
      throw invalidInput(`fetch read rejects action '${action}'`);
    }
    if (typeof args.url !== 'string' || !isHttpUrl(args.url.trim())) {
      throw invalidInput("fetch url must be an HTTP(S) or GitHub asset URL, got unsupported scheme or filesystem path in 'url'");
    }
    for (const forbidden of ['urls', 'siteMap', 'maxPages', 'responseId', 'claims', 'sourceIds', 'offset', 'limit', 'findText'] as const) {
      if (args[forbidden] !== undefined) {
        throw invalidInput(`fetch read rejects '${forbidden}'`);
      }
    }
    const parsed: Record<string, unknown> = {
      action: 'read',
      url: (args.url as string).trim(),
    };
    if (args.query !== undefined) {
      if (typeof args.query !== 'string') throw invalidInput('query must be a string');
      if (args.query.trim() !== '') parsed.query = args.query.trim();
    }
    if (args.topK !== undefined) {
      if (typeof args.topK !== 'number' || !Number.isInteger(args.topK) || args.topK < 1 || args.topK > 20) {
        throw invalidInput('topK must be an integer 1..20');
      }
      parsed.topK = args.topK;
    }
    if (args.maxChars !== undefined) {
      if (typeof args.maxChars !== 'number' || !Number.isInteger(args.maxChars) || args.maxChars < 1 || args.maxChars > 50000) {
        throw invalidInput('maxChars must be an integer 1..50000');
      }
      parsed.maxChars = args.maxChars;
    }
    return parsed;
  }

  throw invalidInput('url is required: pass url, urls[1..8], siteMap:true with url, responseId, or responseId with claims[1..20]');
}

/** Shape-safe first canonical northstar.errors entry: bounded code/message
 *  with retryability from the authoritative retryable bit. Undefined when the
 *  envelope carries no usable error entry — ordinary empty invents none. */
function parseCanonicalError(
  canonical: Record<string, unknown> | undefined,
  fallbackMessage: string,
): { code: string; message: string; retryable: boolean } | undefined {
  const errors = Array.isArray(canonical?.errors) ? (canonical?.errors as Array<unknown>) : [];
  const first = errors.length > 0 && typeof errors[0] === 'object' && errors[0] !== null
    ? (errors[0] as Record<string, unknown>)
    : undefined;
  if (first === undefined) return undefined;
  const code = typeof first.code === 'string' && first.code.length > 0 ? first.code.slice(0, 256) : 'upstream_error';
  const message = typeof first.message === 'string' && first.message.length > 0
    ? first.message.slice(0, 4096)
    : fallbackMessage;
  return { code, message, retryable: first.retryable === true };
}

export function mapFetchReadCommandResult(result: BackendCallResult, context: CommandContext): NorthstarCommandResultV1 {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const canonical = details.northstar as Record<string, unknown> | undefined;
  const status = canonical?.status;

  const outcomes = (canonical?.outcomes ?? []) as Array<Record<string, unknown>>;
  const degradedMarker = details.degraded === true || details.fallback !== undefined || details.externalFetch !== undefined || outcomes.some((o) => o.degraded === true);

  // Authoritative status precedence: error => failed (null data); partial =>
  // partial; degraded => degraded; explicit empty or successful zero-content
  // => empty; normal content => success. Fallback/degraded markers apply only
  // after error precedence. First bounded canonical error is preserved for
  // failed/partial/degraded; ordinary empty invents none.
  let outcome: CommandOutcome = 'success';
  let commandError: { code: string; message: string; retryable: boolean } | undefined;
  if (status === 'error') {
    outcome = 'failed';
    commandError = parseCanonicalError(canonical, 'Fetch failed')
      ?? { code: 'upstream_error', message: 'Fetch failed', retryable: false };
  } else if (status === 'partial') {
    outcome = 'partial';
    commandError = parseCanonicalError(canonical, 'Fetch partially succeeded');
  } else if (status === 'degraded') {
    outcome = 'degraded';
    commandError = parseCanonicalError(canonical, 'Fetch degraded');
  } else if (degradedMarker) {
    outcome = 'degraded';
    commandError = parseCanonicalError(canonical, 'Fetch degraded');
  } else if (status === 'empty') {
    outcome = 'empty';
  } else if (details.action === 'retrieve') {
    const text = typeof resultToSingleText(result) === 'string' ? resultToSingleText(result).trim() : '';
    const matches = Array.isArray(details.matches) ? details.matches : [];
    if (text === '' && matches.length === 0) outcome = 'empty';
  } else if (typeof details.action === 'string' && details.action === 'source_check') {
    const text = typeof resultToSingleText(result) === 'string' ? resultToSingleText(result).trim() : '';
    if (text === '') outcome = 'empty';
  } else if (Array.isArray(details.urls) && details.urls.length === 0) {
    outcome = 'empty';
  } else if (typeof resultToSingleText(result) === 'string' && resultToSingleText(result).trim() === '') {
    const siteMap = details.siteMap as Record<string, unknown> | undefined;
    const siteUrls = Array.isArray(siteMap?.urls) ? siteMap.urls : [];
    if (siteUrls.length === 0) outcome = 'empty';
  }

  const sources: CommandSource[] = [];
  const siteMap = details.siteMap as Record<string, unknown> | undefined;
  if (Array.isArray(siteMap?.urls) && (siteMap.urls as unknown[]).length > 0) {
    for (const u of siteMap.urls as unknown[]) {
      if (typeof u === 'string') {
        sources.push({ kind: 'external', name: 'web', locator: u });
      }
    }
  } else if (typeof details.url === 'string') {
    let hostname = 'web';
    try {
      hostname = new URL(details.url).hostname || 'web';
    } catch {
      /* ignore malformed url */
    }
    sources.push({ kind: 'external', name: hostname, locator: details.url });
  } else if (Array.isArray(details.urls) && details.urls.length > 0) {
    for (const u of details.urls) {
      if (typeof u === 'string') {
        sources.push({ kind: 'external', name: 'web', locator: u });
      }
    }
  } else if (typeof details.responseId === 'string') {
    // Cached retrieve/source_check provenance: internal cache locator. Trust
    // stays external because the cached evidence originated externally.
    sources.push({ kind: 'internal', name: 'cache', locator: details.responseId });
  } else {
    sources.push({ kind: 'external', name: 'web' });
  }

  const failed = outcome === 'failed';
  const data: Record<string, unknown> | null = failed
    ? null
    : (() => {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(details)) {
        if (key === 'northstar' || key === 'northstarCommand') continue;
        out[key] = val;
      }
      const contentText = resultToSingleText(result);
      if (out.content === undefined && contentText) {
        out.content = contentText.length > 10000 ? contentText.slice(0, 10000) : contentText;
      }
      return out;
    })();

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: FETCH_READ_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: commandError !== undefined && commandError.retryable ? 'retryable' : 'not_retryable',
    data: data as unknown as Record<string, unknown>,
    sources,
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: FETCH_READ_COMMAND,
    attemptedSurfaces: [context.surface, FETCH_READ_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(commandError !== undefined
      ? { error: { code: commandError.code, message: commandError.message, retryable: commandError.retryable, category: 'fetch' } }
      : {}),
  };

  const check = validateCommandResult(mapped);
  if (!check.ok) {
    const fallbackData: Record<string, unknown> | null = failed
      ? null
      : {
        ...(typeof details.url === 'string' ? { url: details.url } : {}),
        ...(typeof details.title === 'string' ? { title: details.title } : {}),
        ...(typeof details.responseId === 'string' ? { responseId: details.responseId } : {}),
        ...(typeof details.action === 'string' ? { action: details.action } : {}),
      };
    mapped.data = fallbackData;
    const recheck = validateCommandResult(mapped);
    if (!recheck.ok) throw new TypeError(`Invalid mapped command result: ${recheck.issues.join('; ')}`);
  }

  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const isAbort = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError');
  let code = isAbort ? 'cancelled' : errorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  let category = 'fetch';
  let isRetryable = false;

  if (isAbort) {
    code = 'cancelled';
    category = 'cancelled';
    isRetryable = false;
  } else if (/private\/reserved|blocked hostname|ssrf/i.test(message) || code === 'ssrf_denied') {
    code = 'ssrf_denied';
    category = 'security';
    isRetryable = false;
  } else if (/auth|unauthorized|forbidden|401|403/i.test(message) || code === 'authentication_required' || code === 'auth') {
    code = 'authentication_required';
    category = 'auth';
    isRetryable = false;
  } else if (/rate[-_ ]?limit|429/i.test(message) || code === 'rate_limited') {
    code = 'rate_limited';
    category = 'rate_limit';
    isRetryable = true;
  } else if (/invalid|unsupported|required|must be/i.test(message) || code === 'invalid_input' || code === 'invalid_request') {
    code = 'invalid_input';
    category = 'validation';
    isRetryable = false;
  } else if (/timeout|network|connection|econnreset|etimedout/i.test(message) || code === 'timeout' || code === 'network') {
    code = 'upstream_error';
    category = 'network';
    isRetryable = true;
  }

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: FETCH_READ_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: isRetryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'fetch' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: FETCH_READ_COMMAND,
    attemptedSurfaces: [context.surface, FETCH_READ_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    error: {
      code,
      message,
      retryable: isRetryable,
      category,
    },
  };

  const target = error instanceof Error ? error : new Error(message);
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeFetchRead(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
  let validatedArgs: Record<string, unknown>;
  try {
    validatedArgs = parseFetchReadArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }

  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const options: NativeFetchOptions = { env: context.env };
    if (context.signal !== undefined) options.signal = context.signal;
    if (context.lookup !== undefined) options.lookup = context.lookup;
    if (context.fetchPageText !== undefined) options.fetchPageText = context.fetchPageText;

    let result = await dispatchFetch(validatedArgs, options);
    // Recheck abort: per-URL isolation may have swallowed an in-flight abort
    // into isolated error entries instead of throwing.
    if (context.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    // source_check details carry the artifact (with a fresh artifact id), not
    // the request responseId; restore the internal cache locator so provenance
    // identifies the cache handle. Trust stays external (see mapper).
    if (
      validatedArgs.action === 'source_check' &&
      typeof validatedArgs.responseId === 'string' &&
      (typeof (result.details as Record<string, unknown> | undefined)?.responseId !== 'string')
    ) {
      result = {
        ...result,
        details: {
          ...((result.details as Record<string, unknown> | undefined) ?? {}),
          responseId: validatedArgs.responseId,
        },
      };
    }
    const commandResult = mapFetchReadCommandResult(result, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand: commandResult,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) {
      const candidate = (error as { commandResult?: unknown }).commandResult;
      if (validateCommandResult(candidate).ok) throw error;
    }
    return attachFailure(error, context);
  }
}

export const fetchReadHandler = {
  commandId: FETCH_READ_COMMAND,
  execute: executeFetchRead,
};
