// Native ROR adapter (REST API v2 organization search for the `ror` source).
// Fixed official host: https://api.ror.org/v2/organizations
// Filters: none documented for dates/author/DOI/venue — `yearFrom` and the
// shared author/doi/venue fields are rejected explicitly, never dropped.
// Pagination: fixed 20-item pages (page 1-500), so the cursor carries
// {page, offset} and a resumed call may re-fetch the same page and slice
// locally (ror.readme.io/docs/api-paging).
//
// ROR requires no auth (client-ID registration is paused upstream; the IP
// rate split applies). Malformed upstream 200 payloads are errors, not empty
// success; malformed rows are dropped and reported as invalid_entity.

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

export const ROR_SOURCE = 'ror';
export const ROR_BACKEND = 'ror-api';
export const ROR_ENDPOINT = 'https://api.ror.org/v2/organizations';
// Fixed page size and page cap (ror.readme.io/docs/api-paging).
export const ROR_PAGE_SIZE = 20;
export const ROR_MAX_PAGE = 500;

/** ROR v2 names[] entries: prefer ror_display, then label, then any string value. */
function primaryName(names: readonly unknown[]): string | undefined {
  const entries = names
    .map((entry) => researchRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== undefined);
  const preferred =
    entries.find((entry) => Array.isArray(entry.types) && entry.types.includes('ror_display')) ??
    entries.find((entry) => Array.isArray(entry.types) && entry.types.includes('label')) ??
    entries.find((entry) => researchString(entry.value) !== undefined);
  return researchString(preferred?.value);
}

function firstLink(links: readonly unknown[]): string | undefined {
  const link = links.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  return typeof link === 'string' ? link : undefined;
}

function countryName(locations: readonly unknown[]): string | undefined {
  const location = locations
    .map((entry) => researchRecord(entry))
    .find((entry) => entry !== undefined);
  const details = researchRecord(location?.geonames_details);
  return researchString(details?.country_name);
}

/** Provider row → canonical candidate for parseEntity; undefined drops the row. */
function mapRow(row: unknown): unknown {
  const record = researchRecord(row);
  if (!record) return undefined;
  const id = researchString(record.id);
  if (id === undefined) return undefined;
  return {
    id,
    url: firstLink(Array.isArray(record.links) ? record.links : []) ?? id,
    title: primaryName(Array.isArray(record.names) ? record.names : []) ?? '',
    year: researchInt(record.established),
    snippet: countryName(Array.isArray(record.locations) ? record.locations : []),
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

export async function searchRor(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = ROR_SOURCE;
  const backend = ROR_BACKEND;

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  if (yearFrom !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      'ROR does not support date filtering; omit yearFrom.',
      limit,
    );
  }
  const unsupported = (['author', 'doi', 'venue'] as const)
    .find((field) => ({ author, doi, venue })[field] !== undefined);
  if (unsupported !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      `ROR does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  let page = 1;
  let offset = 0;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query });
    if (!decoded.ok) {
      // Foreign/invalid cursors keep the exact V1 code (invalid_input /
      // pagination_not_supported); a pagination_not_supported error never
      // advertises pagination.supported: true.
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsedPage = cursorNumber(decoded.state, 'page', 1, ROR_MAX_PAGE);
    if (!parsedPage.ok) return rejectedInputEnvelope(req, source, backend, parsedPage.message, limit);
    const parsedOffset = cursorNumber(decoded.state, 'offset', 0, ROR_PAGE_SIZE - 1);
    if (!parsedOffset.ok) return rejectedInputEnvelope(req, source, backend, parsedOffset.message, limit);
    page = parsedPage.value;
    offset = parsedOffset.value;
  }

  if (request.signal?.aborted) throw request.signal.reason;

  const params = new URLSearchParams({ query, page: String(page) });

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${ROR_ENDPOINT}?${params}`, {}, request.signal);
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason;
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.items)) {
    return invalidResponseEnvelope(req, source, backend, limit, 'ROR response missing items array.');
  }
  // REST v2 exposes number_of_results; some paging docs show the
  // metadata.number_of_results spelling — accept either.
  const metadata = researchRecord(container.metadata);
  const total = researchInt(container.number_of_results) ?? researchInt(metadata?.number_of_results);
  if (total === undefined) {
    return invalidResponseEnvelope(req, source, backend, limit, 'ROR response missing number_of_results.');
  }

  const slice = container.items.slice(offset, offset + limit);
  const rows = parseAdapterRows(slice.map(mapRow), source, 'organization');
  const positionAfter = (page - 1) * ROR_PAGE_SIZE + offset + rows.entities.length;
  const hasMore = positionAfter < total && page < ROR_MAX_PAGE;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: encodeResultCursor({
              source,
              query,
              state: { page: Math.floor(positionAfter / ROR_PAGE_SIZE) + 1, offset: positionAfter % ROR_PAGE_SIZE },
            }),
          }
        : {}),
    },
  });
}
