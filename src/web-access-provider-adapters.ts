// Compat search adapters for the 30-provider union.
//
// Every adapter below is source-verified against upstream pi-web-access at
// pinned commit 192ac1875e3b8f88c78953dbc314949ec9fcaa27. Each adapter cites
// its upstream file. Phase 1 bounds (orchestrator-approved):
// - Direct environment credentials only. No config-file discovery,
//   no `!command`, no 1Password, no browser-cookie auth.
// - Single attempt per search. No retries, no paid retry.
// - No new dependencies (hence no DuckDuckGo/linkedom, no PDF chain).
// - Unverifiable request details are OMITTED, never invented; hostname
//   post-filtering still applies downstream in the ranking worker.
// - Upstream `openai` has no contract id (contract keeps the union
//   upstream-inventory-only minus openai/codex); no openai adapter ships here.
//
// Local-id mapping: contract `ollama-search` == upstream `ollama`.

import {
  validateWebAccessProviderResponse,
  WEB_ACCESS_MAX_NUM_RESULTS,
  type WebAccessProviderId,
  type WebAccessProviderResponse,
  type WebAccessRecencyFilter,
  type WebAccessSearchHit,
} from './web-access-contract.js';
import { passesWebAccessDomainFilter } from './web-access-domain.js';
import { WebAccessProviderError } from './web-access-provider-errors.js';
import type { WebAccessProviderFailure } from './web-access-contract.js';
import {
  assertNotRedirect,
  fetchOnce,
  readErrorText,
  readJsonPayload,
  wrapAdapterError,
  type WebAccessHttpOptions,
} from './web-access-provider-http.js';

export interface WebAccessAdapterRequest {
  query: string;
  numResults: number;
  recencyFilter?: WebAccessRecencyFilter | undefined;
  domainFilter?: string[] | undefined;
  includeContent?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface WebAccessAdapter {
  id: WebAccessProviderId;
  isConfigured(env: Record<string, string | undefined>): boolean;
  search(
    request: WebAccessAdapterRequest,
    env: Record<string, string | undefined>,
  ): Promise<WebAccessProviderResponse>;
}

/** Per-snippet bound mirroring the local 8k generated-text ceiling. */
const SNIPPET_MAX_CHARS = 8000;
/** Google-style time-range mapping shared by serper/serpapi/firecrawl. */
const QDR_TBS: Record<WebAccessRecencyFilter, string> = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
};

function envKey(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function requireKey(
  provider: WebAccessProviderId,
  label: string,
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = envKey(env, name);
  if (value === undefined) {
    const failure: WebAccessProviderFailure = {
      provider,
      kind: 'unavailable',
      message: `${label} is not configured (set ${name})`,
      retryable: false,
    };
    throw new WebAccessProviderError(failure);
  }
  return value;
}

function httpOptions(
  provider: WebAccessProviderId,
  label: string,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): WebAccessHttpOptions {
  const options: WebAccessHttpOptions = { provider, label, apiKey, signal: undefined };
  if (signal !== undefined) options.signal = signal;
  return options;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function cleanSnippet(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX_CHARS);
}

function cleanTitle(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 500) : fallback;
}

