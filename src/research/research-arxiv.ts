// Native arXiv adapter (Atom API).
// Fixed official host: https://export.arxiv.org/api/query
// Filter: submittedDate range in the query (yearFrom).
// Pagination: start offset; total comes from opensearch:totalResults.
//
// Unsupported filters (author, DOI, venue) are rejected explicitly.

import { encodeResultCursor, type NorthstarResultV1 } from '../result-contract.js';
import {
  buildAdapterEnvelope,
  cursorErrorEnvelope,
  cursorNumber,
  decodeCursorState,
  fetchResearchText,
  httpOutcomeError,
  normalizeResearchInput,
  parseAdapterRows,
  rejectedInputEnvelope,
  researchInt,
  researchRequestV1,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const ARXIV_SOURCE = 'arxiv';
export const ARXIV_BACKEND = 'arxiv-api';
export const ARXIV_ENDPOINT = 'https://export.arxiv.org/api/query';

const MAX_OFFSET = 99_000; // arXiv API caps start+max_results at 100_000.

function cleanXml(text: string | undefined): string {
  return (text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ArxivEntry {
  title: string;
  id: string;
  summary: string;
  authors: string[];
  published: string | undefined;
}

function parseEntries(xml: string): { entries: ArxivEntry[]; total: number | undefined; dropped: number } {
  const entries: ArxivEntry[] = [];
  let dropped = 0;
  const totalRaw = /opensearch:totalResults[^>]*>(\d+)</.exec(xml)?.[1];
  const total = totalRaw !== undefined ? Number(totalRaw) : undefined;
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const block = match[1] ?? '';
    const title = cleanXml(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1]);
    const id = cleanXml(/<id>([\s\S]*?)<\/id>/.exec(block)?.[1]);
    const summary = cleanXml(/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1]);
    const authors = [...block.matchAll(/<name>([\s\S]*?)<\/name>/g)]
      .map((entry) => cleanXml(entry[1]))
      .filter(Boolean);
    const published = cleanXml(/<published>([\s\S]*?)<\/published>/.exec(block)?.[1]) || undefined;
    if (id) entries.push({ title, id, summary, authors, published });
    else dropped += 1;
  }
  return { entries, total: researchInt(total), dropped };
}

export async function searchArxiv(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = ARXIV_SOURCE;
  const backend = ARXIV_BACKEND;
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
      `arXiv API search does not support the "${unsupported}" filter.`,
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

  // Documented date filter shape: submittedDate:[YYYYMMDDHHMM TO ...].
  let searchQuery = `all:${query}`;
  if (yearFrom !== undefined) {
    searchQuery = `${searchQuery} AND submittedDate:[${yearFrom}01010000 TO 999912312359]`;
  }
  const params = new URLSearchParams({
    search_query: searchQuery,
    start: String(offset),
    max_results: String(limit),
  });

  let xml: string;
  try {
    xml = await fetchResearchText(`${ARXIV_ENDPOINT}?${params}`, {}, request.signal, request.lookup);
  } catch (error) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: httpOutcomeError(error as Error & { status?: number; kind?: string }),
      pagination: { limit, hasMore: false },
    });
  }

  // Atom feed must contain the totalResults element; a non-feed 200 body is
  // invalid_backend_response, never empty success.
  const { entries, total, dropped } = parseEntries(xml);
  if (!/<feed[\s>]/.test(xml) || total === undefined) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: { code: 'invalid_backend_response', message: 'arXiv response is not a valid Atom feed.', retryable: false },
      pagination: { limit, hasMore: false },
    });
  }
  const rows = entries.map((entry) => ({
    id: entry.id,
    title: entry.title,
    url: entry.id,
    snippet: entry.summary,
    // D5 provenance: the Atom <summary> element IS the paper abstract —
    // carry it as the genuine upstream abstract the same way
    // research-semantic-scholar/research-crossref do (set ONLY when the
    // feed entry actually had one; parseAdapterRows preserves it on the
    // entity and abstract-less rows stay candidate-only downstream).
    abstract: entry.summary === '' ? undefined : entry.summary,
    authors: entry.authors.map((name) => ({ name })),
    year: entry.published ? Number(entry.published.slice(0, 4)) : undefined,
    publishedAt: entry.published,
  }));
  const parsed = parseAdapterRows(rows, source, 'work');
  // Malformed Atom entries (no id) count toward invalid_entity so an
  // all-malformed page is an error, not a silent empty success.
  if (dropped > 0) parsed.invalid += dropped;
  // Zero-progress guard: a cursor is only emitted when this page actually
  // advanced the offset; a page with no entries must not loop forever.
  const hasMore = entries.length > 0 && offset + entries.length < total;
  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    ...parsed,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { offset: offset + entries.length } }) }
        : {}),
    },
  });
}
