// Native DataCite adapter (REST DOI list search).
// Fixed official host: https://api.datacite.org/dois
// Filters (documented fielded query syntax):
// - yearFrom → publicationYear:[YYYY TO *]
// - author   → creators.name:"<author>"
// - doi      → doi:"<doi>"
// - venue    → unsupported (no venue field in the DataCite query schema);
//              rejected explicitly, never silently dropped.
// Pagination: page[cursor] token paging — first request uses page[cursor]=1,
// continuation tokens are extracted from links.next (only the token is kept;
// continuation URLs are never stored or trusted).
// Auth: none (public Findable DOIs; mailto identification intentionally
// omitted in this stage to avoid PII handling).

import { encodeResultCursor, type NorthstarResultV1 } from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorToken,
  decodeCursorState,
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

export const DATACITE_SOURCE = 'datacite';
export const DATACITE_BACKEND = 'datacite-api';
export const DATACITE_ENDPOINT = 'https://api.datacite.org/dois';

/** DataCite fielded values are quoted; embedded quotes must be stripped. */
function quoteField(value: string): string {
  return value.replace(/"/g, '');
}

function buildQuery(
  query: string,
  filters: { yearFrom?: number; author?: string; doi?: string },
): string {
  const clauses = [query];
  if (filters.yearFrom !== undefined) clauses.push(`publicationYear:[${filters.yearFrom} TO *]`);
  if (filters.author !== undefined) clauses.push(`creators.name:"${quoteField(filters.author)}"`);
  if (filters.doi !== undefined) clauses.push(`doi:"${quoteField(filters.doi)}"`);
  return clauses.join(' AND ');
}

export function mapDataciteRow(row: Record<string, unknown>): unknown {
  const attributes = researchRecord(row.attributes);
  if (!attributes) return {}; // missing attributes → invalid row at the boundary
  const doi = researchString(attributes.doi);
  const titles = Array.isArray(attributes.titles) ? attributes.titles : [];
  const firstTitle = researchRecord(titles[0]);
  const creators = Array.isArray(attributes.creators) ? attributes.creators : [];
  const authors = creators
    .map((creator) => {
      const name = researchString(researchRecord(creator)?.name);
      return name ? { name } : null;
    })
    .filter((entry): entry is { name: string } => entry !== null);
  const descriptions = Array.isArray(attributes.descriptions) ? attributes.descriptions : [];
  const abstractDesc = descriptions.find((d) => researchRecord(d)?.descriptionType === 'Abstract') ?? descriptions[0];
  const abstract = researchString(researchRecord(abstractDesc)?.description);
  return {
    id: doi,
    doi,
    url: doi ? `https://doi.org/${doi}` : researchString(attributes.url),
    title: researchString(firstTitle?.title) ?? '',
    snippet: abstract,
    abstract,
    authors: authors.length > 0 ? authors : undefined,
    year: attributes.publicationYear,
  };
}

const mapRow = mapDataciteRow;

/**
 * Extract only the page[cursor] token from the provider's links.next URL.
 * The URL itself is never stored or trusted; the next request is rebuilt
 * from the fixed endpoint plus this typed token.
 */
function nextCursorToken(links: Record<string, unknown> | undefined): string | undefined {
  const next = researchString(links?.next);
  if (next === undefined) return undefined;
  try {
    return new URL(next).searchParams.get('page[cursor]') ?? undefined;
  } catch {
    return undefined;
  }
}

export async function searchDatacite(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = DATACITE_SOURCE;
  const backend = DATACITE_BACKEND;
  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;
  if (venue !== undefined) {
    return rejectedInputEnvelope(
      req, source, backend,
      'DataCite search does not support the "venue" filter.',
      limit,
    );
  }

  let pageCursor = '1'; // documented start token
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorToken(decoded.state, 'cursor');
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    pageCursor = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    query: buildQuery(query, {
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(author !== undefined ? { author } : {}),
      ...(doi !== undefined ? { doi } : {}),
    }),
    'page[size]': String(limit),
    'page[cursor]': pageCursor,
  });

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${DATACITE_ENDPOINT}?${params}`, {}, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error),
      pagination: { limit, hasMore: false },
    });
  }

  const container = researchRecord(payload);
  if (!container || !Array.isArray(container.data)) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: { code: 'invalid_backend_response', message: 'DataCite response missing data array.', retryable: false },
      pagination: { limit, hasMore: false },
    });
  }

  const rows = parseAdapterRows(container.data.map(mapRow), source, 'work');
  const nextToken = nextCursorToken(researchRecord(container.links));
  const hasMore = nextToken !== undefined;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { cursor: nextToken } }) }
        : {}),
    },
  });
}
