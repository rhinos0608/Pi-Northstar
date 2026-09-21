import type { BackendCallResult } from '../backend.js';
import { textResult } from '../core/tool-output.js';
import { wrapUntrustedText } from '../core/untrusted-content.js';
import { DIFFBOT_KG_PROVIDER, searchDiffbotKg } from '../diffbot/diffbot-kg.js';
import { assembleKgSearchResult, resolveKgSpend, runKgProviderPlan } from '../knowledge/knowledge-execution.js';
import { decodePinnedKgCursor, fingerprintKgRequest, issueKgCursor } from '../knowledge/knowledge-domain.js';
import { DIFFBOT_KG_ADAPTER_CURSOR_V, DIFFBOT_KG_MAX_FROM } from '../diffbot/diffbot-kg.js';
import {
  validateKgSearch,
  type KgEntity,
  type KgError,
  type KgResult,
} from '../knowledge/knowledge-contract.js';
import { validateCommandResult, type NorthstarCommandResultV1 } from './command-result.js';
import type { CommandContext } from './command-context.js';

export const KG_SEARCH_COMMAND = 'kg.search';

/** Retryable kg search failures: transport/upstream only. Auth/input/contract stay terminal. */
function retryable(code: string): boolean {
  return code === 'transport_invalid_response' || code === 'upstream_error';
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code : 'internal_error';
}

function invalidInput(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

const SEARCH_ARG_KEYS = new Set(['action', 'query', 'language', 'limit', 'cursor']);

interface KgSearchArgs {
  query: string;
  limit?: number;
  cursor?: string;
}

/**
 * Strict argument gate (reject-not-clamp). Unknown keys reject so a caller
 * cannot believe a constraint was applied when it was not. Limit bounds come
 * from the owning contract validator (1..50); omitted limit uses the adapter
 * default downstream.
 */
function parseArgs(args: Record<string, unknown>): KgSearchArgs {
  for (const key of Object.keys(args)) {
    if (!SEARCH_ARG_KEYS.has(key)) throw invalidInput(`unknown kg.search field: ${key}`);
  }
  if (args.action !== undefined && args.action !== 'search') {
    throw invalidInput('action must be "search" for kg.search');
  }
  if (args.cursor !== undefined && typeof args.cursor !== 'string') throw invalidInput('cursor must be a string');
  const validated = validateKgSearch({ query: args.query, language: args.language ?? 'dql', limit: args.limit });
  if (!validated.ok) throw Object.assign(new Error(validated.message), { code: validated.code });
  const out: KgSearchArgs = { query: (validated as { query: string }).query };
  const limit = (validated as { limit?: number }).limit;
  if (limit !== undefined) out.limit = limit;
  if (args.cursor !== undefined) out.cursor = args.cursor;
  return out;
}

function commandSources(envelope: KgResult): NorthstarCommandResultV1['sources'] {
  const names = envelope.sources.map((entry) => entry.provider);
  const unique = [...new Set(names.length > 0 ? names : [DIFFBOT_KG_PROVIDER])];
  return unique.map((name) => ({ kind: 'external' as const, name }));
}

export function mapKgSearchCommandResult(envelope: KgResult, context: CommandContext): NorthstarCommandResultV1 {
  const outcome = envelope.status === 'ok' ? 'success'
    : envelope.status === 'empty' ? 'empty'
    : envelope.status === 'partial' ? 'partial'
    : envelope.status === 'degraded' ? 'degraded' : 'failed';
  const firstError: KgError | undefined = envelope.errors[0];
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: KG_SEARCH_COMMAND,
    invocationId: context.invocationId, outcome,
    retryability: firstError?.retryable === true ? 'retryable' : 'not_retryable',
    data: envelope.data,
    sources: commandSources(envelope), trust: 'external',
    requestedSurface: context.surface, resolvedSurface: KG_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, KG_SEARCH_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    ...(outcome === 'failed' && firstError !== undefined
      ? { error: { code: firstError.code, message: firstError.message, retryable: firstError.retryable, category: 'kg' } }
      : {}),
  };
  const check = validateCommandResult(mapped);
  if (!check.ok) throw new TypeError(`Invalid mapped command result: ${check.issues.join('; ')}`);
  return mapped;
}

