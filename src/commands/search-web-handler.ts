import type { BackendCallResult } from '../backend.js';
import { cacheWebSearchForRetrieve } from '../native-fetch.js';
import { webSearch } from '../web/web.js';
import {
  type CommandOutcome,
  type CommandSource,
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import type { CommandContext } from './command-context.js';

export const SEARCH_WEB_COMMAND = 'search.web';

const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'action',
  'query',
  'queries',
  'limit',
  'includeContent',
  'recency',
  'domains',
  'yearFrom',
  'category',
  'knowledge',
  'mode',
  'cursor',
]);

function invalidRequest(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_request' });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : 'internal_error';
}

function fourDigitYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 2200;
}

export function parseSearchWebArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (args.cursor !== undefined) {
    throw Object.assign(new Error('cursor requires category "research"'), { code: 'cursor_invalid' });
  }

  for (const key of Object.keys(args)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw invalidRequest(`search.web rejects unknown field '${key}'`);
    }
  }

  const action = args.action;
  if (action !== undefined) {
    if (typeof action !== 'string' || action !== 'search') {
      throw invalidRequest(`Unsupported search action "${typeof action === 'string' ? action : ''}". Canonical action is "search".`);
    }
  }

  const category = typeof args.category === 'string' ? args.category.trim() : undefined;

  const hasQuery = args.query !== undefined;
  const hasQueries = args.queries !== undefined;
  if (!hasQuery && !hasQueries) {
    throw invalidRequest('query or queries[1..8] is required');
  }
  if (hasQuery && hasQueries) {
    throw invalidRequest('search accepts either query or queries[1..8], not both');
  }

  const parsed: Record<string, unknown> = { action: 'search' };

  if (hasQuery) {
    if (typeof args.query !== 'string' || args.query.trim() === '') {
      throw invalidRequest('query must be a non-empty string');
    }
    parsed.query = args.query.trim();
  }

  if (hasQueries) {
    if (!Array.isArray(args.queries) || args.queries.length < 1 || args.queries.length > 8) {
      throw invalidRequest('queries must be an array of 1..8 non-empty strings');
    }
    const cleanQueries: string[] = [];
    for (const q of args.queries) {
      if (typeof q !== 'string' || q.trim() === '') {
        throw invalidRequest('queries must contain non-empty strings');
      }
      cleanQueries.push(q.trim());
    }
    parsed.queries = cleanQueries;
  }

  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) {
      throw invalidRequest('limit must be an integer 1..20');
    }
    parsed.limit = args.limit;
  }

  if (args.includeContent !== undefined) {
    if (typeof args.includeContent !== 'boolean') {
      throw invalidRequest('includeContent must be a boolean');
    }
    parsed.includeContent = args.includeContent;
  }

  if (args.recency !== undefined) {
    if (typeof args.recency !== 'string' || args.recency.trim() === '') {
      throw invalidRequest('recency must be a non-empty string');
    }
    parsed.recency = args.recency.trim();
  }

  if (args.domains !== undefined) {
    if (!Array.isArray(args.domains) || args.domains.length < 1 || args.domains.length > 32) {
      throw invalidRequest('domains must be an array of 1..32 strings');
    }
    for (const d of args.domains) {
      if (typeof d !== 'string' || d.trim() === '') {
        throw invalidRequest('domains must contain non-empty strings');
      }
    }
    parsed.domains = args.domains.map((d) => String(d).trim());
  }

  if (args.yearFrom !== undefined) {
    if (!fourDigitYear(args.yearFrom)) {
      throw invalidRequest('yearFrom must be a four-digit year (1000..2200)');
    }
    parsed.yearFrom = args.yearFrom;
  }

  if (category !== undefined) {
    parsed.category = category;
  }

  if (args.knowledge !== undefined) {
    parsed.knowledge = args.knowledge;
  }

  if (args.mode !== undefined) {
    parsed.mode = args.mode;
  }

  return parsed;
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

