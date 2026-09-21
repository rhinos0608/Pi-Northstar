// Native research paper adapter (full metadata retrieval by ID or URL).
// Resolves candidate/follow-up identity (DOI, OpenAlex, Semantic Scholar,
// arXiv, PubMed, Crossref, DataCite) and fetches full metadata through the
// pinned per-source adapter with no generic-web substitution.

import {
  isResearchSource,
  researchSourceCapability,
  RESEARCH_SOURCE_CAPABILITIES,
} from '../capabilities.js';
import type { DnsLookup } from '../network-policy.js';
import {
  buildNorthstarResult,
  type NorthstarEntityV1,
  type NorthstarErrorV1,
  type NorthstarResultV1,
} from '../result-contract.js';
import {
  envApiKey,
  fetchResearchJson,
  fetchResearchText,
  httpOutcomeError,
  parseAdapterRows,
  ResearchHttpError,
  researchRecord,
  researchRequestV1,
  type ResearchAdapterContext,
} from './research-adapter-shared.js';
import { parseEntries } from './research-arxiv.js';
import { mapCrossrefRow } from './research-crossref.js';
import { mapDataciteRow } from './research-datacite.js';
import { mapOpenAlexRow } from './research-openalex.js';
import { authParams, mapDocSum, PUBMED_EUTILS_BASE } from './research-pubmed.js';
import { FIELDS, mapSemanticScholarRow } from './research-semantic-scholar.js';

export interface ResearchPaperRequest {
  idOrUrl: string;
  source?: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  lookup?: DnsLookup;
}

export interface ResolvedPaperIdentity {
  source: string;
  id: string;
}

export const SUPPORTED_PAPER_SOURCES = new Set([
  'openalex',
  'semantic_scholar',
  'arxiv',
  'pubmed',
  'crossref',
  'datacite',
]);

export function extractDoi(raw: string): string | undefined {
  const trimmed = raw.trim();
  const urlMatch = /^(?:https?:\/\/(?:dx\.)?doi\.org\/)(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)$/i.exec(trimmed);
  if (urlMatch) return urlMatch[1];
  const doiPrefixMatch = /^doi:\s*(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)$/i.exec(trimmed);
  if (doiPrefixMatch) return doiPrefixMatch[1];
  const bareMatch = /^(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)$/i.exec(trimmed);
  if (bareMatch) return bareMatch[1];
  return undefined;
}

