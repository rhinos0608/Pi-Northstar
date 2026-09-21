// Native research citations adapter (cited-by list & counts).
// Pinned per-source adapter support for OpenAlex and Semantic Scholar;
// surfaces per-source unsupported explicitly without generic-web substitution.
// Adheres to Slice 2 pagination rules: continuation cursors bound to selector.

import {
  isResearchSource,
  researchSourceCapability,
  RESEARCH_SOURCE_CAPABILITIES,
} from '../capabilities.js';
import type { DnsLookup } from '../network-policy.js';
import {
  buildNorthstarResult,
  encodeResultCursor,
  type NorthstarResultV1,
} from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorNumber,
  cursorToken,
  decodeCursorState,
  envApiKey,
  fetchResearchJson,
  httpOutcomeError,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchInt,
  researchRecord,
  researchRequestV1,
  researchString,
  type ResearchAdapterContext,
} from './research-adapter-shared.js';
import { extractDoi } from './research-paper.js';
import { mapOpenAlexRow, OPENALEX_BACKEND, OPENALEX_ENDPOINT, OPENALEX_SOURCE } from './research-openalex.js';
import {
  FIELDS,
  mapSemanticScholarRow,
  SEMANTIC_SCHOLAR_BACKEND,
  SEMANTIC_SCHOLAR_SOURCE,
} from './research-semantic-scholar.js';

export interface ResearchCitationsRequest {
  id: string;
  source?: string;
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  lookup?: DnsLookup;
}

export const SUPPORTED_CITATIONS_SOURCES = new Set([
  'openalex',
  'semantic_scholar',
]);

const MAX_CITATIONS_LIMIT = 30;
const DEFAULT_CITATIONS_LIMIT = 12;
const MAX_S2_OFFSET = 9999;

export function resolveCitationsSource(id: string): string {
  const trimmed = id.trim();
  if (/^[Ww]\d+$/i.test(trimmed) || /^openalex:/i.test(trimmed) || /openalex\.org/i.test(trimmed)) {
    return 'openalex';
  }
  if (/^[0-9a-f]{40}$/i.test(trimmed) || /^s2:/i.test(trimmed) || /semanticscholar\.org/i.test(trimmed)) {
    return 'semantic_scholar';
  }
  // Default to OpenAlex for DOIs or other IDs
  return 'openalex';
}

async function fetchOpenAlexCitations(
  id: string,
  limit: number,
  cursor: string | undefined,
  request: ResearchCitationsRequest,
  context: ResearchAdapterContext,
): Promise<NorthstarResultV1> {
  const source = OPENALEX_SOURCE;
  const backend = OPENALEX_BACKEND;
  const req = researchRequestV1(source, { ...context, action: 'citations' });
  const env = request.env ?? process.env;

  let cursorState: string | undefined;
  if (cursor !== undefined) {
    const decoded = decodeCursorState(cursor, { source, query: id });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorToken(decoded.state, 'cursor');
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    cursorState = parsed.value;
  }

  let target = id.trim();
  const doi = extractDoi(target);
  if (doi) {
    target = `https://doi.org/${doi}`;
  } else if (/^[Ww]\d+$/i.test(target)) {
    target = target.toUpperCase();
  } else if (/^openalex:([Ww]\d+)$/i.test(target)) {
    target = target.slice('openalex:'.length).toUpperCase();
  }

  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'OPENALEX_API_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const params = new URLSearchParams({
    filter: `cites:${target}`,
    per_page: String(limit),
    cursor: cursorState ?? '*',
  });

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${OPENALEX_ENDPOINT}?${params}`, headers, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.results)) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: { code: 'invalid_backend_response', message: 'OpenAlex response missing results array.', retryable: false },
      pagination: { limit, hasMore: false },
    });
  }

  const meta = researchRecord(container.meta);
  const nextCursorRaw = researchString(meta?.next_cursor);
  const totalCount = researchInt(meta?.count);
  const rows = parseAdapterRows(container.results.map((r) => mapOpenAlexRow(researchRecord(r) ?? {})), source, 'work');
  const hasMore = nextCursorRaw !== undefined;
  const notes: string[] = [];
  if (totalCount !== undefined) {
    notes.push(`Total citations: ${totalCount}`);
  }

  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    notes,
    pagination: {
      limit,
      hasMore,
      supported: true,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query: id, state: { cursor: nextCursorRaw } }) }
        : {}),
    },
  });
}

async function fetchSemanticScholarCitations(
  id: string,
  limit: number,
  cursor: string | undefined,
  request: ResearchCitationsRequest,
  context: ResearchAdapterContext,
): Promise<NorthstarResultV1> {
  const source = SEMANTIC_SCHOLAR_SOURCE;
  const backend = SEMANTIC_SCHOLAR_BACKEND;
  const req = researchRequestV1(source, { ...context, action: 'citations' });
  const env = request.env ?? process.env;

  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursorState(cursor, { source, query: id });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'offset', 0, MAX_S2_OFFSET);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    offset = parsed.value;
  }

  let target = id.trim();
  const doi = extractDoi(target);
  if (doi) {
    target = `DOI:${doi}`;
  } else if (/^s2:/i.test(target)) {
    target = target.slice('s2:'.length);
  }

  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'SEMANTIC_SCHOLAR_API_KEY');
  if (apiKey) headers['x-api-key'] = apiKey;

  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(target)}/citations?offset=${offset}&limit=${limit}&fields=${FIELDS}`;

  let payload: unknown;
  try {
    payload = await fetchResearchJson(url, headers, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.data)) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: { code: 'invalid_backend_response', message: 'Semantic Scholar response missing data array.', retryable: false },
      pagination: { limit, hasMore: false },
    });
  }

  const citingPapers: unknown[] = [];
  for (const item of container.data) {
    const record = researchRecord(item);
    const citing = researchRecord(record?.citingPaper);
    if (citing) {
      citingPapers.push(mapSemanticScholarRow(citing));
    }
  }

  const rows = parseAdapterRows(citingPapers, source, 'work');
  const next = researchInt(container.next);
  const hasMore = next !== undefined && next > 0;
  const notes = [`Citations retrieved: ${rows.entities.length}`];

  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    notes,
    pagination: {
      limit,
      hasMore,
      supported: true,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query: id, state: { offset: next } }) }
        : {}),
    },
  });
}

