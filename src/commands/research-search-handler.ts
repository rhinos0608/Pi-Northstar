import { AGGREGATE_RESEARCH_SOURCE } from '../capabilities.js';
import { northstarTextResult } from '../core/tool-output.js';
import {
  RESEARCH_CANONICAL_ACTION,
  RESEARCH_LEGACY_ACTION_ALIAS,
} from '../research/research-adapter-shared.js';
import { MAX_CURSOR_LENGTH } from '../result-contract.js';
import { searchResearchPage } from '../research/research-sources.js';
import type { NorthstarResultV1 } from '../result-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';
import type { BackendCallResult } from '../backend.js';

export const RESEARCH_SEARCH_COMMAND = 'research.search';

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'internal_error';
}

function retryable(code: string): boolean {
  return code === 'rate_limited' || code === 'timeout' || code === 'backend_unavailable';
}

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

function fourDigitYear(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1000 && value <= 2200;
}

interface ResearchSearchArgs {
  query: string;
  source: string;
  limit: number;
  cursor?: string;
  yearFrom?: number;
  yearTo?: number;
  author?: string;
  doi?: string;
  venue?: string;
  requestedAction?: string;
}

/**
 * Strict argument gate (reject-not-clamp). Structured filters that the seam
 * and adapters cannot serve stay in the request: per-source unsupported
 * filters surface as invalid_input from the adapter, never dropped here.
 * Non-string author/doi/venue reject here because the seam would ignore
 * non-string values silently.
 *
 * Slice 2 pagination: a caller-supplied cursor rides the same command path.
 * It must be a non-empty opaque token within the contract bound; selector
 * binding (source/query/yearFrom fingerprint), per-source cursor modes, and
 * the aggregate source:all reject live in the seam/adapters behind the exact
 * legacy codes (invalid_input / pagination_not_supported), which return as
 * envelope failures, never thrown.
 */
function parseArgs(args: Record<string, unknown>): ResearchSearchArgs {
  const action = args.action;
  let requestedAction: string | undefined;
  if (action !== undefined) {
    if (typeof action !== 'string' || (action !== RESEARCH_CANONICAL_ACTION && action !== RESEARCH_LEGACY_ACTION_ALIAS)) {
      throw invalidInput(`Unsupported research action "${typeof action === 'string' ? action : ''}". Canonical action is "${RESEARCH_CANONICAL_ACTION}".`);
    }
    requestedAction = action;
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw invalidInput('query is required');
  // Source passes through unvalidated: the seam returns an explicit
  // invalid_input envelope for unknown sources without touching the network
  // (no generic-web substitution). Only non-string values reject here because
  // the seam would silently coerce them to the aggregate default.
  const source = args.source === undefined ? AGGREGATE_RESEARCH_SOURCE : args.source;
  if (typeof source !== 'string') {
    throw invalidInput('source must be a source id or "all"');
  }
  const parsed: ResearchSearchArgs = { query, source, limit: 12 };
  if (requestedAction !== undefined) parsed.requestedAction = requestedAction;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== 'string' || args.cursor.length === 0) {
      throw invalidInput('cursor must be a non-empty opaque token');
    }
    if (args.cursor.length > MAX_CURSOR_LENGTH) {
      throw invalidInput(`cursor exceeds maximum length of ${MAX_CURSOR_LENGTH}`);
    }
    parsed.cursor = args.cursor;
  }
  // Limit rejects out-of-range instead of clamping. The code stays
  // invalid_request (legacy native-research contract, pinned by web tests);
  // the message names the 1..30 bound explicitly.
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 30) {
      throw Object.assign(new Error('limit must be an integer 1..30'), { code: 'invalid_request' });
    }
    parsed.limit = args.limit;
  }
  if (args.yearFrom !== undefined) {
    if (!fourDigitYear(args.yearFrom)) throw invalidInput('yearFrom must be a four-digit year');
    parsed.yearFrom = args.yearFrom;
  }
  if (args.yearTo !== undefined) {
    if (!fourDigitYear(args.yearTo)) throw invalidInput('yearTo must be a four-digit year');
    if (parsed.yearFrom !== undefined && args.yearTo < parsed.yearFrom) {
      throw invalidInput('yearTo must not be earlier than yearFrom');
    }
    parsed.yearTo = args.yearTo;
  }
  for (const field of ['author', 'doi', 'venue'] as const) {
    const value = args[field];
    if (value === undefined) continue;
    if (typeof value !== 'string') throw invalidInput(`${field} filter must be a string`);
    if (value.trim() !== '') parsed[field] = value.trim();
  }
  return parsed;
}

