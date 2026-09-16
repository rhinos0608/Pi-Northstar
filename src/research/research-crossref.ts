// Native Crossref adapter (REST /works search).
// Fixed official host: https://api.crossref.org/works
// Filter: filter=from-pub-date:YYYY-MM-DD (yearFrom); author via query.author.
// Pagination: offset (rows/offset). Crossref requires its cursor API for deep
// paging; we cap offset paging honestly instead of storing provider URLs.
//
// Unsupported filters (DOI, venue) are rejected explicitly.

import { encodeResultCursor, type NorthstarResultV1 } from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorNumber,
  decodeCursorState,
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

export const CROSSREF_SOURCE = 'crossref';
export const CROSSREF_BACKEND = 'crossref-api';
export const CROSSREF_ENDPOINT = 'https://api.crossref.org/works';

const MAX_OFFSET = 9999;

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === 'string' ? value[0] : undefined;
}

function mapRow(row: Record<string, unknown>): unknown {
  const doi = researchString(row.DOI);
  // Prefer the provider URL so cross-source dedupe by normalized URL works;
  // DOI-only rows fall back to the canonical doi.org link.
  const url = researchString(row.URL) ?? (doi ? `https://doi.org/${doi}` : undefined);
  const authors = Array.isArray(row.author)
    ? row.author.flatMap((entry) => {
      const author = researchRecord(entry);
      const name = [author?.given, author?.family]
        .filter((part): part is string => typeof part === 'string')
        .join(' ')
        .trim();
      return name ? [{ name }] : [];
    })
    : undefined;
  const issued = researchRecord(row.issued);
  const dateParts = Array.isArray(issued?.['date-parts']) ? (issued['date-parts'] as unknown[]) : undefined;
  const year = researchInt(Array.isArray(dateParts?.[0]) ? (dateParts[0] as unknown[])[0] : undefined);
  return {
    id: doi ?? researchString(row.URL),
    title: firstString(row.title) ?? '',
    url,
    snippet: researchString(row.abstract),
    // D5 provenance: carry the genuine upstream abstract alongside the
    // display snippet (set ONLY when the provider row actually had one).
    abstract: researchString(row.abstract),
    authors: authors && authors.length > 0 ? authors : undefined,
    year,
    venue: firstString(row['container-title']),
    doi,
    citations: researchInt(row['is-referenced-by-count']),
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

export async function searchCrossref(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = CROSSREF_SOURCE;
  const backend = CROSSREF_BACKEND;

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  const unsupported = (['doi', 'venue'] as const).find((field) => ({ doi, venue })[field] !== undefined);
  if (unsupported !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      `Crossref works search does not support the "${unsupported}" filter.`,
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
    rows: String(limit),
    offset: String(offset),
    select: 'DOI,URL,title,author,issued,container-title,is-referenced-by-count,abstract',
  });
  if (yearFrom !== undefined) {
    params.set('filter', `from-pub-date:${yearFrom}-01-01`);
  }
  if (author !== undefined) params.set('query.author', author);

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${CROSSREF_ENDPOINT}?${params}`, {}, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  const message_ = researchRecord(container?.message);
  if (!message_ || !Array.isArray(message_.items)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'Crossref response missing message.items array.');
  }
  const rows = parseAdapterRows((message_.items as unknown[]).map((row) => mapRow(researchRecord(row) ?? {})), source, 'work');
  const hasMore = rows.entities.length === limit && offset + limit <= MAX_OFFSET;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { offset: offset + limit } }) }
        : {}),
    },
  });
}