function attachFailure(error: unknown, context: CommandContext): never {
  const code = context.signal?.aborted || (error instanceof Error && error.name === 'AbortError') ? 'cancelled' : errorCode(error);
  const mapped: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId: KG_SEARCH_COMMAND,
    invocationId: context.invocationId, outcome: code === 'cancelled' ? 'cancelled' : 'failed',
    retryability: retryable(code) ? 'retryable' : 'not_retryable', data: null,
    sources: [{ kind: 'external', name: DIFFBOT_KG_PROVIDER }], trust: 'external',
    requestedSurface: context.surface, resolvedSurface: KG_SEARCH_COMMAND,
    attemptedSurfaces: [context.surface, KG_SEARCH_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' }, verifiedArtifacts: [], nextActions: [],
    error: { code, message: error instanceof Error ? error.message : 'KG search request failed', retryable: retryable(code), category: code === 'cancelled' ? 'cancelled' : 'kg' },
  };
  const target = error instanceof Error ? error : new Error('KG search request failed');
  Object.defineProperty(target, 'commandResult', { value: mapped, enumerable: false });
  throw target;
}

function entitiesText(query: string, entities: KgEntity[]): string {
  if (entities.length > 0) {
    return entities
      .map((entity, index) => `## ${index + 1}. ${entity.name ?? entity.id}\n${entity.url ?? entity.id}\ntype: ${entity.type}`)
      .join('\n\n');
  }
  return `No kg search results for: ${query}`;
}

export async function executeKgSearch(args: Record<string, unknown>, context: CommandContext): Promise<BackendCallResult> {
  let parsed: KgSearchArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return attachFailure(error, context);
  }
  try {
    if (context.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const token = typeof context.env.DIFFBOT_TOKEN === 'string' ? context.env.DIFFBOT_TOKEN.trim() : '';
    const spend = resolveKgSpend(context.env);
    const configured = [DIFFBOT_KG_PROVIDER];
    const pageSize = parsed.limit ?? spend.searchSize;
    const fingerprint = fingerprintKgRequest({ action: 'search', query: parsed.query, limit: pageSize, providers: 'auto' });
    let from = 0;
    if (parsed.cursor !== undefined) {
      const pinned = decodePinnedKgCursor(parsed.cursor, { provider: DIFFBOT_KG_PROVIDER, fingerprint, adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V });
      const rawFrom = pinned.state.from;
      if (typeof rawFrom !== 'number' || !Number.isInteger(rawFrom) || rawFrom < 0 || rawFrom > DIFFBOT_KG_MAX_FROM || rawFrom + pageSize > DIFFBOT_KG_MAX_FROM) throw invalidInput('cursor state.from out of range');
      from = rawFrom;
    }
    const { outcomes, providers } = await runKgProviderPlan('search', undefined, configured, spend.maxProviders, async (_provider) => {
      const raw = await searchDiffbotKg(
        { query: parsed.query, language: 'dql', limit: pageSize, from },
        { token, spend: { searchDefault: spend.searchSize, searchCap: spend.searchSize }, ...(context.signal ? { signal: context.signal } : {}) },
      );
      return raw.error
        ? { provider: raw.provider, entities: raw.entities, invalid: raw.invalid, error: { code: raw.error.code, message: raw.error.message, retryable: raw.error.retryable } }
        : { provider: raw.provider, entities: raw.entities, invalid: raw.invalid };
    });
    const rawCount = outcomes[0]?.entities?.length ?? 0;
    const hasMore = rawCount >= pageSize && from + pageSize < DIFFBOT_KG_MAX_FROM;
    const nextCursor = hasMore ? issueKgCursor({ provider: DIFFBOT_KG_PROVIDER, fingerprint, adapterCursorV: DIFFBOT_KG_ADAPTER_CURSOR_V, state: { from: from + pageSize }, fanout: false }) : undefined;
    const { entities, envelope } = assembleKgSearchResult({ query: parsed.query, outcomes, providers, limit: pageSize, pagination: { supported: true, hasMore, ...(nextCursor === undefined ? {} : { nextCursor }) } });
    const northstarCommand = mapKgSearchCommandResult(envelope, context);
    const text = envelope.errors.length > 0 && entities.length === 0
      ? `Kg search error (${envelope.errors[0]?.provider ?? DIFFBOT_KG_PROVIDER}): ${envelope.errors[0]?.message ?? 'unknown'}`
      : entitiesText(parsed.query, entities);
    const result = textResult(wrapUntrustedText(text, { source: 'kg' }), {
      action: 'search', query: parsed.query, providers, knowledge: envelope,
    });
    (result.details as Record<string, unknown>).northstarCommand = northstarCommand;
    return result;
  } catch (error) {
    if (error instanceof Error && 'commandResult' in error) throw error;
    return attachFailure(error, context);
  }
}

export const kgSearchHandler = { commandId: KG_SEARCH_COMMAND, execute: executeKgSearch };
