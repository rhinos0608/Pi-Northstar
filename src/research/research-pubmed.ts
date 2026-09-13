// Native PubMed adapter (NCBI E-utilities, esearch + esummary).
// Fixed official host: https://eutils.ncbi.nlm.nih.gov/entrez/eutils/
// Flow: esearch.fcgi (idlist, retstart/retmax) → esummary.fcgi (DocSums).
// Filters (documented field tags, NBK25499):
// - yearFrom → mindate=YYYY&maxdate=3000&datetype=pdat
// - author   → <author>[Author]
// - doi      → <doi>[doi]
// - venue    → <venue>[Journal]
// Pagination: retstart offset.
// Auth (Pi conventions, not vendor names): NCBI_API_KEY → api_key param,
// NCBI_EMAIL → email param; `tool` is always sent per NCBI policy.
// NCBI's api_key travels in the query string, so error messages are built
// from sanitized statuses only — key-bearing URLs never surface.

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
  researchString,
  type ResearchAdapterContext,
  type ResearchAdapterRequest,
} from './research-adapter-shared.js';

export const PUBMED_SOURCE = 'pubmed';
export const PUBMED_BACKEND = 'pubmed-eutils';
export const PUBMED_EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const MAX_RETSTART = 9999; // PubMed/PMC serve only the first 10,000 records.

const TOOL_NAME = 'pi-northstar';

function authParams(env: Record<string, string | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  const apiKey = envApiKey(env, 'NCBI_API_KEY');
  if (apiKey) params.set('api_key', apiKey);
  const email = envApiKey(env, 'NCBI_EMAIL');
  if (email) params.set('email', email);
  params.set('tool', TOOL_NAME);
  return params;
}

function buildTerm(
  query: string,
  filters: { author?: string; doi?: string; venue?: string },
): string {
  const clauses = [query];
  if (filters.author !== undefined) clauses.push(`${filters.author}[Author]`);
  if (filters.doi !== undefined) clauses.push(`${filters.doi}[doi]`);
  if (filters.venue !== undefined) clauses.push(`${filters.venue}[Journal]`);
  return clauses.join(' AND ');
}

function doiFromArticleIds(articleIds: readonly unknown[]): string | undefined {
  for (const entry of articleIds) {
    const record = researchRecord(entry);
    if (record?.idtype === 'doi') {
      const value = researchString(record.value);
      if (value) return value;
    }
  }
  return undefined;
}

function mapDocSum(uid: string, doc: Record<string, unknown>): unknown {
  const articleIds = Array.isArray(doc.articleids) ? doc.articleids : [];
  const pubdate = researchString(doc.pubdate);
  const yearMatch = pubdate !== undefined ? /^(\d{4})/.exec(pubdate) : undefined;
  return {
    id: uid,
    url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
    title: typeof doc.title === 'string' ? doc.title : '',
    authors: Array.isArray(doc.authors) ? doc.authors : undefined,
    venue: researchString(doc.source),
    year: yearMatch ? Number(yearMatch[1]) : undefined,
    publishedAt: pubdate,
    doi: doiFromArticleIds(articleIds),
  };
}

