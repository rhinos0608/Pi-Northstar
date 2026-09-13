// Native Semantic Scholar adapter (Graph API relevance search).
// Fixed official host: https://api.semanticscholar.org/graph/v1/paper/search
// Filter: year=YYYY- (yearFrom). Pagination: offset.
// Auth: optional SEMANTIC_SCHOLAR_API_KEY sent as the case-sensitive
// `x-api-key` header (never a query param, so URLs stay key-free).
//
// Unsupported filters (author, DOI, venue) are rejected explicitly — the
// relevance endpoint does not document them, and we never overstate.

import { encodeResultCursor, type NorthstarResultV1 } from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorNumber,
  decodeCursorState,
  envApiKey,
  fetchResearchJson,
  httpOutcomeError,
  normalizeResearchInput,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchInt,
  researchRecord,
  researchRequestV1,
  researchString,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const SEMANTIC_SCHOLAR_SOURCE = 'semantic_scholar';
export const SEMANTIC_SCHOLAR_BACKEND = 'semantic-scholar-api';
export const SEMANTIC_SCHOLAR_ENDPOINT = 'https://api.semanticscholar.org/graph/v1/paper/search';

const FIELDS = 'paperId,title,abstract,year,venue,authors,externalIds,citationCount';
const MAX_OFFSET = 9999; // S2 relevance search caps offset+limit at 10,000.

function mapRow(row: Record<string, unknown>): unknown {
  const externalIds = researchRecord(row.externalIds);
  const doi = researchString(externalIds?.DOI);
  const paperId = researchString(row.paperId);
  const url = doi
    ? `https://doi.org/${doi}`
    : researchString(row.url) ?? (paperId ? `https://www.semanticscholar.org/paper/${paperId}` : undefined);
  return {
    id: paperId ?? doi,
    title: typeof row.title === 'string' ? row.title : '',
    url,
    snippet: researchString(row.abstract),
    authors: Array.isArray(row.authors) ? row.authors : undefined,
    year: row.year,
    venue: researchString(row.venue),
    doi,
    citations: typeof row.citationCount === 'number' ? row.citationCount : undefined,
  };
}

function invalidResponseEnvelope(
  request: Parameters<typeof buildAdapterEnvelope>[0]['request'],
  source: string,
  backend: string,
  limit: number,
  message: string,
): NorthstarResultV1 {
  return buildAdapterEnvelope({
    request, source, backend, entities: [], invalid: 0,
    error: { code: 'invalid_backend_response', message, retryable: false },
    pagination: { limit, hasMore: false },
  });
}

export async function searchSemanticScholar(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = SEMANTIC_SCHOLAR_SOURCE;
  const backend = SEMANTIC_SCHOLAR_BACKEND;
  const env = request.env ?? process.env;

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  const unsupported = (['author', 'doi', 'venue'] as const)
    .find((field) => ({ author, doi, venue })[field] !== undefined);
  if (unsupported !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      `Semantic Scholar relevance search does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  let offset = 0;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'offset', 0, MAX_OFFSET);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    offset = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    query,
    offset: String(offset),
    limit: String(limit),
    fields: FIELDS,
  });
  // Documented date filter shape: year=YYYY- (open-ended).
  if (yearFrom !== undefined) params.set('year', `${yearFrom}-`);

  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'SEMANTIC_SCHOLAR_API_KEY');
  if (apiKey) headers['x-api-key'] = apiKey;

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${SEMANTIC_SCHOLAR_ENDPOINT}?${params}`, headers, request.signal);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.data)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'Semantic Scholar response missing data array.');
  }
  const rows = parseAdapterRows(container.data.map(mapRow), source, 'work');
  // `next` is the next offset; its presence means another page exists.
  const next = researchInt(container.next);
  const hasMore = next !== undefined && next > 0;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { offset: next } }) }
        : {}),
    },
  });
}
