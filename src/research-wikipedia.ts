// Native Wikipedia adapter (opensearch API).
// Fixed official host: https://en.wikipedia.org/w/api.php?action=opensearch
// No year filter, no pagination — both are rejected explicitly per registry
// metadata (yearFilter: unsupported, pagination: unsupported).

import { buildNorthstarResult, type NorthstarResultV1 } from './result-contract.js';
import {
  fetchResearchJson,
  httpOutcomeError,
  normalizeResearchInput,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchRequestV1,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const WIKIPEDIA_SOURCE = 'wikipedia';
export const WIKIPEDIA_BACKEND = 'wikipedia-api';
export const WIKIPEDIA_ENDPOINT = 'https://en.wikipedia.org/w/api.php';

export async function searchWikipedia(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = WIKIPEDIA_SOURCE;
  const backend = WIKIPEDIA_BACKEND;
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
      `Wikipedia opensearch does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  // Registry marks Wikipedia pagination unsupported: reject cursors explicitly.
  if (request.cursor !== undefined) {
    return buildNorthstarResult({
      request: req,
      outcomes: [{
        source, backend,
        error: {
          code: 'pagination_not_supported',
          message: 'Wikipedia opensearch does not support continuation cursors.',
          retryable: false,
        },
      }],
      pagination: { supported: false, limit, hasMore: false },
    });
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    action: 'opensearch',
    format: 'json',
    namespace: '0',
    limit: String(limit),
    search: query,
  });

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${WIKIPEDIA_ENDPOINT}?${params}`, {}, request.signal);
  } catch (error) {
    return buildNorthstarResult({
      request: req,
      outcomes: [{
        source, backend,
        error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      }],
      pagination: { supported: false, limit, hasMore: false },
    });
  }

  // Opensearch JSON shape: [query, titles[], descriptions[], urls[]]. All four
  // slots are part of the contract; a malformed slot is a backend error, not a
  // silently degraded page.
  if (!Array.isArray(payload) || payload.length < 4 || !Array.isArray(payload[1]) || !Array.isArray(payload[2]) || !Array.isArray(payload[3])) {
    return malformedEnvelope(req, source, backend, limit);
  }
  const titles = payload[1] as unknown[];
  const urls = payload[3] as unknown[];
  const descriptions = payload[2] as unknown[];
  // Rows with missing/empty URLs are passed through so parseAdapterRows counts
  // and reports them as invalid_entity — malformed-only responses are an
  // error, never a silent empty success.
  const rows = titles.map((title, index) => ({
    id: urls[index],
    title: typeof title === 'string' ? title : '',
    url: typeof urls[index] === 'string' && urls[index] ? urls[index] : undefined,
    snippet: descriptions[index],
  }));
  const parsed = parseAdapterRows(rows, source, 'article');
  return buildNorthstarResult({
    request: req,
    outcomes: [{ source, backend, ...parsed }],
    pagination: { supported: false, limit, hasMore: false },
  });
}

function malformedEnvelope(
  req: Parameters<typeof buildNorthstarResult>[0]['request'],
  source: string,
  backend: string,
  limit: number,
): NorthstarResultV1 {
  return buildNorthstarResult({
    request: req,
    outcomes: [{
      source, backend,
      error: {
        code: 'invalid_backend_response',
        message: 'Wikipedia opensearch response is malformed.',
        retryable: false,
      },
    }],
    pagination: { supported: false, limit, hasMore: false },
  });
}