/** Hostname post-filter for domainFilter ( ranking worker also enforces ). */
export function passesDomainFilter(url: string, domainFilter: readonly string[] | undefined): boolean {
  if (domainFilter === undefined || domainFilter.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return passesWebAccessDomainFilter(hostname, domainFilter);
}

function buildAnswer(results: WebAccessSearchHit[]): string {
  return results
    .map((result) =>
      result.snippet.length > 0
        ? `${result.snippet}\nSource: ${result.title} (${result.url})`
        : `Source: ${result.title} (${result.url})`,
    )
    .join('\n\n');
}

function collectHit(
  out: WebAccessSearchHit[],
  domainFilter: readonly string[] | undefined,
  title: unknown,
  url: unknown,
  snippet: unknown,
  publishedDate?: unknown,
): void {
  if (typeof url !== 'string' || !isHttpUrl(url.trim())) return;
  const clean = url.trim();
  if (!passesDomainFilter(clean, domainFilter)) return;
  const hit: WebAccessSearchHit = {
    title: cleanTitle(title, clean),
    url: clean,
    snippet: cleanSnippet(snippet),
  };
  if (typeof publishedDate === 'string' && publishedDate.length > 0) hit.publishedDate = publishedDate;
  out.push(hit);
}

function finalize(
  provider: WebAccessProviderId,
  label: string,
  apiKey: string | undefined,
  hits: WebAccessSearchHit[],
  numResults: number,
  answer?: string,
  inlineContent?: string,
): WebAccessProviderResponse {
  const results = hits.slice(0, Math.min(numResults, WEB_ACCESS_MAX_NUM_RESULTS));
  const response: WebAccessProviderResponse = { provider, results };
  if (answer !== undefined && answer.length > 0) response.answer = answer.slice(0, SNIPPET_MAX_CHARS * 4);
  if (inlineContent !== undefined && inlineContent.length > 0) {
    response.inlineContent = inlineContent.slice(0, 50_000);
  }
  const check = validateWebAccessProviderResponse({ provider, results: response.results });
  if (!check.ok) {
    throw wrapAdapterError(provider, label, new Error(`${label} returned invalid response: ${check.issues.join('; ')}`), apiKey);
  }
  return response;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  options: WebAccessHttpOptions,
): Promise<{ response: Response; data: unknown }> {
  const response = await fetchOnce(
    url,
    { method: 'POST', headers, body: JSON.stringify(body), ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    options,
  );
  assertNotRedirect(response, options);
  if (!response.ok) {
    throw wrapAdapterError(
      options.provider,
      options.label,
      new Error(`${options.label} error ${response.status}: ${await readErrorText(response, options)}`),
      options.apiKey,
    );
  }
  return { response, data: await readJsonPayload(response, options) };
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  options: WebAccessHttpOptions,
): Promise<{ response: Response; data: unknown }> {
  const response = await fetchOnce(
    url,
    { method: 'GET', headers, ...(options.signal !== undefined ? { signal: options.signal } : {}) },
    options,
  );
  assertNotRedirect(response, options);
  if (!response.ok) {
    throw wrapAdapterError(
      options.provider,
      options.label,
      new Error(`${options.label} error ${response.status}: ${await readErrorText(response, options)}`),
      options.apiKey,
    );
  }
  return { response, data: await readJsonPayload(response, options) };
}

function invalidShape(provider: WebAccessProviderId, label: string, detail: string, apiKey: string | undefined): WebAccessProviderError {
  return wrapAdapterError(provider, label, new Error(`${label} returned invalid response: ${detail}`), apiKey);
}

// ── tavily ──
// Source: tavily.ts searchWithTavily — POST https://api.tavily.com/search,
// Bearer TAVILY_API_KEY, {query, search_depth:'basic', max_results,
// include_answer:'basic', include_raw_content, time_range}. Response
// {answer, results:[{title,url,content,raw_content}]}.
const tavilyAdapter: WebAccessAdapter = {
  id: 'tavily',
  isConfigured: (env) => envKey(env, 'TAVILY_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Tavily API';
    const apiKey = requireKey('tavily', label, env, 'TAVILY_API_KEY');
    const options = httpOptions('tavily', label, apiKey, request.signal);
    const body: Record<string, unknown> = {
      query: request.query,
      search_depth: 'basic',
      max_results: request.numResults,
      include_answer: 'basic',
      include_raw_content: request.includeContent === true ? 'markdown' : false,
      ...(request.recencyFilter !== undefined ? { time_range: request.recencyFilter } : {}),
    };
    try {
      const { data } = await postJson('https://api.tavily.com/search', body, {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('tavily', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (!Array.isArray(envelope.results)) throw invalidShape('tavily', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: Array<{ url: string; content: string }> = [];
      for (const row of envelope.results as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.content);
        if (hits.length > before && typeof item.raw_content === 'string' && item.raw_content.trim()) {
          const url = (hits[before] as WebAccessSearchHit).url;
          inline.push({ url, content: item.raw_content.trim() });
        }
      }
      const answer = typeof envelope.answer === 'string' ? envelope.answer : '';
      const withContent = request.includeContent === true ? inline.map((e) => e.content).join('\n\n') : undefined;
      return finalize('tavily', label, apiKey, hits, request.numResults, answer || undefined, withContent || undefined);
    } catch (error) {
      throw wrapAdapterError('tavily', label, error, apiKey);
    }
  },
};

// ── exa ──
// Source: exa.ts searchWithExa (POST {apiBase}/search, x-api-key header) plus
// the established local shape in src/web-exa.ts ({query, numResults,
// type:'auto', contents}). Response results:[{title,url,text,highlights}].
const exaAdapter: WebAccessAdapter = {
  id: 'exa',
  isConfigured: (env) => envKey(env, 'EXA_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Exa API';
    const apiKey = requireKey('exa', label, env, 'EXA_API_KEY');
    const options = httpOptions('exa', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://api.exa.ai/search', {
        query: request.query,
        numResults: request.numResults,
        type: 'auto',
        contents: { text: true, highlights: true },
      }, { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('exa', label, 'expected object envelope', apiKey);
      }
      const results = (data as Record<string, unknown>).results;
      if (!Array.isArray(results)) throw invalidShape('exa', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of results as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const highlights = Array.isArray(item.highlights)
          ? (item.highlights as unknown[]).filter((h): h is string => typeof h === 'string').join(' ')
          : '';
        const snippet = highlights.trim() || item.text;
        collectHit(hits, request.domainFilter, item.title, item.url, snippet);
      }
      return finalize('exa', label, apiKey, hits, request.numResults, buildAnswer(hits.slice(0, request.numResults)) || undefined);
    } catch (error) {
      throw wrapAdapterError('exa', label, error, apiKey);
    }
  },
};

// ── brave ──
// Source: brave.ts searchWithBrave — GET {apiUrl}?q=&count=&freshness,
// X-Subscription-Token, freshness day/week/month/year -> pd/pw/pm/py.
// Response {web:{results:[{title,url,description}]}}.
const BRAVE_FRESHNESS: Record<WebAccessRecencyFilter, string> = {
  day: 'pd',
  week: 'pw',
  month: 'pm',
  year: 'py',
};
const braveAdapter: WebAccessAdapter = {
  id: 'brave',
  isConfigured: (env) => envKey(env, 'BRAVE_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Brave Search API';
    const apiKey = requireKey('brave', label, env, 'BRAVE_API_KEY');
    const options = httpOptions('brave', label, apiKey, request.signal);
    try {
      const params = new URLSearchParams({
        q: request.query,
        count: String(request.domainFilter?.length ? 20 : request.numResults),
      });
      if (request.recencyFilter !== undefined) params.set('freshness', BRAVE_FRESHNESS[request.recencyFilter]);
      const { data } = await getJson(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
      }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('brave', label, 'expected object envelope', apiKey);
      }
      const web = (data as Record<string, unknown>).web as Record<string, unknown> | undefined;
      const rows = web !== undefined ? web.results : [];
      if (!Array.isArray(rows)) throw invalidShape('brave', label, 'expected web.results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.url, item.description);
        if (hits.length >= request.numResults) break;
      }
      return finalize('brave', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('brave', label, error, apiKey);
    }
  },
};

// ── diffbot ──
// No upstream v0.29 search source exists for Diffbot (Northstar-only
// provider). Phase 1 refuses to guess a shape: always unconfigured.
const diffbotAdapter: WebAccessAdapter = {
  id: 'diffbot',
  isConfigured: () => false,
  async search(_request, _env) {
    const failure: WebAccessProviderFailure = {
      provider: 'diffbot',
      kind: 'unavailable',
      message: 'Diffbot has no upstream v0.29 search source; compat search does not route to diffbot',
      retryable: false,
    };
    throw new WebAccessProviderError(failure);
  },
};

// ── firecrawl ──
// Source: firecrawl.ts — availability is API-key or base-URL presence;
// POST {base}/{version}/search with Bearer key when set (key-only setups
// use the hosted endpoint); body {query, limit, sources:['web'],
// includeDomains/excludeDomains, tbs qdr map, scrapeOptions when
// includeContent}. Response envelope {success:true, data:[...]}.
const firecrawlAdapter: WebAccessAdapter = {
  id: 'firecrawl',
  isConfigured: (env) => envKey(env, 'FIRECRAWL_API_KEY') !== undefined || envKey(env, 'FIRECRAWL_BASE_URL') !== undefined,
  async search(request, env) {
    const label = 'Firecrawl search';
    const baseRaw = envKey(env, 'FIRECRAWL_BASE_URL') ?? 'https://api.firecrawl.dev';
    const apiKey = envKey(env, 'FIRECRAWL_API_KEY');
    const options = httpOptions('firecrawl', label, apiKey, request.signal);
    try {
      const base = baseRaw.replace(/\/+$/, '');
      const version = (envKey(env, 'FIRECRAWL_API_VERSION') ?? 'v2').trim() || 'v2';
      const include = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const exclude = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      const body: Record<string, unknown> = {
        query: request.query,
        limit: request.numResults,
        sources: ['web'],
        ...(include.length > 0 ? { includeDomains: include } : {}),
        ...(include.length === 0 && exclude.length > 0 ? { excludeDomains: exclude } : {}),
        ...(request.recencyFilter !== undefined ? { tbs: QDR_TBS[request.recencyFilter] } : {}),
        ...(request.includeContent === true ? { scrapeOptions: { formats: ['markdown'], onlyMainContent: true } } : {}),
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const { data } = await postJson(`${base}/${version}/search`, body, headers, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('firecrawl', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (envelope.success !== true) throw invalidShape('firecrawl', label, 'expected success true', apiKey);
      if (!Array.isArray(envelope.data)) throw invalidShape('firecrawl', label, 'expected data array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of envelope.data as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.markdown ?? item.description ?? item.snippet);
        if (hits.length > before && request.includeContent === true && typeof item.markdown === 'string' && item.markdown.trim()) {
          inline.push(item.markdown.trim());
        }
      }
      return finalize('firecrawl', label, apiKey, hits, request.numResults, buildAnswer(hits.slice(0, request.numResults)) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('firecrawl', label, error, apiKey);
    }
  },
};

// ── jina ──
// Source: jina-search.ts — GET https://s.jina.ai/{encodedQuery}?count=&site=,
// Bearer JINA_API_KEY, X-Respond-With content/no-content; recency folded into
// the query as `published in the past {day|week|month|year}`. Response
// {code:200,data:[{url,title,description,content}]} or bare array.
const jinaAdapter: WebAccessAdapter = {
  id: 'jina',
  isConfigured: (env) => envKey(env, 'JINA_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Jina Search API';
    const apiKey = requireKey('jina', label, env, 'JINA_API_KEY');
    const options = httpOptions('jina', label, apiKey, request.signal);
    try {
      const includes = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const excludes = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      const exclusions = excludes.map((d) => ` -site:${d}`).join('');
      const recency = request.recencyFilter !== undefined ? ` published in the past ${request.recencyFilter}` : '';
      const constrained = `${request.query.trim()}${exclusions}${recency}`.trim();
      const url = new URL(encodeURIComponent(constrained), 'https://s.jina.ai/');
      url.searchParams.set('count', String(request.numResults));
      for (const domain of includes) url.searchParams.append('site', domain);
      const { data } = await getJson(url.toString(), {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'X-Respond-With': request.includeContent === true ? 'content' : 'no-content',
        'X-Retain-Images': 'none',
      }, options);
      const items = Array.isArray(data)
        ? data
        : (typeof data === 'object' && data !== null && Array.isArray((data as Record<string, unknown>).data)
          ? (data as Record<string, unknown>).data as unknown[]
          : undefined);
      if (items === undefined) throw invalidShape('jina', label, 'expected data array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of items) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.description);
        if (hits.length > before && request.includeContent === true && typeof item.content === 'string' && item.content.trim()) {
          inline.push(item.content.trim());
        }
        if (hits.length >= request.numResults) break;
      }
      return finalize('jina', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('jina', label, error, apiKey);
    }
  },
};

// ── searxng ──
// Source: searxng.ts searchWithSearXNG — GET {base}/search?q=&format=json;
// env-only base via SEARXNG_BASE_URL. Response {results:[{title,url,content}],
// answers?:string[]}. Recency map is config-adjacent upstream; Phase 1 omits
// time_range rather than guessing its values.
const searxngAdapter: WebAccessAdapter = {
  id: 'searxng',
  isConfigured: (env) => envKey(env, 'SEARXNG_BASE_URL') !== undefined,
  async search(request, env) {
    const label = 'SearXNG search';
    const base = requireKey('searxng', label, env, 'SEARXNG_BASE_URL').replace(/\/+$/, '');
    const options = httpOptions('searxng', label, undefined, request.signal);
    try {
      const url = new URL(`${base}/search`);
      url.searchParams.set('q', request.query);
      url.searchParams.set('format', 'json');
      const { data } = await getJson(url.toString(), { Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('searxng', label, 'expected object envelope', undefined);
      }
      const rows = (data as Record<string, unknown>).results;
      if (!Array.isArray(rows)) throw invalidShape('searxng', label, 'expected results array', undefined);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.url, item.content);
        if (hits.length >= request.numResults) break;
      }
      return finalize('searxng', label, undefined, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('searxng', label, error, undefined);
    }
  },
};

// ── ollama-search (upstream `ollama`) ──
// Source: ollama.ts searchWithOllama — POST
// {base}/api/web_search, Bearer key when set, {query, max_results}.
// Key: OLLAMA_SEARCH_API_KEY (SEARCH_OLLAMA_API_KEY alias), OLLAMA_API_KEY
// fallback only. Base: OLLAMA_SEARCH_BASE_URL (SEARCH_OLLAMA_BASE_URL
// alias), defaulting to the hosted endpoint.
// Response {results:[{title,url,content}]}.
const ollamaSearchAdapter: WebAccessAdapter = {
  id: 'ollama-search',
  isConfigured: (env) =>
    envKey(env, 'OLLAMA_SEARCH_API_KEY') !== undefined ||
    envKey(env, 'SEARCH_OLLAMA_API_KEY') !== undefined ||
    envKey(env, 'OLLAMA_SEARCH_BASE_URL') !== undefined ||
    envKey(env, 'SEARCH_OLLAMA_BASE_URL') !== undefined ||
    envKey(env, 'OLLAMA_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Ollama API';
    const apiKey =
      envKey(env, 'OLLAMA_SEARCH_API_KEY') ??
      envKey(env, 'SEARCH_OLLAMA_API_KEY') ??
      envKey(env, 'OLLAMA_API_KEY');
    const base = (envKey(env, 'OLLAMA_SEARCH_BASE_URL') ?? envKey(env, 'SEARCH_OLLAMA_BASE_URL') ?? 'https://ollama.com').replace(/\/+$/, '');
    const options = httpOptions('ollama-search', label, apiKey, request.signal);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const { data } = await postJson(`${base}/api/web_search`, {
        query: request.query,
        max_results: request.numResults,
      }, headers, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('ollama-search', label, 'expected object envelope', apiKey);
      }
      const rows = (data as Record<string, unknown>).results;
      if (!Array.isArray(rows)) throw invalidShape('ollama-search', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.content);
        if (hits.length > before && request.includeContent === true && typeof item.content === 'string' && item.content.trim()) {
          inline.push(item.content.trim());
        }
        if (hits.length >= request.numResults) break;
      }
      return finalize('ollama-search', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('ollama-search', label, error, apiKey);
    }
  },
};

// ── duckduckgo ──
// Source: duckduckgo.ts searchWithDuckDuckGo parses HTML via `linkedom`,
// which Phase 1 must not add as a dependency. Always unconfigured.
const duckduckgoAdapter: WebAccessAdapter = {
  id: 'duckduckgo',
  isConfigured: () => false,
  async search(_request, _env) {
    const failure: WebAccessProviderFailure = {
      provider: 'duckduckgo',
      kind: 'unavailable',
      message: 'DuckDuckGo compat search needs HTML parsing (linkedom), which Phase 1 does not add',
      retryable: false,
    };
    throw new WebAccessProviderError(failure);
  },
};

// ── parallel ──
// Source: parallel.ts — POST https://api.parallel.ai/v1/search, x-api-key
// (min 8 chars, placeholder denylist), body {objective, search_queries,
// advanced_settings:{max_results}}. Response {results:[{url,title,excerpts}]}.
const parallelAdapter: WebAccessAdapter = {
  id: 'parallel',
  isConfigured: (env) => (envKey(env, 'PARALLEL_API_KEY')?.length ?? 0) >= 8,
  async search(request, env) {
    const label = 'Parallel API';
    const apiKey = requireKey('parallel', label, env, 'PARALLEL_API_KEY');
    if (apiKey.length < 8) {
      throw new WebAccessProviderError({
        provider: 'parallel',
        kind: 'unavailable',
        message: 'Parallel API key is not configured (set PARALLEL_API_KEY)',
        retryable: false,
      });
    }
    const options = httpOptions('parallel', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://api.parallel.ai/v1/search', {
        objective: request.query,
        search_queries: [request.query],
        advanced_settings: { max_results: request.numResults },
      }, { 'x-api-key': apiKey, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('parallel', label, 'expected object envelope', apiKey);
      }
      const rows = (data as Record<string, unknown>).results;
      if (!Array.isArray(rows)) throw invalidShape('parallel', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const excerpts = Array.isArray(item.excerpts)
          ? (item.excerpts as unknown[]).filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          : [];
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, excerpts.join('\n\n'));
        if (hits.length > before && request.includeContent === true && excerpts.length > 0) {
          inline.push(excerpts.join('\n\n'));
        }
        if (hits.length >= request.numResults) break;
      }
      return finalize('parallel', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('parallel', label, error, apiKey);
    }
  },
};

// ── parallel-mcp ──
// Source: parallel-mcp.ts — POST https://search.parallel.ai/mcp JSON-RPC
// tools/call {name:'web_search', arguments:{objective, search_queries}} with
// optional Bearer PARALLEL_API_KEY. Results carry url/title/excerpts.
const parallelMcpAdapter: WebAccessAdapter = {
  id: 'parallel-mcp',
  isConfigured: () => true,
  async search(request, env) {
    const label = 'Parallel MCP';
    const apiKey = envKey(env, 'PARALLEL_API_KEY');
    const options = httpOptions('parallel-mcp', label, apiKey, request.signal);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const { data } = await postJson('https://search.parallel.ai/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'web_search', arguments: { objective: request.query, search_queries: [request.query] } },
      }, headers, options);
      const rows = extractJsonRpcResults(data);
      if (rows === undefined) throw invalidShape('parallel-mcp', label, 'expected result rows', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const excerpts = Array.isArray(item.excerpts)
          ? (item.excerpts as unknown[]).filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
          : [];
        collectHit(hits, request.domainFilter, item.title, item.url, excerpts.join(' '));
        if (hits.length >= request.numResults) break;
      }
      return finalize('parallel-mcp', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('parallel-mcp', label, error, apiKey);
    }
  },
};

function extractJsonRpcResults(data: unknown): unknown[] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const envelope = data as Record<string, unknown>;
  const result = envelope.result as Record<string, unknown> | undefined;
  if (typeof result !== 'object' || result === null) return undefined;
  const content = result.content;
  if (Array.isArray(content)) {
    for (const entry of content as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const text = (entry as Record<string, unknown>).text;
      if (typeof text === 'string') {
        try {
          const parsed: unknown = JSON.parse(text);
          if (Array.isArray(parsed)) return parsed;
          if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as Record<string, unknown>).results)) {
            return (parsed as Record<string, unknown>).results as unknown[];
          }
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }
  if (Array.isArray(result.results)) return result.results as unknown[];
  return undefined;
}

// ── tinyfish ──
// Source: tinyfish.ts — GET https://api.search.tinyfish.ai?query=&
// include_domains=&exclude_domains=&recency_minutes= (1440/10080/43200/
// 525600), X-API-Key header. Response {results:[{url,title,snippet}]}.
// Phase 1 reads the first page only.
const TINYFISH_RECENCY_MINUTES: Record<WebAccessRecencyFilter, number> = {
  day: 1440,
  week: 10080,
  month: 43200,
  year: 525600,
};
const tinyfishAdapter: WebAccessAdapter = {
  id: 'tinyfish',
  isConfigured: (env) => envKey(env, 'TINYFISH_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'TinyFish Search API';
    const apiKey = requireKey('tinyfish', label, env, 'TINYFISH_API_KEY');
    const options = httpOptions('tinyfish', label, apiKey, request.signal);
    try {
      const params = new URLSearchParams({ query: request.query });
      const include = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const exclude = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      if (include.length > 0) params.set('include_domains', include.join(','));
      if (exclude.length > 0) params.set('exclude_domains', exclude.join(','));
      if (request.recencyFilter !== undefined) params.set('recency_minutes', String(TINYFISH_RECENCY_MINUTES[request.recencyFilter]));
      const { data } = await getJson(`https://api.search.tinyfish.ai?${params.toString()}`, { 'X-API-Key': apiKey }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('tinyfish', label, 'expected object envelope', apiKey);
      }
      const rows = (data as Record<string, unknown>).results;
      if (!Array.isArray(rows)) throw invalidShape('tinyfish', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.url, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('tinyfish', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('tinyfish', label, error, apiKey);
    }
  },
};

// ── search1api ──
// Source: search1api.ts — POST https://api.search1api.com/search, Bearer
// SEARCH1API_KEY, {query, max_results, crawl_results, include_sites,
// exclude_sites, time_range: recency}. Response results:[{link,title,snippet}].
const search1apiAdapter: WebAccessAdapter = {
  id: 'search1api',
  isConfigured: (env) => envKey(env, 'SEARCH1API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Search1API Search API';
    const apiKey = requireKey('search1api', label, env, 'SEARCH1API_KEY');
    const options = httpOptions('search1api', label, apiKey, request.signal);
    try {
      const include = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const exclude = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      const { data } = await postJson('https://api.search1api.com/search', {
        query: request.query,
        max_results: request.numResults,
        crawl_results: request.includeContent === true ? request.numResults : 0,
        ...(include.length > 0 ? { include_sites: include } : {}),
        ...(exclude.length > 0 ? { exclude_sites: exclude } : {}),
        ...(request.recencyFilter !== undefined ? { time_range: request.recencyFilter } : {}),
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('search1api', label, 'expected object envelope', apiKey);
      }
      const rows = (data as Record<string, unknown>).results;
      if (!Array.isArray(rows)) throw invalidShape('search1api', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.link, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('search1api', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('search1api', label, error, apiKey);
    }
  },
};

// ── searchinfinity ──
// Source: searchinfinity.ts — POST
// https://torchlight.byteintlapi.com/search_api/web_search, Bearer
// SEARCHINFINITY_API_KEY, {Query, Count, Filter:{Sites,BlockHosts},
// TimeRange: OneDay/OneWeek/OneMonth/OneYear}. Business errors surface via
// ResponseMetadata.Error {CodeN, Code} mapped to HTTP semantics; results at
// Result.WebResults [{Url, Title}].
const SEARCHINFINITY_TIME_RANGE: Record<WebAccessRecencyFilter, string> = {
  day: 'OneDay',
  week: 'OneWeek',
  month: 'OneMonth',
  year: 'OneYear',
};
const searchinfinityAdapter: WebAccessAdapter = {
  id: 'searchinfinity',
  isConfigured: (env) => envKey(env, 'SEARCHINFINITY_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Searchinfinity API';
    const apiKey = requireKey('searchinfinity', label, env, 'SEARCHINFINITY_API_KEY');
    const options = httpOptions('searchinfinity', label, apiKey, request.signal);
    try {
      const include: string[] = [];
      const blocked: string[] = [];
      for (const raw of request.domainFilter ?? []) {
        const domain = raw.trim().toLowerCase().replace(/^-/, '');
        if (!domain) continue;
        const target = raw.trim().startsWith('-') ? blocked : include;
        if (target.length < 5 && !target.includes(domain)) target.push(domain);
      }
      const filter: Record<string, unknown> = {};
      if (include.length > 0) filter.Sites = include.join('|');
      if (blocked.length > 0) filter.BlockHosts = blocked.join('|');
      const { data } = await postJson('https://torchlight.byteintlapi.com/search_api/web_search', {
        Query: request.query,
        Count: request.numResults,
        ...(Object.keys(filter).length > 0 ? { Filter: filter } : {}),
        ...(request.recencyFilter !== undefined ? { TimeRange: SEARCHINFINITY_TIME_RANGE[request.recencyFilter] } : {}),
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('searchinfinity', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      const metadata = envelope.ResponseMetadata as Record<string, unknown> | undefined;
      const businessError = metadata?.Error as Record<string, unknown> | undefined;
      if (businessError !== undefined && businessError !== null) {
        const codeN = typeof businessError.CodeN === 'number' ? businessError.CodeN : undefined;
        const code = typeof businessError.Code === 'string' ? businessError.Code : '';
        const status = codeN === 700901 || code === 'invalid_api_key'
          ? 401
          : codeN === 700429 || code === '700429'
            ? 429
            : codeN === 10400 || code === '10400'
              ? 400
              : codeN === 10500 || code === '10500'
                ? 500
                : undefined;
        throw wrapAdapterError(
          'searchinfinity', label,
          new Error(`${label} error ${status ?? 'unknown'}: ${typeof businessError.Message === 'string' ? businessError.Message : 'business error'}`),
          apiKey,
        );
      }
      const result = envelope.Result as Record<string, unknown> | undefined;
      const rows = result?.WebResults;
      if (!Array.isArray(rows)) throw invalidShape('searchinfinity', label, 'expected Result.WebResults array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.Title, item.Url, '');
        if (hits.length >= request.numResults) break;
      }
      return finalize('searchinfinity', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('searchinfinity', label, error, apiKey);
    }
  },
};

// ── querit ──
// Source: querit.ts — POST https://api.querit.ai/v1/search, Bearer
// QUERIT_API_KEY, {query, count, filters:{sites:{include,exclude},
// timeRange:{date: d1/w1/m1/y1}}}. Success requires error_code 200;
// results at results.result [{url,title,snippet}].
const QUERIT_DATE: Record<WebAccessRecencyFilter, string> = {
  day: 'd1',
  week: 'w1',
  month: 'm1',
  year: 'y1',
};
const queritAdapter: WebAccessAdapter = {
  id: 'querit',
  isConfigured: (env) => envKey(env, 'QUERIT_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Querit Search API';
    const apiKey = requireKey('querit', label, env, 'QUERIT_API_KEY');
    const options = httpOptions('querit', label, apiKey, request.signal);
    try {
      const include = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const exclude = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      const filters: Record<string, unknown> = {};
      if (include.length > 0 || exclude.length > 0) {
        filters.sites = { ...(include.length > 0 ? { include } : {}), ...(exclude.length > 0 ? { exclude } : {}) };
      }
      if (request.recencyFilter !== undefined) filters.timeRange = { date: QUERIT_DATE[request.recencyFilter] };
      const { data } = await postJson('https://api.querit.ai/v1/search', {
        query: request.query,
        count: request.numResults,
        ...(Object.keys(filters).length > 0 ? { filters } : {}),
      }, { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('querit', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (Number(envelope.error_code) !== 200) {
        throw wrapAdapterError(
          'querit', label,
          new Error(`${label} returned error ${String(envelope.error_code ?? 'unknown')}${typeof envelope.error_msg === 'string' && envelope.error_msg.trim() ? `: ${envelope.error_msg.trim()}` : ''}`),
          apiKey,
        );
      }
      const results = envelope.results as Record<string, unknown> | undefined;
      const items = results?.result;
      if (!Array.isArray(items)) throw invalidShape('querit', label, 'expected results.result array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of items as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.url, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('querit', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('querit', label, error, apiKey);
    }
  },
};

// ── perplexity ──
// Source: perplexity.ts searchWithPerplexity — POST
// https://api.perplexity.ai/chat/completions, Bearer PERPLEXITY_API_KEY,
// {model:'sonar', messages, max_tokens:1024, return_related_questions:false,
// search_recency_filter?, search_domain_filter?}. Citations kept through the
// highest [N] cited index, capped at 20.
const perplexityAdapter: WebAccessAdapter = {
  id: 'perplexity',
  isConfigured: (env) => envKey(env, 'PERPLEXITY_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Perplexity API';
    const apiKey = requireKey('perplexity', label, env, 'PERPLEXITY_API_KEY');
    const options = httpOptions('perplexity', label, apiKey, request.signal);
    try {
      const body: Record<string, unknown> = {
        model: 'sonar',
        messages: [{ role: 'user', content: request.query }],
        max_tokens: 1024,
        return_related_questions: false,
      };
      if (request.recencyFilter !== undefined) body.search_recency_filter = request.recencyFilter;
      if (request.domainFilter !== undefined && request.domainFilter.length > 0) {
        const validated = request.domainFilter.filter((d) => {
          const domain = d.startsWith('-') ? d.slice(1) : d;
          return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
        });
        if (validated.length > 0) body.search_domain_filter = validated;
      }
      const { data } = await postJson('https://api.perplexity.ai/chat/completions', body, {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('perplexity', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      const choices = envelope.choices as Array<{ message?: { content?: string } }> | undefined;
      const answer = choices?.[0]?.message?.content ?? '';
      const citations: unknown[] = Array.isArray(envelope.citations) ? envelope.citations as unknown[] : [];
      let highestCited = 0;
      for (const match of answer.matchAll(/\[(\d{1,3})\]/g)) {
        highestCited = Math.max(highestCited, Number(match[1]));
      }
      const keep = Math.min(citations.length, 20, Math.max(request.numResults, highestCited));
      const hits: WebAccessSearchHit[] = [];
      for (let index = 0; index < keep; index++) {
        const citation = citations[index];
        if (typeof citation === 'string') {
          collectHit(hits, request.domainFilter, `Source ${index + 1}`, citation, '');
        } else if (typeof citation === 'object' && citation !== null && typeof (citation as Record<string, unknown>).url === 'string') {
          const entry = citation as Record<string, unknown>;
          collectHit(hits, request.domainFilter, (entry.title ?? `Source ${index + 1}`), entry.url, '');
        }
      }
      return finalize('perplexity', label, apiKey, hits, request.numResults, answer || undefined);
    } catch (error) {
      throw wrapAdapterError('perplexity', label, error, apiKey);
    }
  },
};

// ── gemini (API path only) ──
// Source: gemini-search.ts searchWithGeminiApi + gemini-api.ts — POST
// {base}/models/{model}:generateContent with x-goog-api-key,
// {contents:[{role:'user',parts:[{text}]}], tools:[{google_search:{}}]},
// model defaults to DEFAULT_SEARCH_MODEL 'gemini-3.6-flash'. Answer from
// candidates[0].content.parts text; results from
// candidates[0].groundingMetadata.groundingChunks [{web:{uri,title}}].
// Cookie/web path and redirect resolution are out of Phase 1 scope.
const GEMINI_SEARCH_MODEL = 'gemini-3.6-flash';
const geminiAdapter: WebAccessAdapter = {
  id: 'gemini',
  isConfigured: (env) => envKey(env, 'GEMINI_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Gemini API';
    const apiKey = requireKey('gemini', label, env, 'GEMINI_API_KEY');
    const options = httpOptions('gemini', label, apiKey, request.signal);
    try {
      const { data } = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SEARCH_MODEL}:generateContent`,
        {
          contents: [{ role: 'user', parts: [{ text: request.query }] }],
          tools: [{ google_search: {} }],
        },
        { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
        options,
      );
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('gemini', label, 'expected object envelope', apiKey);
      }
      const candidates = (data as Record<string, unknown>).candidates;
      const first = Array.isArray(candidates) ? (candidates[0] as Record<string, unknown> | undefined) : undefined;
      const parts = (first?.content as Record<string, unknown> | undefined)?.parts;
      const answer = Array.isArray(parts)
        ? (parts as unknown[])
          .map((part) => (typeof part === 'object' && part !== null ? (part as Record<string, unknown>).text : undefined))
          .filter((text): text is string => typeof text === 'string' && text.length > 0)
          .join('\n')
        : '';
      const metadata = first?.groundingMetadata as Record<string, unknown> | undefined;
      const chunks = metadata?.groundingChunks;
      const hits: WebAccessSearchHit[] = [];
      if (Array.isArray(chunks)) {
        for (const chunk of chunks as unknown[]) {
          if (typeof chunk !== 'object' || chunk === null) continue;
          const web = (chunk as Record<string, unknown>).web as Record<string, unknown> | undefined;
          if (typeof web?.uri !== 'string') continue;
          collectHit(hits, request.domainFilter, web.title ?? '', web.uri, '');
          if (hits.length >= request.numResults) break;
        }
      }
      if (!answer && hits.length === 0) throw invalidShape('gemini', label, 'no answer or sources', apiKey);
      return finalize('gemini', label, apiKey, hits, request.numResults, answer || undefined);
    } catch (error) {
      throw wrapAdapterError('gemini', label, error, apiKey);
    }
  },
};

// ── kimi ──
// Source: kimi-search.ts resolveKimiAuth — auth comes only from the Pi model
// registry (/login kimi-coding); no environment path exists. Always
// unconfigured in env-only Phase 1.
const kimiAdapter: WebAccessAdapter = {
  id: 'kimi',
  isConfigured: () => false,
  async search(_request, _env) {
    const failure: WebAccessProviderFailure = {
      provider: 'kimi',
      kind: 'unavailable',
      message: 'Kimi search needs a Kimi Code Plan login, which env-only Phase 1 does not support',
      retryable: false,
    };
    throw new WebAccessProviderError(failure);
  },
};

// ── serpdive ──
// Source: serpdive.ts — POST https://api.serpdive.com/v1/search, Bearer
// SERPDIVE_API_KEY, {query, model (SERPDIVE_MODEL or 'krill' default),
// max_results: min(num,10), answer:true unless krill}. Response
// {answer?, results:[{url,title,content}]}. Recency hint folds into the query
// upstream; Phase 1 sends the query verbatim and slices locally.
const serpdiveAdapter: WebAccessAdapter = {
  id: 'serpdive',
  isConfigured: (env) => envKey(env, 'SERPDIVE_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'SERPdive API';
    const apiKey = requireKey('serpdive', label, env, 'SERPDIVE_API_KEY');
    const options = httpOptions('serpdive', label, apiKey, request.signal);
    try {
      const rawModel = envKey(env, 'SERPDIVE_MODEL')?.toLowerCase() ?? 'krill';
      const model = rawModel === 'mako' || rawModel === 'moby' ? rawModel : 'krill';
      const { data } = await postJson('https://api.serpdive.com/v1/search', {
        query: request.query,
        model,
        max_results: Math.min(request.numResults, 10),
        ...(model === 'krill' ? {} : { answer: true }),
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('serpdive', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      const rows = envelope.results;
      if (!Array.isArray(rows)) throw invalidShape('serpdive', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of rows as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        if (typeof item.url !== 'string') continue;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.content);
        if (hits.length > before && request.includeContent === true && typeof item.content === 'string' && item.content.trim()) {
          inline.push(item.content.trim());
        }
        if (hits.length >= request.numResults) break;
      }
      const answer = typeof envelope.answer === 'string' && envelope.answer.trim()
        ? envelope.answer.trim()
        : buildAnswer(hits) || undefined;
      return finalize('serpdive', label, apiKey, hits, request.numResults, answer, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('serpdive', label, error, apiKey);
    }
  },
};

// ── kagi ──
// Source: kagi.ts searchWithKagi — POST https://kagi.com/api/v1/search,
// Bearer KAGI_API_KEY, {query, limit}. Response {data:{search:[...]} |
// data:[...]} with url/href/link + title/name + snippet/description/summary.
const kagiAdapter: WebAccessAdapter = {
  id: 'kagi',
  isConfigured: (env) => envKey(env, 'KAGI_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Kagi API';
    const apiKey = requireKey('kagi', label, env, 'KAGI_API_KEY');
    const options = httpOptions('kagi', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://kagi.com/api/v1/search', {
        query: request.query,
        limit: request.numResults,
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('kagi', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      const errors = envelope.errors ?? envelope.error;
      if (Array.isArray(errors) && errors.length > 0) {
        throw invalidShape('kagi', label, 'envelope reported errors', apiKey);
      }
      const payload = envelope.data;
      const items = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).search
        : payload;
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      appendKagiItems(items, hits, inline, request.domainFilter);
      const sliced = hits.slice(0, request.numResults);
      return finalize('kagi', label, apiKey, sliced, request.numResults, buildAnswer(sliced) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('kagi', label, error, apiKey);
    }
  },
};

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function appendKagiItems(value: unknown, hits: WebAccessSearchHit[], inline: string[], domainFilter: readonly string[] | undefined): void {
  if (Array.isArray(value)) {
    for (const item of value) appendKagiItems(item, hits, inline, domainFilter);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const item = value as Record<string, unknown>;
  const url = firstString(item.url, item.href, item.link);
  if (url === undefined || !isHttpUrl(url) || !passesDomainFilter(url, domainFilter)) return;
  const title = firstString(item.title, item.name) ?? url;
  const snippet = firstString(item.snippet, item.description, item.summary, item.content, item.markdown, item.text) ?? '';
  hits.push({ title, url, snippet: snippet.slice(0, SNIPPET_MAX_CHARS) });
  const content = firstString(item.markdown, item.content, item.text);
  if (content !== undefined) inline.push(content);
}

// ── anysearch ──
// Source: anysearch.ts — POST https://api.anysearch.com/v1/search,
// optional Bearer ANYSEARCH_API_KEY (isAnySearchAvailable is always true),
// {query, max_results}. Response {code:0, data:{results:[{title,url,snippet,
// content}]}}.
const anysearchAdapter: WebAccessAdapter = {
  id: 'anysearch',
  isConfigured: () => true,
  async search(request, env) {
    const label = 'AnySearch API';
    const apiKey = envKey(env, 'ANYSEARCH_API_KEY');
    const options = httpOptions('anysearch', label, apiKey, request.signal);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey !== undefined) headers.Authorization = `Bearer ${apiKey}`;
      const { data } = await postJson('https://api.anysearch.com/v1/search', {
        query: request.query,
        max_results: request.numResults,
      }, headers, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('anysearch', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (envelope.code !== 0) throw invalidShape('anysearch', label, 'expected code 0', apiKey);
      const payload = envelope.data as Record<string, unknown> | undefined;
      if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.results)) {
        throw invalidShape('anysearch', label, 'expected data.results array', apiKey);
      }
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of payload.results as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        if (typeof item.title !== 'string' || typeof item.url !== 'string' || typeof item.snippet !== 'string') {
          throw invalidShape('anysearch', label, 'expected title/url/snippet strings', apiKey);
        }
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, item.snippet);
        if (hits.length > before && request.includeContent === true && typeof item.content === 'string' && item.content.trim()) {
          inline.push(item.content.trim());
        }
        if (hits.length >= request.numResults) break;
      }
      return finalize('anysearch', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('anysearch', label, error, apiKey);
    }
  },
};

// ── xai (API-key path) ──
// Source: xai-search.ts — POST https://api.x.ai/v1/responses, Bearer
// XAI_API_KEY, {model (default 'grok-4.5'), input, tools:[{type:'web_search'}]}.
// Answer from output message text; results from annotation sources plus
// response-level citations. Subscription ctx path is out of Phase 1 scope;
// upstream folds filters into the prompt, Phase 1 sends the query verbatim.
const xaiAdapter: WebAccessAdapter = {
  id: 'xai',
  isConfigured: (env) => envKey(env, 'XAI_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'xAI API';
    const apiKey = requireKey('xai', label, env, 'XAI_API_KEY');
    const options = httpOptions('xai', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://api.x.ai/v1/responses', {
        model: 'grok-4.5',
        input: request.query,
        tools: [{ type: 'web_search' }],
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('xai', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      const output = Array.isArray(envelope.output) ? envelope.output as unknown[] : [];
      const parts: string[] = [];
      const hits: WebAccessSearchHit[] = [];
      const seen = new Set<string>();
      for (const item of output) {
        if (typeof item !== 'object' || item === null) continue;
        const entry = item as Record<string, unknown>;
        if (entry.type === 'message' && Array.isArray(entry.content)) {
          for (const part of entry.content as unknown[]) {
            if (typeof part === 'object' && part !== null && typeof (part as Record<string, unknown>).text === 'string') {
              const text = ((part as Record<string, unknown>).text as string).trim();
              if (text) parts.push(text);
            }
          }
        }
      }
      addXaiSources(hits, seen, envelope.citations, request.domainFilter);
      const answer = parts.join('\n').trim();
      if (!answer && hits.length === 0) throw invalidShape('xai', label, 'no answer or sources', apiKey);
      return finalize('xai', label, apiKey, hits.slice(0, request.numResults), request.numResults, answer || undefined);
    } catch (error) {
      throw wrapAdapterError('xai', label, error, apiKey);
    }
  },
};

function addXaiSources(hits: WebAccessSearchHit[], seen: Set<string>, sources: unknown, domainFilter: readonly string[] | undefined): void {
  if (!Array.isArray(sources)) return;
  for (const source of sources) {
    if (typeof source === 'string') {
      if (!seen.has(source)) {
        seen.add(source);
        collectHit(hits, domainFilter, source, source, '');
      }
      continue;
    }
    if (typeof source !== 'object' || source === null) continue;
    const record = source as Record<string, unknown>;
    const url = record.url ?? record.source_website_url;
    if (typeof url !== 'string' || seen.has(url)) continue;
    seen.add(url);
    collectHit(hits, domainFilter, (record.title ?? record.caption), url, '');
  }
}

// ── mistral ──
// Source: mistral-search.ts — POST https://api.mistral.ai/v1/conversations,
// Bearer MISTRAL_API_KEY, {inputs:[{role:'user',content}], stream:false,
// model (default 'mistral-small-latest'), tools:[{type:'web_search'}]}.
// Answer from message.output text; results from tool_reference parts
// {url,title,description}.
const mistralAdapter: WebAccessAdapter = {
  id: 'mistral',
  isConfigured: (env) => envKey(env, 'MISTRAL_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Mistral API';
    const apiKey = requireKey('mistral', label, env, 'MISTRAL_API_KEY');
    const options = httpOptions('mistral', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://api.mistral.ai/v1/conversations', {
        inputs: [{ role: 'user', content: request.query }],
        stream: false,
        model: 'mistral-small-latest',
        tools: [{ type: 'web_search' }],
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('mistral', label, 'expected object envelope', apiKey);
      }
      const outputs = (data as Record<string, unknown>).outputs;
      if (!Array.isArray(outputs)) throw invalidShape('mistral', label, 'expected outputs array', apiKey);
      const answers: string[] = [];
      const hits: WebAccessSearchHit[] = [];
      const seen = new Set<string>();
      for (const output of outputs as unknown[]) {
        if (typeof output !== 'object' || output === null) continue;
        const entry = output as Record<string, unknown>;
        if (entry.type !== 'message.output') continue;
        if (typeof entry.content === 'string' && entry.content.trim()) {
          answers.push(entry.content.trim());
          continue;
        }
        if (!Array.isArray(entry.content)) continue;
        for (const chunk of entry.content as unknown[]) {
          if (typeof chunk !== 'object' || chunk === null) continue;
          const part = chunk as Record<string, unknown>;
          if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
            answers.push(part.text.trim());
            continue;
          }
          if (part.type !== 'tool_reference' || hits.length >= request.numResults) continue;
          if (typeof part.url !== 'string' || seen.has(part.url)) continue;
          seen.add(part.url);
          collectHit(hits, request.domainFilter, part.title, part.url, part.description);
        }
      }
      const answer = answers.join('\n').trim();
      if (!answer && hits.length === 0) throw invalidShape('mistral', label, 'no answer or sources', apiKey);
      return finalize('mistral', label, apiKey, hits, request.numResults, answer || undefined);
    } catch (error) {
      throw wrapAdapterError('mistral', label, error, apiKey);
    }
  },
};

// ── brightdata ──
// Source: brightdata.ts searchWithBrightData — POST
// https://api.brightdata.com/request, Bearer BRIGHTDATA_API_KEY,
// {url: google SERP url, zone: BRIGHTDATA_SERP_ZONE, format:'raw'};
// errors name the billed zone. Response is SERP JSON with an organic array;
// anything else is invalid_response (never guessed into).
const brightdataAdapter: WebAccessAdapter = {
  id: 'brightdata',
  isConfigured: (env) => envKey(env, 'BRIGHTDATA_API_KEY') !== undefined && envKey(env, 'BRIGHTDATA_SERP_ZONE') !== undefined,
  async search(request, env) {
    const label = 'Bright Data API';
    const apiKey = requireKey('brightdata', label, env, 'BRIGHTDATA_API_KEY');
    const zone = requireKey('brightdata', label, env, 'BRIGHTDATA_SERP_ZONE');
    const options = httpOptions('brightdata', label, apiKey, request.signal);
    try {
      const serp = new URL('https://www.google.com/search');
      serp.searchParams.set('q', request.query);
      serp.searchParams.set('num', String(request.numResults));
      const { data } = await postJson('https://api.brightdata.com/request', {
        url: serp.toString(),
        zone,
        format: 'raw',
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      const organic = typeof data === 'object' && data !== null
        ? ((data as Record<string, unknown>).organic as unknown)
        : undefined;
      if (!Array.isArray(organic)) throw invalidShape('brightdata', label, `unexpected SERP shape for zone ${zone}`, apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of organic) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, (item.link ?? item.url), (item.snippet ?? item.description));
        if (hits.length >= request.numResults) break;
      }
      return finalize('brightdata', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('brightdata', label, error, apiKey);
    }
  },
};

// ── serpbase ──
// Source: serpbase.ts — GET https://api.serpbase.dev/google/search with
// q/num/api_key query params. Response {organic_results|organic|results:
// [{link|url,title,snippet|description}]}.
const serpbaseAdapter: WebAccessAdapter = {
  id: 'serpbase',
  isConfigured: (env) => envKey(env, 'SERPBASE_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'SerpBase API';
    const apiKey = requireKey('serpbase', label, env, 'SERPBASE_API_KEY');
    const options = httpOptions('serpbase', label, apiKey, request.signal);
    try {
      const url = new URL('https://api.serpbase.dev/google/search');
      url.searchParams.set('q', request.query);
      url.searchParams.set('num', String(request.domainFilter?.length ? Math.min(20, request.numResults + 5) : request.numResults));
      url.searchParams.set('api_key', apiKey);
      if (request.recencyFilter !== undefined) url.searchParams.set('tbs', QDR_TBS[request.recencyFilter]);
      const { data } = await getJson(url.toString(), { Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('serpbase', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (typeof envelope.error === 'string' && envelope.error.trim()) {
        throw invalidShape('serpbase', label, envelope.error.trim(), apiKey);
      }
      const organic = envelope.organic_results ?? envelope.organic ?? envelope.results;
      if (!Array.isArray(organic)) throw invalidShape('serpbase', label, 'expected organic_results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of organic as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const urlValue = typeof item.link === 'string' ? item.link : item.url;
        collectHit(hits, request.domainFilter, item.title, urlValue, (item.snippet ?? item.description));
        if (hits.length >= request.numResults) break;
      }
      return finalize('serpbase', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('serpbase', label, error, apiKey);
    }
  },
};

// ── serpapi ──
// Source: serpapi.ts — GET https://serpapi.com/search.json with q/num/tbs
// (qdr map)/api_key query params. Response {organic_results:
// [{link,title,snippet}]}.
const serpapiAdapter: WebAccessAdapter = {
  id: 'serpapi',
  isConfigured: (env) => envKey(env, 'SERPAPI_KEY') !== undefined,
  async search(request, env) {
    const label = 'SerpApi';
    const apiKey = requireKey('serpapi', label, env, 'SERPAPI_KEY');
    const options = httpOptions('serpapi', label, apiKey, request.signal);
    try {
      const url = new URL('https://serpapi.com/search.json');
      url.searchParams.set('q', request.query);
      url.searchParams.set('num', String(request.domainFilter?.length ? Math.min(20, request.numResults + 5) : request.numResults));
      url.searchParams.set('api_key', apiKey);
      if (request.recencyFilter !== undefined) url.searchParams.set('tbs', QDR_TBS[request.recencyFilter]);
      const { data } = await getJson(url.toString(), { Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('serpapi', label, 'expected object envelope', apiKey);
      }
      const organic = (data as Record<string, unknown>).organic_results;
      if (!Array.isArray(organic)) throw invalidShape('serpapi', label, 'expected organic_results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of organic as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.link, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('serpapi', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('serpapi', label, error, apiKey);
    }
  },
};

// ── serper ──
// Source: serper.ts — POST https://google.serper.dev/search, X-API-KEY,
// {q, num, tbs? qdr map}; extra headroom (+5, cap 20) when domainFilter is
// set, then hostname post-filter + slice. Response {organic:
// [{link,title,snippet}]}.
const serperAdapter: WebAccessAdapter = {
  id: 'serper',
  isConfigured: (env) => envKey(env, 'SERPER_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Serper API';
    const apiKey = requireKey('serper', label, env, 'SERPER_API_KEY');
    const options = httpOptions('serper', label, apiKey, request.signal);
    try {
      const count = request.domainFilter?.length ? Math.min(20, request.numResults + 5) : request.numResults;
      const { data } = await postJson('https://google.serper.dev/search', {
        q: request.query,
        num: count,
        ...(request.recencyFilter !== undefined ? { tbs: QDR_TBS[request.recencyFilter] } : {}),
      }, { 'X-API-KEY': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('serper', label, 'expected object envelope', apiKey);
      }
      const organic = (data as Record<string, unknown>).organic;
      if (!Array.isArray(organic)) throw invalidShape('serper', label, 'expected organic array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of organic as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        collectHit(hits, request.domainFilter, item.title, item.link, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('serper', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('serper', label, error, apiKey);
    }
  },
};

// ── valyu ──
// Source: valyu.ts — POST https://api.valyu.ai/v1/search, x-api-key,
// {query, max_num_results, included_sources/excluded_sources,
// start_date: YYYY-MM-DD computed day/week/month/year -> 1/7/30/365 days}.
// Response {success:true, results:[{title,url,description,content}]}.
const valyuAdapter: WebAccessAdapter = {
  id: 'valyu',
  isConfigured: (env) => envKey(env, 'VALYU_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Valyu API';
    const apiKey = requireKey('valyu', label, env, 'VALYU_API_KEY');
    const options = httpOptions('valyu', label, apiKey, request.signal);
    try {
      const included = (request.domainFilter ?? []).filter((d) => !d.startsWith('-'));
      const excluded = (request.domainFilter ?? []).filter((d) => d.startsWith('-')).map((d) => d.slice(1));
      const days = request.recencyFilter !== undefined
        ? ({ day: 1, week: 7, month: 30, year: 365 } as const)[request.recencyFilter]
        : undefined;
      const { data } = await postJson('https://api.valyu.ai/v1/search', {
        query: request.query,
        max_num_results: request.numResults,
        ...(included.length > 0 ? { included_sources: included } : {}),
        ...(excluded.length > 0 ? { excluded_sources: excluded } : {}),
        ...(days !== undefined ? { start_date: new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10) } : {}),
      }, { 'x-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('valyu', label, 'expected object envelope', apiKey);
      }
      const envelope = data as Record<string, unknown>;
      if (envelope.success !== true) throw invalidShape('valyu', label, 'expected success true', apiKey);
      if (!Array.isArray(envelope.results)) throw invalidShape('valyu', label, 'expected results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      const inline: string[] = [];
      for (const row of envelope.results as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const snippet = typeof item.content === 'string' && item.content.trim()
          ? item.content
          : item.description;
        const before = hits.length;
        collectHit(hits, request.domainFilter, item.title, item.url, snippet);
        if (hits.length > before && request.includeContent === true && typeof item.content === 'string' && item.content.trim()) {
          inline.push(item.content.trim());
        }
        if (hits.length >= request.numResults) break;
      }
      return finalize('valyu', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined, inline.join('\n\n') || undefined);
    } catch (error) {
      throw wrapAdapterError('valyu', label, error, apiKey);
    }
  },
};

// ── bocha ──
// Source: bocha.ts — POST https://api.bochaai.com/v1/web-search, Bearer
// BOCHA_API_KEY, {query, count, freshness:
// oneDay/oneWeek/oneMonth/oneYear/noLimit, summary:true}. Response
// {data:{webPages:{value:[{url|link|href, title|name,
// summary|snippet|description|content}]}}}.
const BOCHA_FRESHNESS: Record<WebAccessRecencyFilter, string> = {
  day: 'oneDay',
  week: 'oneWeek',
  month: 'oneMonth',
  year: 'oneYear',
};
const bochaAdapter: WebAccessAdapter = {
  id: 'bocha',
  isConfigured: (env) => envKey(env, 'BOCHA_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'Bocha API';
    const apiKey = requireKey('bocha', label, env, 'BOCHA_API_KEY');
    const options = httpOptions('bocha', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://api.bochaai.com/v1/web-search', {
        query: request.query,
        count: request.numResults,
        freshness: request.recencyFilter !== undefined ? BOCHA_FRESHNESS[request.recencyFilter] : 'noLimit',
        summary: true,
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('bocha', label, 'expected object envelope', apiKey);
      }
      const payload = (data as Record<string, unknown>).data as Record<string, unknown> | undefined;
      const pages = payload?.webPages as Record<string, unknown> | undefined;
      const items = pages?.value;
      if (!Array.isArray(items)) throw invalidShape('bocha', label, 'missing data.webPages.value array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const row of items as unknown[]) {
        if (typeof row !== 'object' || row === null) continue;
        const item = row as Record<string, unknown>;
        const url = firstString(item.url, item.link, item.href);
        if (url === undefined) continue;
        collectHit(
          hits, request.domainFilter,
          firstString(item.title, item.name) ?? url, url,
          firstString(item.summary, item.snippet, item.description, item.content) ?? '',
        );
        if (hits.length >= request.numResults) break;
      }
      return finalize('bocha', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('bocha', label, error, apiKey);
    }
  },
};

// ── xcrawl ──
// Source: xcrawl.ts — POST https://run.xcrawl.com/v1/serp, Bearer
// XCRAWL_API_KEY, {engine:'google_search', q}. Response
// {organic_results:[{title,link,snippet}]}.
const xcrawlAdapter: WebAccessAdapter = {
  id: 'xcrawl',
  isConfigured: (env) => envKey(env, 'XCRAWL_API_KEY') !== undefined,
  async search(request, env) {
    const label = 'XCrawl API';
    const apiKey = requireKey('xcrawl', label, env, 'XCRAWL_API_KEY');
    const options = httpOptions('xcrawl', label, apiKey, request.signal);
    try {
      const { data } = await postJson('https://run.xcrawl.com/v1/serp', {
        engine: 'google_search',
        q: request.query,
      }, { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, options);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw invalidShape('xcrawl', label, 'expected object envelope', apiKey);
      }
      const organic = (data as Record<string, unknown>).organic_results;
      if (!Array.isArray(organic)) throw invalidShape('xcrawl', label, 'expected organic_results array', apiKey);
      const hits: WebAccessSearchHit[] = [];
      for (const [index, row] of (organic as unknown[]).entries()) {
        if (typeof row !== 'object' || row === null) {
          throw invalidShape('xcrawl', label, `expected organic_results[${index}] object`, apiKey);
        }
        const item = row as Record<string, unknown>;
        if (typeof item.link !== 'string' || !item.link.trim()) {
          throw invalidShape('xcrawl', label, `expected organic_results[${index}].link non-empty string`, apiKey);
        }
        collectHit(hits, request.domainFilter, item.title, item.link, item.snippet);
        if (hits.length >= request.numResults) break;
      }
      return finalize('xcrawl', label, apiKey, hits, request.numResults, buildAnswer(hits) || undefined);
    } catch (error) {
      throw wrapAdapterError('xcrawl', label, error, apiKey);
    }
  },
};

export const WEB_ACCESS_ADAPTERS: readonly WebAccessAdapter[] = [
  tavilyAdapter,
  exaAdapter,
  braveAdapter,
  diffbotAdapter,
  firecrawlAdapter,
  jinaAdapter,
  searxngAdapter,
  ollamaSearchAdapter,
  duckduckgoAdapter,
  parallelAdapter,
  parallelMcpAdapter,
  tinyfishAdapter,
  search1apiAdapter,
  searchinfinityAdapter,
  queritAdapter,
  perplexityAdapter,
  geminiAdapter,
  kimiAdapter,
  serpdiveAdapter,
  kagiAdapter,
  anysearchAdapter,
  xaiAdapter,
  mistralAdapter,
  brightdataAdapter,
  serpbaseAdapter,
  serpapiAdapter,
  serperAdapter,
  valyuAdapter,
  bochaAdapter,
  xcrawlAdapter,
];