export function resolvePaperIdentity(
  raw: string,
): { ok: true; identity: ResolvedPaperIdentity } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: 'ID or URL is required' };

  // 1. Exact DOI check
  const doi = extractDoi(trimmed);
  if (doi) return { ok: true, identity: { source: 'openalex', id: doi } };

  // 2. URL parsing
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { ok: false, message: `Invalid URL "${trimmed}".` };
    }
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname;

    if (host === 'openalex.org' || host === 'www.openalex.org' || host === 'api.openalex.org') {
      const match = /\/(?:works\/)?([Ww]\d+)/.exec(pathname);
      if (match) return { ok: true, identity: { source: 'openalex', id: match[1]!.toUpperCase() } };
      const doiInPath = /\/(?:works\/)?(10\.\d{4,9}\/[^\s]+)/.exec(pathname);
      if (doiInPath) return { ok: true, identity: { source: 'openalex', id: doiInPath[1]! } };
      return { ok: false, message: `Could not extract OpenAlex work ID from URL "${trimmed}".` };
    }

    if (host === 'semanticscholar.org' || host === 'www.semanticscholar.org' || host === 'api.semanticscholar.org') {
      const match = /\/paper\/(?:[^/]+\/)?([0-9a-f]{40})/i.exec(pathname);
      if (match) return { ok: true, identity: { source: 'semantic_scholar', id: match[1]!.toLowerCase() } };
      const doiMatch = /\/paper\/(?:[^/]+\/)?(10\.\d{4,9}\/[^\s]+)/i.exec(pathname);
      if (doiMatch) return { ok: true, identity: { source: 'semantic_scholar', id: `DOI:${doiMatch[1]!}` } };
      return { ok: false, message: `Could not extract Semantic Scholar paper ID from URL "${trimmed}".` };
    }

    if (host === 'arxiv.org' || host === 'www.arxiv.org' || host === 'export.arxiv.org') {
      const match = /\/(?:abs|pdf)\/([a-z\-]+(?:\.[a-z\-]+)?\/\d+|\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(pathname);
      if (match) return { ok: true, identity: { source: 'arxiv', id: match[1]! } };
      return { ok: false, message: `Could not extract arXiv ID from URL "${trimmed}".` };
    }

    if (
      host === 'pubmed.ncbi.nlm.nih.gov' ||
      ((host === 'ncbi.nlm.nih.gov' || host.endsWith('.ncbi.nlm.nih.gov')) && pathname.includes('pubmed'))
    ) {
      const match = /(?:\/pubmed)?\/(\d+)/.exec(pathname);
      if (match) return { ok: true, identity: { source: 'pubmed', id: match[1]! } };
      return { ok: false, message: `Could not extract PubMed ID from URL "${trimmed}".` };
    }

    if (host === 'api.crossref.org') {
      const match = /\/works\/(10\.\d{4,9}\/[^\s]+)/.exec(pathname);
      if (match) return { ok: true, identity: { source: 'crossref', id: match[1]! } };
    }

    if (host === 'api.datacite.org') {
      const match = /\/dois\/(10\.\d{4,9}\/[^\s]+)/.exec(pathname);
      if (match) return { ok: true, identity: { source: 'datacite', id: match[1]! } };
    }

    return {
      ok: false,
      message: `URL "${trimmed}" is not a recognized research candidate identity. Specify --source explicitly to query a specific research adapter, or use web fetch for general web pages.`,
    };
  }

  // 3. Prefixed or pattern IDs
  if (/^openalex:([Ww]\d+)$/i.test(trimmed)) {
    const match = /^openalex:([Ww]\d+)$/i.exec(trimmed)!;
    return { ok: true, identity: { source: 'openalex', id: match[1]!.toUpperCase() } };
  }
  if (/^[Ww]\d+$/.test(trimmed)) {
    return { ok: true, identity: { source: 'openalex', id: trimmed.toUpperCase() } };
  }
  if (/^s2:([0-9a-f]{40})$/i.test(trimmed)) {
    const match = /^s2:([0-9a-f]{40})$/i.exec(trimmed)!;
    return { ok: true, identity: { source: 'semantic_scholar', id: match[1]!.toLowerCase() } };
  }
  if (/^[0-9a-f]{40}$/i.test(trimmed)) {
    return { ok: true, identity: { source: 'semantic_scholar', id: trimmed.toLowerCase() } };
  }
  if (/^arxiv:([a-z\-]+(?:\.[a-z\-]+)?\/\d+|\d{4}\.\d{4,5}(?:v\d+)?)$/i.test(trimmed)) {
    const match = /^arxiv:([a-z\-]+(?:\.[a-z\-]+)?\/\d+|\d{4}\.\d{4,5}(?:v\d+)?)$/i.exec(trimmed)!;
    return { ok: true, identity: { source: 'arxiv', id: match[1]! } };
  }
  if (/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(trimmed)) {
    return { ok: true, identity: { source: 'arxiv', id: trimmed } };
  }
  if (/^pmid:(\d+)$/i.test(trimmed)) {
    const match = /^pmid:(\d+)$/i.exec(trimmed)!;
    return { ok: true, identity: { source: 'pubmed', id: match[1]! } };
  }

  return {
    ok: false,
    message: `Could not determine research source for identifier "${trimmed}". Specify --source explicitly (e.g. --source openalex, --source pubmed).`,
  };
}

type PaperFetchOutcome =
  | { entity: NorthstarEntityV1; error?: undefined }
  | { entity?: undefined; error: Omit<NorthstarErrorV1, 'source' | 'backend'> };

async function fetchOpenAlexPaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const env = request.env ?? process.env;
  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'OPENALEX_API_KEY');
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let target = id;
  const doi = extractDoi(id);
  if (doi) {
    target = `https://doi.org/${doi}`;
  } else if (/^[Ww]\d+$/.test(id)) {
    target = id.toUpperCase();
  }

  const url = `https://api.openalex.org/works/${encodeURIComponent(target)}`;
  let payload: unknown;
  try {
    payload = await fetchResearchJson(url, headers, request.signal, request.lookup);
  } catch (error) {
    if (error instanceof ResearchHttpError && error.status === 404) {
      return { error: { code: 'backend_http_error', message: `Paper not found in OpenAlex: ${id}`, retryable: false } };
    }
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const work = researchRecord(payload);
  if (!work) {
    return { error: { code: 'invalid_backend_response', message: 'OpenAlex returned invalid work payload.', retryable: false } };
  }
  const row = mapOpenAlexRow(work);
  const parsed = parseAdapterRows([row], 'openalex', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'OpenAlex work failed entity validation.', retryable: false } };
  }
  return { entity };
}

