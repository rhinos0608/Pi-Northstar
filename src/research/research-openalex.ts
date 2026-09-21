// Native OpenAlex adapter (works search).
// Fixed official host: https://api.openalex.org/works
// Filters (all documented on help.openalex.org):
// - yearFrom  → from_publication_date:YYYY-01-01
// - doi       → doi:<doi>
// - author    → resolve /authors?search= to an author id, then
//               authorships.author.id:<id> (never filter by author name).
// - venue     → resolve /sources?search= to a source id, then
//               primary_location.source.id:<id>.
// Pagination: cursor (cursor=* first page, meta.next_cursor afterwards).
// Auth: optional OPENALEX_API_KEY sent as `Authorization: Bearer` (kept out
// of the URL so key-bearing URLs never appear in errors or logs).

import { encodeResultCursor, type NorthstarResultV1 } from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorToken,
  decodeCursorState,
  envApiKey,
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

export const OPENALEX_SOURCE = 'openalex';
export const OPENALEX_BACKEND = 'openalex-api';
export const OPENALEX_ENDPOINT = 'https://api.openalex.org/works';

export const OPENALEX_ID_PREFIX = 'https://openalex.org/';

export function shortId(value: string): string {
  return value.startsWith(OPENALEX_ID_PREFIX) ? value.slice(OPENALEX_ID_PREFIX.length) : value;
}

export function reconstructAbstract(invertedIndex: unknown): string | undefined {
  if (!invertedIndex || typeof invertedIndex !== 'object' || Array.isArray(invertedIndex)) return undefined;
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex as Record<string, unknown>)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        if (typeof pos === 'number' && Number.isInteger(pos) && pos >= 0) words.push([pos, word]);
      }
    }
  }
  if (words.length === 0) return undefined;
  words.sort((a, b) => a[0] - b[0]);
  return words.map((w) => w[1]).join(' ');
}

async function resolveOpenAlexId(
  resource: 'authors' | 'sources',
  name: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  lookup?: ResearchAdapterRequest['lookup'],
): Promise<{ found: true; id: string } | { found: false; error?: unknown }> {
  const params = new URLSearchParams({ search: name, per_page: '1' });
  let payload: unknown;
  try {
    payload = await fetchResearchJson(`https://api.openalex.org/${resource}?${params}`, headers, signal, lookup);
  } catch (error) {
    return { found: false, error };
  }
  const container = researchRecord(payload);
  const results = container && Array.isArray(container.results) ? container.results : [];
  const first = researchRecord(results[0]);
  const id = researchString(first?.id);
  return id ? { found: true, id: shortId(id) } : { found: false };
}

export function mapOpenAlexRow(row: Record<string, unknown>): unknown {
  const rawDoi = researchString(row.doi);
  const doi = rawDoi ? rawDoi.replace(/^https?:\/\/doi\.org\//i, '') : undefined;
  const id = researchString(row.id);
  const url = doi ? `https://doi.org/${doi}` : id;
  const authorships = Array.isArray(row.authorships) ? row.authorships : [];
  const authors = authorships
    .map((entry) => {
      const record = researchRecord(entry);
      const author = researchRecord(record?.author);
      const name = researchString(author?.display_name);
      const authorId = researchString(author?.id);
      if (!name) return null;
      return authorId ? { name, id: shortId(authorId) } : { name };
    })
    .filter((entry): entry is { name: string; id?: string } => entry !== null);
  const primaryLocation = researchRecord(row.primary_location);
  const sourceRecord = researchRecord(primaryLocation?.source);
  const abstract = typeof row.abstract === 'string'
    ? row.abstract
    : reconstructAbstract(row.abstract_inverted_index);
  return {
    id: id ?? doi,
    title: researchString(row.display_name) ?? researchString(row.title) ?? '',
    url,
    snippet: abstract,
    ...(abstract !== undefined ? { abstract } : {}),
    authors,
    year: row.publication_year,
    venue: researchString(sourceRecord?.display_name),
    doi,
    citations: typeof row.cited_by_count === 'number' ? row.cited_by_count : undefined,
  };
}

const mapRow = mapOpenAlexRow;

export async function searchOpenAlex(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = OPENALEX_SOURCE;
  const backend = OPENALEX_BACKEND;
  const env = request.env ?? process.env;

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;

  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'OPENALEX_API_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  // Author/venue filters resolve to OpenAlex ids first; name-based filtering
  // is not supported by the API and is never attempted.
  const filters: string[] = [];
  if (yearFrom !== undefined) filters.push(`from_publication_date:${yearFrom}-01-01`);
  if (doi !== undefined) filters.push(`doi:${doi}`);
  for (const [resource, name, filterKey] of [
    ['authors', author, 'authorships.author.id'],
    ['sources', venue, 'primary_location.source.id'],
  ] as const) {
    if (name === undefined) continue;
    const resolved = await resolveOpenAlexId(resource, name, headers, request.signal, request.lookup);
    if ('error' in resolved && resolved.error !== undefined) {
      return buildAdapterEnvelope({
        request: req, source, backend, entities: [], invalid: 0,
        error: httpOutcomeError(resolved.error),
        pagination: { limit, hasMore: false },
      });
    }
    if (!resolved.found) {
      // No such author/source: an honest empty result, not an error.
      return buildAdapterEnvelope({
        request: req, source, backend, entities: [], invalid: 0,
        pagination: { limit, hasMore: false },
        notes: [`OpenAlex "${resource}" search returned no match for the requested ${resource === 'authors' ? 'author' : 'venue'} filter; returning empty result.`],
      });
    }
    filters.push(`${filterKey}:${resolved.id}`);
  }

  let cursorState: string | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorToken(decoded.state, 'cursor');
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    cursorState = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  const params = new URLSearchParams({
    search: query,
    per_page: String(limit),
    cursor: cursorState ?? '*', // OpenAlex cursor paging starts at literal '*'.
  });
  if (filters.length > 0) params.set('filter', filters.join(','));

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${OPENALEX_ENDPOINT}?${params}`, headers, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error),
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
  const rows = parseAdapterRows(container.results.map(mapRow), source, 'work');
  const hasMore = nextCursorRaw !== undefined;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...rows,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { cursor: nextCursorRaw } }) }
        : {}),
    },
  });
}
