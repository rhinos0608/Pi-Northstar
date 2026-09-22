// Research seam: the single entry point the native dispatcher calls for
// category=research searches. Wires every advertised research source to its
// exact native adapter — there is no web-search substitution and no default
// fallback. Unknown or unsupported sources return explicit safe error
// envelopes, never a substituted result.
//
// Canonical action vocabulary: `search` is the single canonical action
// (RESEARCH_CANONICAL_ACTION); the legacy `academic` spelling the research()
// route historically sent is still accepted for stability. Any other action
// spelling is rejected with an invalid_input envelope, never coerced.
//
// `source: "all"` fans out with completeness-aware ordering — sources whose
// declared filter capability matches the requested filters run first, with
// deterministic registry order as tiebreak — dedupes entities by normalized
// URL (capability-first source keeps attribution; richest donor keeps representation), keeps the sources list in
// registry order, and reports failed/unsupported sources per contract as a
// partial/error envelope. An empty page from a usable backend is a success
// (status `empty`), never a trigger to retry other sources.

import { AGGREGATE_RESEARCH_SOURCE, isResearchSource, RESEARCH_SOURCE_CAPABILITIES, researchSourceCapability } from '../capabilities.js';
import { normalizeUrl } from '../search/fusion.js';
import {
  buildNorthstarResult,
  type NorthstarEntityV1,
  type NorthstarErrorV1,
  type NorthstarRequestV1,
  type NorthstarResultV1,
} from '../result-contract.js';
import {
  isSupportedResearchAction,
  normalizeResearchInput,
  RESEARCH_CANONICAL_ACTION,
  researchRequestV1,
  type NormalizedResearchInput,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';
import { searchArxiv } from './research-arxiv.js';
import { searchCrossref } from './research-crossref.js';
import { searchDatacite } from './research-datacite.js';
import { searchGdelt } from './research-gdelt.js';
import { searchHackerNews } from './research-hackernews.js';
import { searchOpenAlex } from './research-openalex.js';
import { searchPubmed } from './research-pubmed.js';
import { searchRor } from './research-ror.js';
import { searchSemanticScholar } from './research-semantic-scholar.js';
import { searchStackExchange } from './research-stackexchange.js';
import { searchWikidata } from './research-wikidata.js';
import { searchWikipedia } from './research-wikipedia.js';

/** Aggregate fanout is bounded by the shared limit (one request per source). */
const MAX_AGGREGATE_NOTES = 30;

/** Clean-text length used for duplicate representation comparison. */
function researchTextLength(value: string | undefined): number {
  return value?.trim().length ?? 0;
}

/**
 * Field-wise richer merge for one normalized URL. Identity (id/source)
 * stays with the earlier (capability-first) copy; title/snippet take the
 * longer donor per field so a later richer duplicate contributes its
 * evidence instead of being discarded. Ties keep the earlier copy, so
 * dispatch order stays the only tiebreak. Optional metadata backfills only
 * when the merged copy lacks it.
 */
export function chooseRicherResearchEntity(
  current: NorthstarEntityV1,
  candidate: NorthstarEntityV1,
): NorthstarEntityV1 {
  const merged: NorthstarEntityV1 = { ...current };
  if (candidate.title !== undefined && researchTextLength(candidate.title) > researchTextLength(current.title)) {
    merged.title = candidate.title;
  }
  if (candidate.snippet !== undefined && researchTextLength(candidate.snippet) > researchTextLength(current.snippet)) {
    merged.snippet = candidate.snippet;
  }
  if (merged.authors === undefined && candidate.authors !== undefined) merged.authors = candidate.authors;
  if (merged.year === undefined && candidate.year !== undefined) merged.year = candidate.year;
  if (merged.publishedAt === undefined && candidate.publishedAt !== undefined) merged.publishedAt = candidate.publishedAt;
  if (merged.venue === undefined && candidate.venue !== undefined) merged.venue = candidate.venue;
  if (merged.doi === undefined && candidate.doi !== undefined) merged.doi = candidate.doi;
  if (merged.metrics === undefined && candidate.metrics !== undefined) merged.metrics = candidate.metrics;
  return merged;
}

export type { ResearchAdapterContext };

export interface ResearchPageRequest extends ResearchAdapterRequest {
  /** Exact registry source id or "all" (default). */
  source?: string;
}

type ResearchAdapter = (
  request: ResearchAdapterRequest,
  context?: ResearchAdapterContext,
) => Promise<NorthstarResultV1>;

/**
 * Declared per-source structured-filter support, mirroring each adapter's
 * documented wire-level filters. yearTo is absent everywhere: no adapter
 * wires an upper year bound yet, so the seam surfaces it per-source as
 * unsupported instead of letting adapters silently ignore it.
 */
const RESEARCH_FILTER_SUPPORT: Readonly<Record<string, Readonly<{ yearFrom: boolean; author: boolean; doi: boolean; venue: boolean }>>> = {
  semantic_scholar: { yearFrom: true, author: false, doi: false, venue: false },
  openalex: { yearFrom: true, author: true, doi: true, venue: true },
  pubmed: { yearFrom: true, author: true, doi: true, venue: true },
  stackoverflow: { yearFrom: true, author: false, doi: false, venue: false },
  datacite: { yearFrom: true, author: true, doi: true, venue: false },
  ror: { yearFrom: false, author: false, doi: false, venue: false },
  gdelt: { yearFrom: true, author: false, doi: false, venue: false },
  wikipedia: { yearFrom: false, author: false, doi: false, venue: false },
  wikidata: { yearFrom: false, author: false, doi: false, venue: false },
  arxiv: { yearFrom: true, author: false, doi: false, venue: false },
  crossref: { yearFrom: true, author: true, doi: false, venue: false },
  hackernews: { yearFrom: true, author: false, doi: false, venue: false },
};

/** Count of requested structured filters a source cannot serve. */
function unsupportedFilterCount(source: string, input: NormalizedResearchInput): number {
  const support = RESEARCH_FILTER_SUPPORT[source];
  let count = 0;
  if (input.yearFrom !== undefined && support?.yearFrom !== true) count += 1;
  if (input.author !== undefined && support?.author !== true) count += 1;
  if (input.doi !== undefined && support?.doi !== true) count += 1;
  if (input.venue !== undefined && support?.venue !== true) count += 1;
  // yearTo has no wire support in any adapter; never silently dropped.
  if (input.yearTo !== undefined) count += 1;
  return count;
}

/**
 * Completeness-aware fanout order: sources serving more of the requested
 * filters run first; deterministic registry order breaks ties. No semantic
 * substitution ever — ordering only changes who runs (and dedupes) first.
 */
export function orderFanoutSources(input: NormalizedResearchInput): string[] {
  return RESEARCH_SOURCE_CAPABILITIES
    .map((capability, index) => ({
      id: capability.id,
      index,
      unsupported: unsupportedFilterCount(capability.id, input),
    }))
    .sort((a, b) => a.unsupported - b.unsupported || a.index - b.index)
    .map((entry) => entry.id);
}

/** Registry order defines deterministic result ordering for the sources list. */
const ADAPTERS: Readonly<Record<string, ResearchAdapter>> = {
  semantic_scholar: searchSemanticScholar,
  openalex: searchOpenAlex,
  pubmed: searchPubmed,
  stackoverflow: searchStackExchange,
  datacite: searchDatacite,
  ror: searchRor,
  gdelt: searchGdelt,
  wikipedia: searchWikipedia,
  wikidata: searchWikidata,
  arxiv: searchArxiv,
  crossref: searchCrossref,
  hackernews: searchHackerNews,
};

function errorEnvelope(
  req: NorthstarRequestV1,
  source: string,
  backend: string,
  limit: number,
  error: Omit<NorthstarErrorV1, 'source' | 'backend'>,
  supported: boolean,
): NorthstarResultV1 {
  return buildNorthstarResult({
    request: req,
    outcomes: [{ source, backend, error }],
    pagination: { supported, limit, hasMore: false },
  });
}

/**
 * Run one research page. Exact sources dispatch to their native adapter;
 * `source: "all"` fans out over every registry source.
 */
export async function searchResearchPage(
  request: ResearchPageRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = typeof request.source === 'string' && request.source ? request.source : AGGREGATE_RESEARCH_SOURCE;
  const req = researchRequestV1(source, context);

  // Canonical action gate: only `search` (and the legacy `academic` alias
  // the research() route historically sent) dispatch; any other spelling is
  // an explicit invalid_input envelope, never a silent coercion.
  const requestedAction = typeof context.requestedAction === 'string' && context.requestedAction
    ? context.requestedAction
    : undefined;
  if (requestedAction !== undefined && !isSupportedResearchAction(requestedAction)) {
    return errorEnvelope(req, source, 'native-public-apis', 10,
      {
        code: 'invalid_input',
        message: `Unsupported research action "${requestedAction}". Canonical action is "${RESEARCH_CANONICAL_ACTION}".`,
        retryable: false,
      }, false);
  }

  // Input normalization happens once here; adapters re-validate defensively.
  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  if (!normalized.ok) {
    return errorEnvelope(req, source, 'native-public-apis', limit,
      { code: 'invalid_input', message: normalized.message, retryable: false }, false);
  }

  // Unknown source: explicit safe error. No DuckDuckGo/web substitution.
  if (!isResearchSource(source)) {
    return errorEnvelope(req, source, 'native-public-apis', limit,
      {
        code: 'invalid_input',
        message: `Unsupported research source "${source}". Supported sources: ${RESEARCH_SOURCE_CAPABILITIES.map((entry) => entry.id).join(', ')}, all.`,
        retryable: false,
      }, false);
  }

  if (source === AGGREGATE_RESEARCH_SOURCE) {
    return searchAllSources(request, limit, req, normalized.ok ? normalized.input : undefined);
  }
  // yearTo has no adapter wire support yet: reject explicitly here so no
  // adapter can silently ignore it on a pinned-source call.
  if (normalized.ok && normalized.input.yearTo !== undefined) {
    return errorEnvelope(req, source, researchSourceCapability(source)?.backend ?? 'native-public-apis', limit,
      {
        code: 'invalid_input',
        message: `${source} does not support the "yearTo" filter.`,
        retryable: false,
      }, false);
  }
  return ADAPTERS[source]!(request, context);
}

async function searchAllSources(
  request: ResearchPageRequest,
  limit: number,
  req: NorthstarRequestV1,
  input?: NormalizedResearchInput,
): Promise<NorthstarResultV1> {
  // Continuation across the aggregate is not supported by contract.
  if (request.cursor !== undefined) {
    return buildNorthstarResult({
      request: req,
      outcomes: [{
        source: AGGREGATE_RESEARCH_SOURCE,
        backend: 'native-public-apis',
        error: {
          code: 'pagination_not_supported',
          message: 'Continuation cursors require one exact research source, not "all".',
          retryable: false,
        },
      }],
      pagination: { supported: false, limit, hasMore: false },
    });
  }

  if (request.signal?.aborted) throw new Error('aborted');

  // yearTo has no adapter wire support: report it per-source as unsupported
  // without touching the network, instead of silently dropping the filter.
  if (input?.yearTo !== undefined) {
    return buildNorthstarResult({
      request: req,
      outcomes: RESEARCH_SOURCE_CAPABILITIES.map((capability) => ({
        source: capability.id,
        backend: capability.backend,
        entities: [],
        invalid: 0,
        error: {
          code: 'invalid_input' as const,
          message: `${capability.id} does not support the "yearTo" filter.`,
          retryable: false,
        },
      })),
      pagination: { supported: false, limit, hasMore: false },
      notes: [
        'Aggregate source pagination is unsupported; choose one exact source to continue.',
      ],
    });
  }

  // Completeness-aware dispatch: capability-matching sources run first,
  // registry order breaks ties. Outcomes are reassembled in registry order
  // below; dedupe keeps capability-first attribution for shared URLs while
  // the richer donor keeps the representation.
  const dispatchOrder = input ? orderFanoutSources(input) : RESEARCH_SOURCE_CAPABILITIES.map((capability) => capability.id);
  const outcomes = await Promise.allSettled(
    dispatchOrder.map((id) => ADAPTERS[id]!(request, contextOfDefault)),
  );
  const settledBySource = new Map(dispatchOrder.map((id, index) => [id, outcomes[index]!]));

  interface SourceOutcome {
    source: string;
    backend: string;
    entities: NorthstarEntityV1[];
    invalid: number;
    error?: Omit<NorthstarErrorV1, 'source' | 'backend'>;
    retryAfterMs?: number;
    notes: string[];
  }

  const perSource: SourceOutcome[] = RESEARCH_SOURCE_CAPABILITIES.map((capability) => {
    const settled = settledBySource.get(capability.id)!;
    if (settled.status === 'rejected') {
      return {
        source: capability.id,
        backend: capability.backend,
        entities: [],
        invalid: 0,
        error: { code: 'backend_unavailable', message: 'Research adapter failed unexpectedly.', retryable: false },
        notes: [],
      };
    }
    const envelope = settled.value;
    const failure = envelope.errors.find((error) => error.code !== 'invalid_entity');
    const invalidErrors = envelope.errors.filter((error) => error.code === 'invalid_entity');
    const invalid = invalidErrors.reduce((total, error) => {
      const match = /Dropped (\d+)/.exec(error.message);
      return total + (match ? Number(match[1]) : 0);
    }, 0);
    const outcome: SourceOutcome = {
      source: capability.id,
      backend: capability.backend,
      entities: envelope.data.kind === 'entities' ? envelope.data.entities : [],
      invalid,
      notes: envelope.notes,
    };
    if (failure) {
      outcome.error = { code: failure.code, message: failure.message, retryable: failure.retryable };
      const retryAfterMs = envelope.sources[0]?.retryAfterMs;
      if (retryAfterMs !== undefined) outcome.retryAfterMs = retryAfterMs;
    }
    return outcome;
  });

  // Dedupe by normalized URL in capability order: the most filter-capable
  // source keeps attribution for shared entities, but representation merges
  // so a later richer duplicate contributes its evidence instead of being
  // discarded. The sources list itself stays in deterministic registry
  // order. Entities filtered per source so source counts stay honest.
  const byId = new Map(perSource.map((outcome) => [outcome.source, outcome]));
  const keptByUrl = new Map<string, NorthstarEntityV1>();
  const notes: string[] = [
    'Aggregate source pagination is unsupported; choose one exact source to continue.',
  ];
  for (const id of dispatchOrder) {
    const outcome = byId.get(id)!;
    outcome.entities = outcome.entities.filter((entity) => {
      const key = normalizeUrl(entity.url);
      const kept = keptByUrl.get(key);
      if (!kept) {
        keptByUrl.set(key, entity);
        return true;
      }
      keptByUrl.set(key, chooseRicherResearchEntity(kept, entity));
      return false;
    });
  }
  // Merged representations may live in an earlier source's list; refresh
  // every surviving reference so the richer text surfaces everywhere.
  for (const outcome of perSource) {
    outcome.entities = outcome.entities.map((entity) => keptByUrl.get(normalizeUrl(entity.url)) ?? entity);
  }
  // Global limit restore: source:"all" caller's limit is a response budget,
  // not a per-source allowance. Each adapter already ran with `limit`, so the
  // merged set can hold up to N_sources x limit records. Truncate in
  // capability-first dispatch order so the most filter-capable sources win,
  // keeping pagination.limit honest (returned <= limit).
  const totalBeforeCap = perSource.reduce((total, outcome) => total + outcome.entities.length, 0);
  if (totalBeforeCap > limit) {
    let remaining = limit;
    for (const id of dispatchOrder) {
      const outcome = byId.get(id)!;
      if (remaining <= 0) {
        outcome.entities = [];
      } else if (outcome.entities.length > remaining) {
        outcome.entities = outcome.entities.slice(0, remaining);
      }
      remaining -= outcome.entities.length;
    }
    notes.push(
      `Aggregate result capped to global limit ${limit} (${totalBeforeCap - limit} of ${totalBeforeCap} deduplicated entities truncated; capability-first sources retained).`,
    );
  }
  for (const outcome of perSource) {
    for (const note of outcome.notes) {
      if (notes.length >= MAX_AGGREGATE_NOTES) break;
      notes.push(`${outcome.source}: ${note}`);
    }
  }

  return buildNorthstarResult({
    request: req,
    outcomes: perSource.map((outcome) => ({
      source: outcome.source,
      backend: outcome.backend,
      entities: outcome.entities,
      invalid: outcome.invalid,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.retryAfterMs !== undefined ? { retryAfterMs: outcome.retryAfterMs } : {}),
    })),
    pagination: { supported: false, limit, hasMore: false },
    notes,
  });
}

const contextOfDefault: ResearchAdapterContext = {};

export { fetchResearchPaper, resolvePaperIdentity } from './research-paper.js';
export { fetchResearchCitations } from './research-citations.js';
export type { ResearchPaperRequest, ResolvedPaperIdentity } from './research-paper.js';
export type { ResearchCitationsRequest } from './research-citations.js';
