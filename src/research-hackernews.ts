// Native Hacker News adapter (Algolia Search API).
// Fixed official host: https://hn.algolia.com/api/v1/search
// Filter: numericFilters=created_at_i>=<epoch> (yearFrom, Jan 1 UTC).
// Pagination: page + nbPages. Auth: none (public API).
//
// Unsupported filters (author, DOI, venue) are rejected explicitly.

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

export const HACKERNEWS_SOURCE = 'hackernews';
export const HACKERNEWS_BACKEND = 'hn-algolia';
export const HACKERNEWS_ENDPOINT = 'https://hn.algolia.com/api/v1/search';

const MAX_PAGE = 100;

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

export async function searchHackerNews(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = HACKERNEWS_SOURCE;
  const backend = HACKERNEWS_BACKEND;
  const req = researchRequestV1(source, context);

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  const unsupported = (['author', 'doi', 'venue'] as const)
    .find((field) => ({ author, doi, venue })[field] !== undefined);
  if (unsupported !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      `Hacker News search does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  let page = 0;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'page', 0, MAX_PAGE);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    page = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    query,
    tags: 'story',
    hitsPerPage: String(limit),
    page: String(page),
  });
  if (yearFrom !== undefined) {
    // Jan 1 UTC of yearFrom, in epoch seconds.
    const epoch = Math.floor(Date.UTC(yearFrom, 0, 1) / 1000);
    params.set('numericFilters', `created_at_i>=${epoch}`);
  }

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${HACKERNEWS_ENDPOINT}?${params}`, {}, request.signal);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.hits)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'Hacker News response missing hits array.');
  }
  // Rows without an id/url are NOT silently filtered: parseAdapterRows counts
  // and reports them as invalid_entity, so an all-malformed page is an error
  // rather than a silent empty success.
  const rows = (container.hits as unknown[]).map((entry) => {
    const hit = researchRecord(entry) ?? {};
    const objectId = researchString(hit.objectID);
    return {
      id: objectId,
      title: researchString(hit.title) ?? researchString(hit.story_title) ?? '',
      url: researchString(hit.url) ?? (objectId ? `https://news.ycombinator.com/item?id=${objectId}` : undefined),
      snippet: researchString(hit.story_text) ?? researchString(hit.comment_text),
      authors: researchString(hit.author) ? [{ name: hit.author }] : undefined,
      publishedAt: researchString(hit.created_at),
      score: researchInt(hit.points),
      comments: researchInt(hit.num_comments),
    };
  });
  const parsed = parseAdapterRows(rows, source, 'article');

  const pageCount = researchInt(container.nbPages);
  // Zero-progress guard: a cursor is only emitted when this page produced at
  // least one valid entity — an all-malformed or empty page must not loop.
  const hasMore = parsed.entities.length > 0 && pageCount !== undefined && page + 1 < pageCount;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...parsed,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { page: page + 1 } }) }
        : {}),
    },
  });
}
