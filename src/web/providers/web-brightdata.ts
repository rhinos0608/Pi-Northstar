// Bright Data web-search adapter (canonical WebSearchAdapter shape).
// Exact vendor behavior from pinned reference nicobailon/pi-web-access@192ac18
// (brightdata.ts): POST https://api.brightdata.com/request, Bearer
// BRIGHTDATA_API_KEY, body {url: proxied Google SERP URL, zone:
// BRIGHTDATA_SERP_ZONE, format:"raw", data_format:"parsed_light"}. The proxied
// URL carries q, num, tbs qdr map, and brd_json=1 (brd_json=1 is what makes the
// zone return SERP JSON instead of Google HTML). Domain filters become site:
// operators inside the proxied query plus a hostname post-filter. Response
// {organic:[{link,title,description}]}; a billed-200 error envelope is
// invalid_response, never quota. Zone validated before anything billable.
// One request, no retry. Env-only credentials.

import { fetchInit, safeResponseJson } from '../../core/http.js';
import {
  WEB_GENERATED_TEXT_MAX_CHARS,
  type WebProviderSearchInput,
  type WebProviderSearchOutput,
  type WebSearchAdapter,
  type WebSearchHit,
} from '../web-search-types.js';

export const BRIGHTDATA_REQUEST_ENDPOINT = 'https://api.brightdata.com/request';
export const BRIGHTDATA_SEARCH_RESULT_MAX = 20;
export const BRIGHTDATA_ZONE_PATTERN = /^[A-Za-z0-9_-]+$/;
const BRIGHTDATA_TITLE_MAX_CHARS = 500;

const BRIGHTDATA_QDR_TBS = {
  day: 'qdr:d',
  week: 'qdr:w',
  month: 'qdr:m',
  year: 'qdr:y',
} as const;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeDomain(value: string): string | null {
  let input = value.trim().toLowerCase();
  if (!input) return null;
  if (input.startsWith('-')) input = input.slice(1).trim();
  if (!input) return null;
  try {
    const parsed = input.includes('://') ? new URL(input) : new URL(`https://${input}`);
    input = parsed.hostname;
  } catch {
    input = input.split('/')[0]?.split(':')[0] ?? '';
  }
  input = input.replace(/^\.+|\.+$/g, '');
  return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : null;
}

interface BrightDataDomainFilters {
  include: string[];
  exclude: string[];
}

function parseDomainFilter(domains: readonly string[] | undefined): BrightDataDomainFilters {
  const filters: BrightDataDomainFilters = { include: [], exclude: [] };
  for (const raw of domains ?? []) {
    const domain = normalizeDomain(raw);
    if (!domain) continue;
    const target = raw.trim().startsWith('-') ? filters.exclude : filters.include;
    if (!target.includes(domain)) target.push(domain);
  }
  return filters;
}

function domainMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function passesDomainFilters(url: string, filters: BrightDataDomainFilters): boolean {
  if (filters.include.length === 0 && filters.exclude.length === 0) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (filters.exclude.some((domain) => domainMatches(hostname, domain))) return false;
  if (filters.include.length === 0) return true;
  return filters.include.some((domain) => domainMatches(hostname, domain));
}

function buildSearchQuery(query: string, filters: BrightDataDomainFilters): string {
  const parts = [query];
  if (filters.include.length === 1) {
    parts.push(`site:${filters.include[0]}`);
  } else if (filters.include.length > 1) {
    parts.push(`(${filters.include.map((domain) => `site:${domain}`).join(' OR ')})`);
  }
  for (const domain of filters.exclude) {
    parts.push(`-site:${domain}`);
  }
  return parts.join(' ');
}

function errorText(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.split(apiKey).join('[REDACTED]') : message;
}

/** Upstream envelope error detail: scrubbed key, capped, never quota-shaped. */
function envelopeErrorDetail(envelope: Record<string, unknown>, apiKey: string): string | null {
  const parts: string[] = [];
  const { error, errors } = envelope;
  if (typeof error === 'string' && error.trim()) parts.push(error.trim());
  else if (error && typeof error === 'object') parts.push(JSON.stringify(error));
  if (Array.isArray(errors) && errors.length > 0) parts.push(JSON.stringify(errors));
  else if (typeof errors === 'string' && errors.trim()) parts.push(errors.trim());
  if (parts.length === 0) return null;
  for (const key of ['code', 'error_code']) {
    const code = envelope[key];
    if (typeof code === 'string' && code.trim()) parts.push(`${key} ${code.trim()}`);
    else if (typeof code === 'number') parts.push(`${key} ${code}`);
  }
  return errorText(parts.join(', '), apiKey).slice(0, 200);
}

