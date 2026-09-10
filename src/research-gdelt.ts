// Native GDELT adapter (DOC 2.0 API article search for the `gdelt` source).
// Fixed official host: https://api.gdeltproject.org/api/v2/doc/doc
// Filter: STARTDATETIME (YYYYMMDDHHMMSS) bounded from yearFrom.
// Pagination: none — GDELT artlist has no continuation, so a cursor is
// rejected with pagination_not_supported (never ignored) and the envelope
// reports pagination.supported: false.
//
// Unsupported filters (author, DOI, venue) are rejected explicitly. GDELT
// frequently returns non-JSON or schema-less HTTP-200 payloads; those are
// errors, not empty success. Malformed rows are dropped and reported as
// invalid_entity.

import {
  buildNorthstarResult,
  type NorthstarErrorV1,
  type NorthstarResultV1,
} from './result-contract.js';
import {
  fetchResearchJson,
  httpOutcomeError,
  normalizeResearchInput,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchRecord,
  researchRequestV1,
  researchString,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const GDELT_SOURCE = 'gdelt';
export const GDELT_BACKEND = 'gdelt-api';
export const GDELT_ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

// seendate format: 20250102T120000Z.
function seenDateToIso(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Provider row → canonical candidate for parseEntity; undefined drops the row. */
function mapRow(row: unknown): unknown {
  const record = researchRecord(row);
  if (!record) return undefined;
  const url = researchString(record.url);
  if (url === undefined) return undefined;
  const publishedAt = seenDateToIso(record.seendate);
  return {
    id: url,
    url,
    title: typeof record.title === 'string' ? record.title : '',
    publishedAt,
    year: publishedAt !== undefined ? new Date(publishedAt).getUTCFullYear() : undefined,
    venue: researchString(record.domain),
  };
}

// buildAdapterEnvelope forces pagination.supported: true; GDELT has no
// continuation, so its envelopes are assembled directly with supported: false.
function gdeltEnvelope(
  request: Parameters<typeof buildNorthstarResult>[0]['request'],
  outcome: {
    entities?: ReturnType<typeof parseAdapterRows>['entities'];
    invalid?: number;
    error?: Omit<NorthstarErrorV1, 'source' | 'backend'>;
  },
  limit: number,
): NorthstarResultV1 {
  return buildNorthstarResult({
    request,
    outcomes: [{
      source: GDELT_SOURCE,
      backend: GDELT_BACKEND,
      entities: outcome.entities ?? [],
      invalid: outcome.invalid ?? 0,
      ...(outcome.error ? { error: outcome.error } : {}),
    }],
    pagination: { supported: false, limit, hasMore: false },
  });
}

export async function searchGdelt(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = GDELT_SOURCE;
  const backend = GDELT_BACKEND;

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
      `GDELT does not support the "${unsupported}" filter; use documented query operators instead.`,
      limit,
    );
  }
  if (request.cursor !== undefined) {
    return gdeltEnvelope(req, {
      error: {
        code: 'pagination_not_supported',
        message: 'GDELT does not support pagination; repeat the query without a cursor.',
        retryable: false,
      },
    }, limit);
  }

  if (request.signal?.aborted) throw request.signal.reason;

  const params = new URLSearchParams({
    query,
    mode: 'artlist',
    format: 'json',
    maxrecords: String(limit),
  });
  // Bounded window: STARTDATETIME at yearFrom-01-01T00:00:00Z.
  if (yearFrom !== undefined) {
    params.set('startdatetime', `${yearFrom}0101000000`);
  }

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${GDELT_ENDPOINT}?${params}`, {}, request.signal);
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason;
    return gdeltEnvelope(req, { error: httpOutcomeError(error as Error & { status?: number; kind?: string }) }, limit);
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.articles)) {
    return gdeltEnvelope(req, {
      error: { code: 'invalid_backend_response', message: 'GDELT response missing articles array.', retryable: false },
    }, limit);
  }
  const rows = parseAdapterRows(container.articles.map(mapRow), source, 'article');
  return gdeltEnvelope(req, { entities: rows.entities, invalid: rows.invalid }, limit);
}