async function fetchSemanticScholarPaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const env = request.env ?? process.env;
  const headers: Record<string, string> = {};
  const apiKey = envApiKey(env, 'SEMANTIC_SCHOLAR_API_KEY');
  if (apiKey) headers['x-api-key'] = apiKey;

  let target = id;
  const doi = extractDoi(id);
  if (doi) {
    target = `DOI:${doi}`;
  }

  const url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(target)}?fields=${FIELDS}`;
  let payload: unknown;
  try {
    payload = await fetchResearchJson(url, headers, request.signal, request.lookup);
  } catch (error) {
    if (error instanceof ResearchHttpError && error.status === 404) {
      return { error: { code: 'backend_http_error', message: `Paper not found in Semantic Scholar: ${id}`, retryable: false } };
    }
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const paper = researchRecord(payload);
  if (!paper) {
    return { error: { code: 'invalid_backend_response', message: 'Semantic Scholar returned invalid paper payload.', retryable: false } };
  }
  const row = mapSemanticScholarRow(paper);
  const parsed = parseAdapterRows([row], 'semantic_scholar', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'Semantic Scholar paper failed entity validation.', retryable: false } };
  }
  return { entity };
}

async function fetchArxivPaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const cleanId = id.replace(/^arxiv:\s*/i, '').trim();
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(cleanId)}`;
  let xml: string;
  try {
    xml = await fetchResearchText(url, {}, request.signal, request.lookup);
  } catch (error) {
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const { entries } = parseEntries(xml);
  if (entries.length === 0 || !entries[0]) {
    return { error: { code: 'backend_http_error', message: `Paper not found in arXiv: ${id}`, retryable: false } };
  }
  const entry = entries[0];
  const row = {
    id: entry.id,
    title: entry.title,
    url: entry.id,
    snippet: entry.summary,
    abstract: entry.summary === '' ? undefined : entry.summary,
    authors: entry.authors.map((name) => ({ name })),
    year: entry.published ? Number(entry.published.slice(0, 4)) : undefined,
    publishedAt: entry.published,
  };
  const parsed = parseAdapterRows([row], 'arxiv', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'arXiv entry failed entity validation.', retryable: false } };
  }
  return { entity };
}

async function fetchPubmedPaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const env = request.env ?? process.env;
  const pmid = id.replace(/^pmid:\s*/i, '').trim();
  const params = authParams(env);
  params.set('db', 'pubmed');
  params.set('retmode', 'json');
  params.set('id', pmid);

  let payload: unknown;
  try {
    payload = await fetchResearchJson(`${PUBMED_EUTILS_BASE}/esummary.fcgi?${params}`, {}, request.signal, request.lookup);
  } catch (error) {
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const result = researchRecord(researchRecord(payload)?.result);
  const doc = researchRecord(result?.[pmid]);
  if (!doc) {
    return { error: { code: 'backend_http_error', message: `Paper not found in PubMed: ${id}`, retryable: false } };
  }
  const row = mapDocSum(pmid, doc);
  const parsed = parseAdapterRows([row], 'pubmed', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'PubMed entry failed entity validation.', retryable: false } };
  }
  return { entity };
}

async function fetchCrossrefPaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const doi = extractDoi(id) ?? id.trim();
  const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`;
  let payload: unknown;
  try {
    payload = await fetchResearchJson(url, {}, request.signal, request.lookup);
  } catch (error) {
    if (error instanceof ResearchHttpError && error.status === 404) {
      return { error: { code: 'backend_http_error', message: `Paper not found in Crossref: ${id}`, retryable: false } };
    }
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const container = researchRecord(payload);
  const message = researchRecord(container?.message);
  if (!message) {
    return { error: { code: 'invalid_backend_response', message: 'Crossref response missing message.', retryable: false } };
  }
  const row = mapCrossrefRow(message);
  const parsed = parseAdapterRows([row], 'crossref', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'Crossref paper failed entity validation.', retryable: false } };
  }
  return { entity };
}

async function fetchDatacitePaper(
  id: string,
  request: ResearchPaperRequest,
): Promise<PaperFetchOutcome> {
  const doi = extractDoi(id) ?? id.trim();
  const url = `https://api.datacite.org/dois/${encodeURIComponent(doi)}`;
  let payload: unknown;
  try {
    payload = await fetchResearchJson(url, {}, request.signal, request.lookup);
  } catch (error) {
    if (error instanceof ResearchHttpError && error.status === 404) {
      return { error: { code: 'backend_http_error', message: `Paper not found in DataCite: ${id}`, retryable: false } };
    }
    const outcome = httpOutcomeError(error as Error & { status?: number; kind?: string });
    return { error: outcome };
  }

  const container = researchRecord(payload);
  const data = researchRecord(container?.data);
  if (!data) {
    return { error: { code: 'invalid_backend_response', message: 'DataCite response missing data.', retryable: false } };
  }
  const row = mapDataciteRow(data);
  const parsed = parseAdapterRows([row], 'datacite', 'work');
  const entity = parsed.entities[0];
  if (!entity) {
    return { error: { code: 'invalid_backend_response', message: 'DataCite record failed entity validation.', retryable: false } };
  }
  return { entity };
}