export const brightdataSearchAdapter: WebSearchAdapter = {
  id: 'brightdata',
  configured(env: Record<string, string | undefined>): boolean {
    const apiKey = env.BRIGHTDATA_API_KEY?.trim();
    const zone = env.BRIGHTDATA_SERP_ZONE?.trim();
    return Boolean(apiKey) && Boolean(zone) && BRIGHTDATA_ZONE_PATTERN.test(zone!);
  },
  async search(input: WebProviderSearchInput): Promise<WebProviderSearchOutput> {
    // Zone before key: a config mistake must never reach a billable endpoint.
    const zoneRaw = input.env.BRIGHTDATA_SERP_ZONE?.trim();
    const apiKey = input.env.BRIGHTDATA_API_KEY?.trim();
    if (!apiKey || !zoneRaw) return { backend: 'brightdata', hits: [], generatedText: [] };
    if (!BRIGHTDATA_ZONE_PATTERN.test(zoneRaw)) {
      throw new Error('Bright Data SERP zone is invalid: BRIGHTDATA_SERP_ZONE must be letters, digits, "-", or "_"');
    }
    const zone = zoneRaw;
    const numResults = Math.min(Math.max(Math.floor(input.limit), 1), BRIGHTDATA_SEARCH_RESULT_MAX);
    const filters = parseDomainFilter(input.domains);
    const params = new URLSearchParams({ q: buildSearchQuery(input.query, filters) });
    params.set('num', String(Math.min(numResults + 5, BRIGHTDATA_SEARCH_RESULT_MAX)));
    const tbs = input.recency ? BRIGHTDATA_QDR_TBS[input.recency] : undefined;
    if (tbs) params.set('tbs', tbs);
    params.set('brd_json', '1');
    const validated = fetchInit(
      { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      undefined,
    );
    let response: Response;
    try {
      response = await fetch(BRIGHTDATA_REQUEST_ENDPOINT, {
        method: 'POST',
        body: JSON.stringify({
          url: `https://www.google.com/search?${params.toString()}`,
          zone,
          format: 'raw',
          data_format: 'parsed_light',
        }),
        ...validated,
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        redirect: 'manual',
      });
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(`Bright Data search request failed for zone ${zone}: ${errorText(error, apiKey).slice(0, 300)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Redirect rejected for brightdata search for zone ${zone}`);
    }
    if (!response.ok) throw new Error(`Bright Data search failed with HTTP ${response.status} for zone ${zone}`);
    let data: unknown;
    try {
      data = await safeResponseJson(response, BRIGHTDATA_REQUEST_ENDPOINT);
    } catch (error) {
      if (input.signal?.aborted) throw error;
      throw new Error(
        `Bright Data returned an invalid response for zone ${zone}: ${errorText(error, apiKey).slice(0, 300)}`,
      );
    }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`Bright Data returned an invalid response for zone ${zone}: expected object envelope`);
    }
    const envelope = data as Record<string, unknown>;
    const upstreamError = envelopeErrorDetail(envelope, apiKey);
    if (upstreamError) {
      throw new Error(`Bright Data returned an invalid response for zone ${zone}: ${upstreamError}`);
    }
    if (!Array.isArray(envelope.organic)) {
      throw new Error(`Bright Data returned an invalid response for zone ${zone}: expected organic array`);
    }
    const hits: WebSearchHit[] = [];
    for (const [index, row] of envelope.organic.entries()) {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        throw new Error(`Bright Data returned an invalid response for zone ${zone}: expected organic[${index}] object`);
      }
      const record = row as Record<string, unknown>;
      const urlValue = typeof record.link === 'string' ? record.link.trim() : '';
      if (!urlValue || !isHttpUrl(urlValue) || !passesDomainFilters(urlValue, filters)) continue;
      const titleRaw = typeof record.title === 'string' ? record.title.trim() : '';
      const snippetRaw =
        typeof record.description === 'string' ? record.description.replace(/\s+/g, ' ').trim() : '';
      hits.push({
        title: (titleRaw || 'Untitled').slice(0, BRIGHTDATA_TITLE_MAX_CHARS),
        url: urlValue,
        snippet: snippetRaw.slice(0, WEB_GENERATED_TEXT_MAX_CHARS),
        backend: 'brightdata',
      });
      if (hits.length >= numResults) break;
    }
    return { backend: 'brightdata', hits, generatedText: [] };
  },
};