export async function fetchResearchCitations(
  request: ResearchCitationsRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const rawId = typeof request.id === 'string' ? request.id.trim() : '';
  const req = researchRequestV1(request.source ?? 'research', { ...context, action: 'citations' });

  if (!rawId) {
    return buildNorthstarResult({
      request: req,
      outcomes: [{
        source: 'research',
        backend: 'native-public-apis',
        error: { code: 'invalid_input', message: 'id is required', retryable: false },
      }],
      pagination: { supported: false, limit: 12, hasMore: false },
    });
  }

  // Reject-not-clamp: limit must be an integer 1..30
  let limit = DEFAULT_CITATIONS_LIMIT;
  if (request.limit !== undefined) {
    if (typeof request.limit !== 'number' || !Number.isInteger(request.limit) || request.limit < 1 || request.limit > MAX_CITATIONS_LIMIT) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: 'research',
          backend: 'native-public-apis',
          error: { code: 'invalid_input', message: `limit must be an integer 1..${MAX_CITATIONS_LIMIT}`, retryable: false },
        }],
        pagination: { supported: false, limit: DEFAULT_CITATIONS_LIMIT, hasMore: false },
      });
    }
    limit = request.limit;
  }

  if (request.source !== undefined) {
    const specified = request.source.trim();
    if (specified === 'all') {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: 'all',
          backend: 'native-public-apis',
          error: { code: 'invalid_input', message: 'citations action requires one exact research source, not "all".', retryable: false },
        }],
        pagination: { supported: false, limit, hasMore: false },
      });
    }
    if (!isResearchSource(specified)) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: specified,
          backend: 'native-public-apis',
          error: {
            code: 'invalid_input',
            message: `Unsupported research source "${specified}". Supported sources: ${RESEARCH_SOURCE_CAPABILITIES.map((s) => s.id).join(', ')}.`,
            retryable: false,
          },
        }],
        pagination: { supported: false, limit, hasMore: false },
      });
    }
    if (!SUPPORTED_CITATIONS_SOURCES.has(specified)) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: specified,
          backend: researchSourceCapability(specified)?.backend ?? 'native-public-apis',
          error: {
            code: 'unsupported_action',
            message: `${specified} does not support the "citations" action. Supported sources: ${[...SUPPORTED_CITATIONS_SOURCES].join(', ')}.`,
            retryable: false,
          },
        }],
        pagination: { supported: false, limit, hasMore: false },
      });
    }
  }

  const resolvedSource = request.source !== undefined
    ? request.source.trim()
    : resolveCitationsSource(rawId);

  if (request.signal?.aborted) throw new Error('aborted');

  if (resolvedSource === 'openalex') {
    return fetchOpenAlexCitations(rawId, limit, request.cursor, request, context);
  }
  if (resolvedSource === 'semantic_scholar') {
    return fetchSemanticScholarCitations(rawId, limit, request.cursor, request, context);
  }

  return buildNorthstarResult({
    request: req,
    outcomes: [{
      source: resolvedSource,
      backend: researchSourceCapability(resolvedSource)?.backend ?? 'native-public-apis',
      error: {
        code: 'unsupported_action',
        message: `${resolvedSource} does not support the "citations" action. Supported sources: ${[...SUPPORTED_CITATIONS_SOURCES].join(', ')}.`,
        retryable: false,
      },
    }],
    pagination: { supported: false, limit, hasMore: false },
  });
}
