// Native Stack Exchange adapter (API v2.3 excerpt search for the
// `stackoverflow` research source).
// Fixed official host: https://api.stackexchange.com/2.3/search/excerpts
// Filter: fromdate (unix epoch of yearFrom-01-01). Pagination: page/pagesize.
// Auth: optional STACKEXCHANGE_KEY sent as the documented `key` query param
// (not secret-grade per api.stackexchange.com/docs; error paths never echo
// URLs, so the key never leaks).
//
// Unsupported filters (author, DOI, venue) are rejected explicitly — the
// excerpts endpoint does not document them, and we never overstate.
// Anonymous quota caps page at 25 (api.stackexchange.com/docs/paging).

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
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const STACK_EXCHANGE_SOURCE = 'stackoverflow';
export const STACK_EXCHANGE_BACKEND = 'stackexchange-api';
export const STACK_EXCHANGE_ENDPOINT = 'https://api.stackexchange.com/2.3/search/excerpts';
export const STACK_EXCHANGE_SITE = 'stackoverflow';
// Anonymous quota: max page 25 (api.stackexchange.com/docs/paging).
export const STACK_EXCHANGE_MAX_PAGE = 25;

const NAMED_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

// Excerpt fields carry HTML highlight markup; canonical entities carry plain text.
function htmlToText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (entity) => NAMED_ENTITIES[entity] ?? entity)
    .replace(/&#(\d+);/g, (entity, digits: string) => {
      const code = Number(digits);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .trim();
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function questionId(row: Record<string, unknown>): string | undefined {
  const raw = row.question_id;
  if (typeof raw === 'number' && Number.isInteger(raw)) return String(raw);
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return raw;
  return undefined;
}

/** Provider row → canonical candidate for parseEntity; undefined drops the row. */
function mapRow(row: unknown): unknown {
  const record = researchRecord(row);
  if (!record) return undefined;
  const id = questionId(record);
  if (id === undefined) return undefined;
  const publishedAt = isoFromUnixSeconds(record.creation_date);
  return {
    id,
    url: `https://stackoverflow.com/q/${id}`,
    title: htmlToText(record.title) ?? '',
    snippet: htmlToText(record.excerpt),
    publishedAt,
    year: publishedAt !== undefined ? new Date(publishedAt).getUTCFullYear() : undefined,
    score: typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : undefined,
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

export async function searchStackExchange(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = STACK_EXCHANGE_SOURCE;
  const backend = STACK_EXCHANGE_BACKEND;
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
      `Stack Exchange excerpt search does not support the "${unsupported}" filter.`,
      limit,
    );
  }

  let page = 1;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      // Foreign/invalid cursors keep the exact V1 code (invalid_input /
      // pagination_not_supported); a pagination_not_supported error never
      // advertises pagination.supported: true.
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'page', 1, STACK_EXCHANGE_MAX_PAGE);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    page = parsed.value;
  }

  if (request.signal?.aborted) throw request.signal.reason;

  const params = new URLSearchParams({
    site: STACK_EXCHANGE_SITE,
    q: query,
    pagesize: String(limit),
    page: String(page),
  });
  // Documented date filter shape: fromdate as a unix epoch (UTC year start).
  if (yearFrom !== undefined) {
    params.set('fromdate', String(Math.floor(Date.UTC(yearFrom, 0, 1) / 1000)));
  }
  const apiKey = envApiKey(env, 'STACKEXCHANGE_KEY');
  if (apiKey) params.set('key', apiKey);

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${STACK_EXCHANGE_ENDPOINT}?${params}`, {}, request.signal);
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
    return invalidResponseEnvelope(req, source, backend, limit,
      'Stack Exchange response missing items array.');
  }
  const rows = parseAdapterRows(container.items.map(mapRow), source, 'question');
  const hasMore = container.has_more === true && page < STACK_EXCHANGE_MAX_PAGE;
  const notes: string[] = [];
  const backoff = researchInt(container.backoff);
  if (backoff !== undefined && backoff > 0) {
    notes.push(`Stack Exchange requested a ${backoff}s backoff.`);
  }
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
              ...(yearFrom !== undefined ? { yearFrom } : {}),
              state: { page: page + 1 },
            }),
          }
        : {}),
    },
    notes,
  });
}