function commandSources(envelope: NorthstarResultV1): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry: { source: string }) => entry.source);
  const fallback = typeof envelope.request.source === 'string' ? envelope.request.source : 'research';
  const unique = [...new Set(names.length > 0 ? names : [fallback])];
  return unique.map((name) => ({ kind: 'external' as const, name }));
}

interface ResearchResultRow {
  title: string;
  url: string;
  snippet: string;
  source: string;
  abstract?: string;
}

function resultRows(envelope: NorthstarResultV1): ResearchResultRow[] {
  const entities = envelope.data.kind === 'entities' ? envelope.data.entities : [];
  return entities.map((entity) => {
    const rawAbstract = (entity as unknown as Record<string, unknown>)['abstract'];
    const abstract = typeof rawAbstract === 'string' && rawAbstract.trim() !== '' ? rawAbstract : undefined;
    return {
      title: entity.title || entity.id,
      url: entity.url,
      snippet: entity.snippet ?? '',
      source: entity.source,
      ...(abstract === undefined ? {} : { abstract }),
    };
  });
}

function resultText(envelope: NorthstarResultV1, query: string, rows: ResearchResultRow[]): string {
  let text = rows.length > 0
    ? rows.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n')
    : `No research results for: ${query}`;
  const failedSources = [...new Set(envelope.errors.map((error) => error.source))];
  if (envelope.status === 'error' && envelope.errors[0]) {
    text = `Research error (${envelope.request.source}): ${envelope.errors[0].message}`;
  } else if (failedSources.length > 0 && rows.length > 0) {
    text += `\n\nFailed sources: ${failedSources.join(', ')}.`;
  }
  return text;
}

export function mapResearchSearchCommandResult(envelope: NorthstarResultV1, context: CommandContext): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded' : 'failed';
  const firstError = envelope.errors[0];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: RESEARCH_SEARCH_COMMAND,
    invocationId: context.invocationId, outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope), trust: 'external',
    requestedSurface: context.surface, resolvedSurface: RESEARCH_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_SEARCH_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: 'research' } }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const code = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : errorCode(error);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: RESEARCH_SEARCH_COMMAND,
    invocationId: context.invocationId, outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable', data: null,
    sources: [{ kind: 'external', name: 'research' }], trust: 'external',
    requestedSurface: context.surface, resolvedSurface: RESEARCH_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, RESEARCH_SEARCH_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    error: { code, message: error instanceof Error ? error.message : 'Research search request failed', retryable: retryable(code), category: code === 'cancelled' ? 'cancelled' : 'research' },
  };
  const target = error instanceof Error ? error : new Error('Research search request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

export async function executeResearchSearch(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
  let parsed: ResearchSearchArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const envelope = await searchResearchPage(
      {
        query: parsed.query,
        source: parsed.source,
        limit: parsed.limit,
        ...(parsed.cursor !== undefined ? { cursor: parsed.cursor } : {}),
        ...(parsed.yearFrom !== undefined ? { yearFrom: parsed.yearFrom } : {}),
        ...(parsed.yearTo !== undefined ? { yearTo: parsed.yearTo } : {}),
        ...(parsed.author !== undefined ? { author: parsed.author } : {}),
        ...(parsed.doi !== undefined ? { doi: parsed.doi } : {}),
        ...(parsed.venue !== undefined ? { venue: parsed.venue } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
        env: context.env,
        ...(context.lookup !== undefined ? { lookup: context.lookup } : {}),
      },
      {
        tool: 'research',
        channel: 'research',
        action: RESEARCH_CANONICAL_ACTION,
        ...(parsed.requestedAction !== undefined ? { requestedAction: parsed.requestedAction } : {}),
      },
    );
    // Adapters may convert an in-flight AbortError into an error envelope;
    // re-check caller cancellation before exposing that envelope as ordinary failure.
    if (context.signal?.aborted) {
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }
    const northstarCommand = mapResearchSearchCommandResult(envelope, context);
    // Legacy-identical return shape: {query, source, results} rows plus the
    // canonical envelope, with the registry command identity stamped
    // additively. Envelope errors return as text (never thrown) exactly like
    // the pre-migration native path; only arg-validation failures throw.
    const rows = resultRows(envelope);
    const result = northstarTextResult(resultText(envelope, parsed.query, rows),
      { query: parsed.query, source: parsed.source, results: rows }, envelope);
    (result.details as Record<string, unknown>).northstarCommand = northstarCommand;
    return result;
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const researchSearchHandler = { commandId: RESEARCH_SEARCH_COMMAND, execute: executeResearchSearch };