export async function fetchResearchPaper(
  request: ResearchPaperRequest,
  context: ResearchAdapterContext = {},
): Promise<NorthstarResultV1> {
  const rawId = typeof request.idOrUrl === 'string' ? request.idOrUrl.trim() : '';
  const req = researchRequestV1(request.source ?? 'research', { ...context, action: 'paper' });

  if (!rawId) {
    return buildNorthstarResult({
      request: req,
      outcomes: [{
        source: 'research',
        backend: 'native-public-apis',
        error: { code: 'invalid_input', message: 'ID or URL is required', retryable: false },
      }],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }

  let source: string;
  let id: string;

  if (request.source !== undefined) {
    const specified = request.source.trim();
    if (specified === 'all') {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: 'all',
          backend: 'native-public-apis',
          error: { code: 'invalid_input', message: 'paper action requires one exact research source, not "all".', retryable: false },
        }],
        pagination: { supported: false, limit: 1, hasMore: false },
      });
    }
    if (!isResearchSource(specified)) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: specified,
          backend: 'native-public-apis',
          error: {
            code: 'invalid_input',
            message: `Unsupported research source "${specified}". Supported sources: ${RESEARCH_SOURCE_CAPABILITIES.map((s) => s.id).join(', ')}.`,
            retryable: false,
          },
        }],
        pagination: { supported: false, limit: 1, hasMore: false },
      });
    }
    if (!SUPPORTED_PAPER_SOURCES.has(specified)) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: specified,
          backend: researchSourceCapability(specified)?.backend ?? 'native-public-apis',
          error: {
            code: 'unsupported_action',
            message: `${specified} does not support the "paper" action. Supported sources: ${[...SUPPORTED_PAPER_SOURCES].join(', ')}.`,
            retryable: false,
          },
        }],
        pagination: { supported: false, limit: 1, hasMore: false },
      });
    }
    source = specified;
    id = rawId;
  } else {
    const resolved = resolvePaperIdentity(rawId);
    if (!resolved.ok) {
      return buildNorthstarResult({
        request: req,
        outcomes: [{
          source: 'research',
          backend: 'native-public-apis',
          error: { code: 'invalid_input', message: resolved.message, retryable: false },
        }],
        pagination: { supported: false, limit: 1, hasMore: false },
      });
    }
    source = resolved.identity.source;
    id = resolved.identity.id;
  }

  const backend = researchSourceCapability(source)?.backend ?? 'native-public-apis';
  const paperReq = researchRequestV1(source, { ...context, action: 'paper' });

  if (request.signal?.aborted) throw new Error('aborted');

  let result: PaperFetchOutcome;

  switch (source) {
    case 'openalex':
      result = await fetchOpenAlexPaper(id, request);
      break;
    case 'semantic_scholar':
      result = await fetchSemanticScholarPaper(id, request);
      break;
    case 'arxiv':
      result = await fetchArxivPaper(id, request);
      break;
    case 'pubmed':
      result = await fetchPubmedPaper(id, request);
      break;
    case 'crossref':
      result = await fetchCrossrefPaper(id, request);
      break;
    case 'datacite':
      result = await fetchDatacitePaper(id, request);
      break;
    default:
      result = {
        error: {
          code: 'unsupported_action',
          message: `${source} does not support the "paper" action.`,
          retryable: false,
        },
      };
  }

  if (result.error) {
    return buildNorthstarResult({
      request: paperReq,
      outcomes: [{
        source,
        backend,
        error: result.error,
      }],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
  }

  return buildNorthstarResult({
    request: paperReq,
    outcomes: [{
      source,
      backend,
      entities: [result.entity],
      invalid: 0,
    }],
    pagination: { supported: false, limit: 1, hasMore: false },
  });
}