function httpErrorEnvelope(
  request: Parameters<typeof buildAdapterEnvelope>[0]['request'],
  source: string,
  backend: string,
  limit: number,
  error: unknown,
): NorthstarResultV1 {
  return buildAdapterEnvelope({
    request, source, backend, entities: [], invalid: 0,
    error: httpOutcomeError(error),
    pagination: { limit, hasMore: false },
  });
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

export async function searchPubmed(
  request: ResearchAdapterRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const source = PUBMED_SOURCE;
  const backend = PUBMED_BACKEND;
  const env = request.env ?? process.env;

  const normalized = normalizeResearchInput(request);
  const limit = normalized.ok ? normalized.input.limit : 10;
  const req = researchRequestV1(source, context);
  if (!normalized.ok) {
    return rejectedInputEnvelope(req, source, backend, normalized.message, limit);
  }
  const { query, yearFrom, author, doi, venue } = normalized.input;

  let retstart = 0;
  if (request.cursor !== undefined) {
    const decoded = decodeCursorState(request.cursor, { source, query, ...(yearFrom !== undefined ? { yearFrom } : {}) });
    if (!decoded.ok) {
      return cursorErrorEnvelope(req, source, backend, limit, decoded.error);
    }
    const parsed = cursorNumber(decoded.state, 'retstart', 0, MAX_RETSTART);
    if (!parsed.ok) return rejectedInputEnvelope(req, source, backend, parsed.message, limit);
    retstart = parsed.value;
  }

  if (request.signal?.aborted) throw new Error('aborted');

  // ── Step 1: esearch → idlist ──
  const esearchParams = authParams(env);
  esearchParams.set('db', 'pubmed');
  esearchParams.set('term', buildTerm(query, {
    ...(author !== undefined ? { author } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(venue !== undefined ? { venue } : {}),
  }));
  esearchParams.set('retmode', 'json');
  esearchParams.set('retstart', String(retstart));
  esearchParams.set('retmax', String(limit));
  if (yearFrom !== undefined) {
    esearchParams.set('mindate', String(yearFrom));
    esearchParams.set('maxdate', '3000');
    esearchParams.set('datetype', 'pdat');
  }

  let esearch: unknown;
  try {
    esearch = await fetchResearchJson(`${PUBMED_EUTILS_BASE}/esearch.fcgi?${esearchParams}`, {}, request.signal);
  } catch (error) {
    return httpErrorEnvelope(req, source, backend, limit, error);
  }

  const esearchResult = researchRecord(researchRecord(esearch)?.esearchresult);
  if (!esearchResult || !Array.isArray(esearchResult.idlist)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'PubMed esearch response missing esearchresult.idlist array.');
  }
  if (researchString(esearchResult.error) !== undefined) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      error: { code: 'rate_limited', message: 'PubMed rate limit exceeded.', retryable: true },
      pagination: { limit, hasMore: false },
    });
  }

  // E-utilities returns count as a string ("25") in JSON mode.
  const rawCount = esearchResult.count;
  const total = researchInt(rawCount)
    ?? (typeof rawCount === 'string' && /^\d+$/.test(rawCount) ? Number(rawCount) : 0);

  const hasMore = retstart + esearchResult.idlist.length < total;
  if (esearchResult.idlist.length === 0) {
    return buildAdapterEnvelope({
      request: req, source, backend, entities: [], invalid: 0,
      pagination: { limit, hasMore: false },
    });
  }

  // ── Step 2: esummary → DocSums ──
  const esummaryParams = authParams(env);
  esummaryParams.set('db', 'pubmed');
  esummaryParams.set('retmode', 'json');
  esummaryParams.set('id', esearchResult.idlist.map(String).join(','));

  let esummary: unknown;
  try {
    esummary = await fetchResearchJson(`${PUBMED_EUTILS_BASE}/esummary.fcgi?${esummaryParams}`, {}, request.signal);
  } catch (error) {
    return httpErrorEnvelope(req, source, backend, limit, error);
  }

  const summaryResult = researchRecord(researchRecord(esummary)?.result);
  if (!summaryResult || !Array.isArray(summaryResult.uids)) {
    return invalidResponseEnvelope(req, source, backend, limit,
      'PubMed esummary response missing result.uids array.');
  }

  const docRows: unknown[] = [];
  let invalid = 0;
  for (const uid of summaryResult.uids) {
    const key = String(uid);
    const doc = researchRecord(summaryResult[key]);
    if (!doc) {
      invalid += 1;
      continue;
    }
    docRows.push(mapDocSum(key, doc));
  }
  const rows = parseAdapterRows(docRows, source, 'work');

  return buildAdapterEnvelope({
    request: req,
    source,
    backend,
    entities: rows.entities,
    invalid: invalid + rows.invalid,
    pagination: {
      limit,
      hasMore,
      ...(hasMore
        ? { nextCursor: encodeResultCursor({ source, query, ...(yearFrom !== undefined ? { yearFrom } : {}), state: { retstart: retstart + esearchResult.idlist.length } }) }
        : {}),
    },
  });
}