export function mapSearchWebCommandResult(result: BackendCallResult, context: CommandContext): NorthstarCommandResultV1 {
  const details = (result.details ?? {}) as Record<string, unknown>;
  const canonical = details.northstar as Record<string, unknown> | undefined;
  const status = canonical?.status;

  const hits = Array.isArray(details.results) ? details.results : [];
  const fusion = (details.fusion ?? {}) as Record<string, unknown>;
  const failures = Array.isArray(fusion.failures) ? fusion.failures : [];
  const servedBackends = Array.isArray(fusion.backends)
    ? (fusion.backends as string[])
    : Array.isArray(fusion.servedBackends)
      ? (fusion.servedBackends as string[])
      : [];

  // Authoritative status precedence: error => failed; partial => partial;
  // degraded => degraded; explicit empty or successful zero-hit => empty;
  // normal hits => success. Zero-hit error/degraded-failure envelopes never
  // become success/empty. Residual ok-status provider failures with hits map
  // to partial so sibling failures stay observable.
  let outcome: CommandOutcome = 'success';
  let commandError: { code: string; message: string; retryable: boolean } | undefined;
  if (status === 'error') {
    outcome = 'failed';
    commandError = parseCanonicalError(canonical, 'Web search failed')
      ?? { code: 'upstream_error', message: 'Web search failed', retryable: false };
  } else if (status === 'partial') {
    outcome = 'partial';
    // Partial keeps hits AND the authoritative error: sibling failures stay
    // observable without collapsing into failure.
    commandError = parseCanonicalError(canonical, 'Web search partially succeeded');
  } else if (status === 'degraded') {
    outcome = 'degraded';
    // Degraded keeps hits AND the authoritative error for the same reason.
    commandError = parseCanonicalError(canonical, 'Web search degraded');
  } else if (status === 'empty' || hits.length === 0) {
    outcome = 'empty';
  } else if (failures.length > 0) {
    outcome = 'partial';
  }

  const sources: CommandSource[] = [];
  for (const backend of servedBackends) {
    if (typeof backend === 'string' && backend.length > 0) {
      sources.push({ kind: 'external', name: backend });
    }
  }
  if (sources.length === 0) {
    for (const hit of hits) {
      if (typeof (hit as { source?: unknown }).source === 'string') {
        const name = (hit as { source: string }).source;
        if (!sources.some((s) => s.name === name)) {
          sources.push({ kind: 'external', name });
        }
      }
    }
  }
  if (sources.length === 0) {
    sources.push({ kind: 'external', name: 'web' });
  }

  const failed = outcome === 'failed';
  const data: Record<string, unknown> | null = failed
    ? null
    : {
      query: details.query ?? details.effectiveQuery ?? '',
      results: hits,
      ...(details.responseId !== undefined ? { responseId: details.responseId } : {}),
      ...(details.fusion !== undefined ? { fusion: details.fusion } : {}),
      ...(details.category !== undefined ? { category: details.category } : {}),
    };

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: SEARCH_WEB_COMMAND,
    invocationId: context.invocationId,
    outcome,
    retryability: commandError !== undefined && commandError.retryable ? 'retryable' : 'not_retryable',
    data: data as unknown as Record<string, unknown>,
    sources,
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: SEARCH_WEB_COMMAND,
    attemptedSurfaces: [context.surface, SEARCH_WEB_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(commandError !== undefined
      ? { error: { code: commandError.code, message: commandError.message, retryable: commandError.retryable, category: 'web_search' } }
      : {}),
  };

  const check = validateCommandResult(mapped);
  if (!check.ok) {
    const fallbackData: Record<string, unknown> | null = failed
      ? null
      : {
        query: details.query ?? '',
        resultsCount: hits.length,
        ...(typeof details.responseId === 'string' ? { responseId: details.responseId } : {}),
      };
    mapped.data = fallbackData;
    const recheck = validateCommandResult(mapped);
    if (!recheck.ok) throw new TypeError(`Invalid mapped command result: ${recheck.issues.join('; ')}`);
  }

  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const isAbort = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError') || (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError');
  let code = isAbort ? 'cancelled' : errorCode(error);
  const message = error instanceof Error ? error.message : String(error);

  let category = 'web_search';
  let isRetryable = false;

  if (isAbort) {
    code = 'cancelled';
    category = 'cancelled';
    isRetryable = false;
  } else if (/auth|unauthorized|forbidden|401|403/i.test(message) || code === 'authentication_required' || code === 'auth') {
    code = 'authentication_required';
    category = 'auth';
    isRetryable = false;
  } else if (/rate[-_ ]?limit|429/i.test(message) || code === 'rate_limited') {
    code = 'rate_limited';
    category = 'rate_limit';
    isRetryable = true;
  } else if (code === 'cursor_invalid') {
    category = 'validation';
    isRetryable = false;
  } else if (/invalid|unsupported|required|must be/i.test(message) || code === 'invalid_input' || code === 'invalid_request') {
    code = 'invalid_request';
    category = 'validation';
    isRetryable = false;
  } else if (/timeout|upstream|failed|connection|network/i.test(message)) {
    code = 'upstream_error';
    category = 'network';
    isRetryable = true;
  }

  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: SEARCH_WEB_COMMAND,
    invocationId: context.invocationId,
    outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: isRetryable ? 'retryable' : 'not_retryable',
    data: null,
    sources: [{ kind: 'external', name: 'web' }],
    trust: 'external',
    requestedSurface: context.surface,
    resolvedSurface: SEARCH_WEB_COMMAND,
    attemptedSurfaces: [context.surface, SEARCH_WEB_COMMAND],
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
  if (isAbort && target.name !== 'AbortError') {
    try {
      (target as { name: string }).name = 'AbortError';
    } catch {
      // Ignore if name is read-only (e.g. DOMException)
    }
  }
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeSearchWeb(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
  let validatedArgs: Record<string, unknown>;
  try {
    validatedArgs = parseSearchWebArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }

  try {
    const result = await webSearch(validatedArgs, {
      env: context.env,
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.lookup ? { lookup: context.lookup } : {}),
    });

    // Batch evidence-identity gate: webSearch() fuses batch hits but reports
    // only one details.query (the first query), so caching the fused batch
    // under that query fabricates provenance. Cache only validated
    // single-query requests until per-query hit grouping exists.
    const isSingleQueryRequest = typeof validatedArgs.query === 'string' && validatedArgs.queries === undefined;
    try {
      const details = (result as { details?: Record<string, unknown> }).details;
      if (isSingleQueryRequest && details && typeof details.query === 'string' && Array.isArray(details.results) && details.responseId === undefined) {
        const hits = (details.results as Array<Record<string, unknown>>).map((hit) => {
          const backend = typeof hit.backend === 'string' ? hit.backend : typeof hit.source === 'string' ? hit.source : undefined;
          return {
            title: typeof hit.title === 'string' ? hit.title : String(hit.url ?? ''),
            url: typeof hit.url === 'string' ? hit.url : '',
            snippet: typeof hit.snippet === 'string' ? hit.snippet : '',
            ...(backend !== undefined ? { backend } : {}),
          };
        });
        const responseId = cacheWebSearchForRetrieve(details.query, hits);
        if (responseId !== undefined) {
          details.responseId = responseId;
        }
      }
    } catch {
      // Best-effort cache population; search result stands.
    }

    const commandResult = mapSearchWebCommandResult(result, context);
    return {
      ...result,
      details: {
        ...((result.details as Record<string, unknown> | undefined) ?? {}),
        northstarCommand: commandResult,
      },
    };
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const searchWebHandler = {
  commandId: SEARCH_WEB_COMMAND,
  execute: executeSearchWeb,
};
