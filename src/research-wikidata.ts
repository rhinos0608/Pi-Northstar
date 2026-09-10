// Native Wikidata adapter (wbsearchentities API).
// Fixed official host: https://www.wikidata.org/w/api.php
// Filter: none — yearFrom/author/doi/venue are rejected explicitly.
// Pagination: continuation via the `continue` parameter (registry mode
// `continuation`); only the numeric offset survives in cursor state.

import { encodeResultCursor, type NorthstarResultV1 } from './result-contract.js';
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

export const WIKIDATA_SOURCE = 'wikidata';
export const WIKIDATA_BACKEND = 'wikidata-api';
export const WIKIDATA_ENDPOINT = 'https://www.wikidata.org/w/api.php';

const MAX_CONTINUE = 50_000;

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

export async function searchWikidata(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = WIKIDATA_SOURCE;
  const backend = WIKIDATA_BACKEND;
  const req = researchRequestV1(source, context);

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  const unsupported = (['yearFrom', 'author', 'doi', 'venue'] as const)
    .find((field) => ({ yearFrom, author, doi, venue })[field] !== undefined);
  if (unsupported !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      `Wikidata entity search does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  let continueFrom = 0;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'continue', 0, MAX_CONTINUE);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    continueFrom = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    action: 'wbsearchentities',
    format: 'json',
    language: 'en',
    limit: String(limit),
    continue: String(continueFrom),
    search: query,
  });

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${WIKIDATA_ENDPOINT}?${params}`, {}, request.signal);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.search)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'Wikidata response missing search array.');
  }
  // Rows without an id/url are NOT silently filtered: parseAdapterRows counts
  // and reports them as invalid_entity, so an all-malformed page is an error
  // rather than a silent empty success.
  const rows = (container.search as unknown[]).map((entry) => {
    const row = researchRecord(entry) ?? {};
    const id = researchString(row.id);
    const conceptUri = researchString(row.concepturi);
    return {
      id,
      title: researchString(row.label) ?? '',
      url: conceptUri ?? (id ? `https://www.wikidata.org/wiki/${id}` : undefined),
      snippet: researchString(row.description),
    };
  });
  const parsed = parseAdapterRows(rows, source, 'article');

  // `searchcontinue` presence signals another page — but only when this page
  // yielded entities; a zero-result page must never advertise continuation
  // (would otherwise mint cursors into an empty-results loop).
  const nextContinue = researchInt(container.searchcontinue);
  const hasMore = parsed.entities.length > 0 && nextContinue !== undefined && nextContinue > continueFrom;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...parsed,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, state: { continue: nextContinue! } }) }
        : {}),
    },
  });
}
