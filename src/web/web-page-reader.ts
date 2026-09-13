// Page acquisition seam: readable-page fetch with SSRF-gated fallbacks and
// HTML cleaning. Extracted from src/web.ts; web.ts keeps search/crawl
// orchestration and re-exports the public symbols.
//
// Ordering is security-sensitive: validateHttpUrl + DNS preflight
// (resolvePublicHostname) always run before any network fetch; Diffbot
// Analyze runs only after native/Scrapling exhaustion for eligible failures;
// ordered gated external fetch (Firecrawl/Jina) runs last. Never reorder
// without a security review.

import { fetchText, validateHttpUrl } from '../core/http.js';
import { type DnsLookup, resolvePublicHostname } from '../network-policy.js';
import { ScraplingBridge } from './access/scrapling-bridge.js';
import { analyzePage, createAnalyzeBudget, type AnalyzeBudget } from '../diffbot/diffbot-extract.js';
import { presentPageText } from './web-presentation.js';
import { normalizeGeneratedText } from './web-native-ai.js';
import { firecrawlFetchAdapter } from './providers/firecrawl.js';
import { jinaFetchAdapter } from './providers/jina.js';
import {
  DEFAULT_WEB_FETCH_PROVIDER_TIMEOUT_MS,
  fetchExternalReadablePage,
  isExternalFetchEligible,
} from './web-fetch-providers.js';
import type { WebFetchAdapter, WebGeneratedText } from './web-search-types.js';

export const ALL_FETCH_ADAPTERS: readonly WebFetchAdapter[] = [firecrawlFetchAdapter, jinaFetchAdapter];

export interface ReadablePage {
  url: string;
  title: string;
  content: string;
  rawHtml?: string;
  links?: string[];
  /**
   * Present when page text came from Diffbot Analyze fallback after
   * native/Scrapling exhaustion. Execution-path marker only:
   * qualityImpact is always 'not_assessed' — degraded never implies a
   * content-quality judgment.
   */
  fallback?: { provider: 'diffbot'; path: 'fallback'; qualityImpact: 'not_assessed' } | undefined;
  /**
   * Present when page text came from the gated ordered external fetch
   * (Firecrawl/Jina) after native/Scrapling and Diffbot exhaustion.
   * Execution-path marker only; content quality not assessed. Generated
   * vendor summaries ride `generatedText` separately, never merged into
   * content.
   */
  externalFetch?: { backend: 'firecrawl' | 'jina'; externalProcessing: true } | undefined;
  /** Vendor-generated summary text kept separate from extracted content. */
  generatedText?: WebGeneratedText[] | undefined;
  /** Safe (token-free, 500-char sliced) primary failure that triggered fallback. */
  primaryError?: string | undefined;
}

export interface FetchPageRuntime {
  fetchPageText?: ((url: string, signal?: AbortSignal) => Promise<string>) | undefined;
  env?: Record<string, string | undefined> | undefined;
  /** Shared per-fetch Analyze budget (one instance across a whole crawl). */
  fallbackBudget?: AnalyzeBudget | undefined;
}

/**
 * Failure classes eligible for Diffbot Analyze fallback: network/upstream
 * errors, blocked responses, timeouts, empty/unusable content (handled by the
 * caller). Never: caller abort, policy/input/size/security/contract failures.
 */
export function isDiffbotFallbackEligible(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if ((error as { name?: unknown })?.name === 'DiffbotError') return false;
  const name = (error as { name?: unknown })?.name;
  if (name === 'AbortError') return signal?.aborted ? false : true;
  const message = error instanceof Error ? error.message : String(error);
  if (/Disallowed URL scheme|URL credentials are not allowed|Blocked hostname|Private\/reserved|DNS resolved .* private\/reserved|DNS lookup aborted|credentials are never forwarded|too large|exceeded size|exceeds maximum|out of range|invalid_request|unsupported_action|unsupported_option|cursor_invalid|contract_invalid_response|response_too_large/i.test(message)) {
    return false;
  }
  return true;
}

/**
 * Ordered gated external fetch (Firecrawl/Jina) after native/Scrapling and
 * Diffbot exhaustion. Returns undefined when the original native failure is
 * ineligible, the gate is disabled/misconfigured, or no vendor yields a
 * nonempty page — callers then follow the original error path unchanged.
 */
export async function tryExternalFetch(
  validatedUrl: string,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
  lookup?: DnsLookup,
  primaryError?: unknown,
): Promise<ReadablePage | undefined> {
  const failure = primaryError ?? new Error('native fetch returned no usable content');
  if (!isExternalFetchEligible(failure, signal)) return undefined;
  let result: { page?: { url: string; title: string; content: string; backend: 'firecrawl' | 'jina'; externalProcessing: true; generatedText: WebGeneratedText[] } };
  try {
    result = await fetchExternalReadablePage(
      {
        url: validatedUrl,
        env,
        ...(signal !== undefined ? { signal } : {}),
        ...(lookup !== undefined ? { lookup } : {}),
        timeoutMs: DEFAULT_WEB_FETCH_PROVIDER_TIMEOUT_MS,
      },
      ALL_FETCH_ADAPTERS,
    );
  } catch {
    return undefined;
  }
  if (!result.page) return undefined;
  const generatedText = normalizeGeneratedText(result.page.generatedText);
  const safePrimary = primaryError
    ? (primaryError instanceof Error ? primaryError.message : String(primaryError)).slice(0, 500)
    : undefined;
  return {
    url: result.page.url,
    title: result.page.title,
    content: result.page.content,
    externalFetch: { backend: result.page.backend, externalProcessing: true },
    ...(generatedText.length > 0 ? { generatedText } : {}),
    ...(safePrimary !== undefined ? { primaryError: safePrimary } : {}),
  };
}

export async function fetchReadablePage(
  rawUrl: string,
  signal?: AbortSignal,
  bridge?: ScraplingBridge,
  lookup?: DnsLookup,
  runtime?: FetchPageRuntime,
): Promise<ReadablePage> {
  const trimmed = rawUrl.trim();
  // Test seam: serve HTML without SSRF validation or network. Production
  // never sets fetchPageText, so every real fetch still validates below.
  // The seam also skips Diffbot fallback so tests stay deterministic.
  if (runtime?.fetchPageText) {
    const html = await runtime.fetchPageText(trimmed, signal);

    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
    return { url: trimmed, title, content: stripHtml(html), rawHtml: html };
  }
  const url = validateHttpUrl(rawUrl);
  // DNS preflight: reject hostnames resolving to private/reserved IPs (matches browser path)
  await resolvePublicHostname(new URL(url).hostname, signal, lookup);

  let primaryError: unknown;
  // Analyze eligibility is tracked separately from the plain-fetch attempt:
  // an ineligible bridge/plain failure blocks paid Analyze but never blocks
  // a successful plain fetch. The first ineligible error is rethrown when
  // plain fetch also fails or yields no usable content.
  let analyzeBlockedError: unknown;
  // No behavior without DIFFBOT_TOKEN: legacy path returns bridge/plain
  // results directly with no eligibility gate and no second fetch.
  const envEarly = runtime?.env ?? process.env;
  const hasToken = Boolean(envEarly.DIFFBOT_TOKEN?.trim());
  // Try Scrapling bridge first (if provided and enabled). Empty bridge
  // content counts as unusable and falls through to plain fetch.
  if (bridge) {
    try {
      const result = await bridge.fetch(url);
      // Evidence-boundary validation (not prevention): Scrapling runs in
      // Python and may already have followed redirects before Node sees the
      // result. Validate the returned final URL statically and via DNS with
      // the caller signal/resolver before it can enter evidence; fail closed.
      // A missing bridge URL falls back to the already-validated request URL.
      // Rejections use a fixed boundary message: the validator echoes the URL
      // (including embedded credentials) in its error text.
      let bridgeFinalUrl: string;
      try {
        bridgeFinalUrl = typeof result.url === 'string' && result.url.trim() ? validateHttpUrl(result.url) : url;
      } catch {
        throw new Error('Scrapling bridge returned blocked URL');
      }
      await resolvePublicHostname(new URL(bridgeFinalUrl).hostname, signal, lookup);
      const content = stripHtml(result.content);
      if (content.trim()) {
        const links = Array.isArray(result.links) && result.links.length > 0 ? result.links : undefined;
        return { url: bridgeFinalUrl, title: result.title || '', content, rawHtml: result.content, ...(links ? { links } : {}) };
      }
      if (!hasToken) {
        // No Diffbot token: Analyze skipped, but gated external fetch
        // still runs when the native failure is eligible.
        const noTokenEnv = runtime?.env ?? process.env;
        const external = await tryExternalFetch(url, noTokenEnv, signal, lookup, undefined);
        if (external) return external;
        const links = Array.isArray(result.links) && result.links.length > 0 ? result.links : undefined;
        return { url: bridgeFinalUrl, title: result.title || '', content, rawHtml: result.content, ...(links ? { links } : {}) };
      }
    } catch (error) {
      if (!hasToken) {
        // Legacy no-token path: bridge errors are ignored before plain fetch;
        // a plain-fetch failure below surfaces its own error, never this one.
      } else {
        primaryError ??= error;
        if (!isDiffbotFallbackEligible(error, signal)) analyzeBlockedError ??= error;
      }
      // Fall through to plain fetch in all cases; Analyze eligibility is
      // enforced after plain fetch, not here.
    }
  }

  let plainHtml: string | undefined;
  let plainTitle = '';
  try {
    const html = await fetchText(url, signal ?? {}, signal, undefined, lookup);
    const title = cleanText((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').trim());
    plainHtml = html;
    plainTitle = title;
    const content = stripHtml(html);
    if (content.trim()) return { url, title, content, rawHtml: html };
    // Empty/unusable content: eligible for Analyze fallback (no primary error).
  } catch (error) {
    if (!hasToken) {
      // No Diffbot token: Analyze skipped, but gated external fetch
      // still runs when this failure is eligible (policy/size/404/410/abort fail closed inside).
      const noTokenEnv = runtime?.env ?? process.env;
      const external = await tryExternalFetch(url, noTokenEnv, signal, lookup, error);
      if (external) return external;
      throw error;
    }
    primaryError ??= error;
    if (!isDiffbotFallbackEligible(error, signal)) analyzeBlockedError ??= error;
    if (analyzeBlockedError) throw analyzeBlockedError;
  }
  if (analyzeBlockedError) throw analyzeBlockedError;

  // Diffbot Analyze-GET fallback: recoverable failures only, after
  // native/Scrapling exhaustion. No behavior without DIFFBOT_TOKEN.
  const env = runtime?.env ?? process.env;
  const token = env.DIFFBOT_TOKEN?.trim();
  if (!token) {
    // No Diffbot token: Analyze skipped, but gated external fetch still
    // runs when the native failure is eligible.
    const external = await tryExternalFetch(url, env, signal, lookup, primaryError);
    if (external) return external;
    if (primaryError) throw primaryError;
    const html = plainHtml ?? '';
    const title = plainTitle;
    return { url, title, content: stripHtml(html), rawHtml: html };
  }
  const budget = runtime?.fallbackBudget ?? createAnalyzeBudget(undefined, env);
  if (budget.remaining <= 0) {
    const external = await tryExternalFetch(url, env, signal, lookup, primaryError);
    if (external) return external;
    if (primaryError) throw primaryError;
    return { url, title: '', content: '', rawHtml: '' };
  }
  const safePrimary = primaryError
    ? (primaryError instanceof Error ? primaryError.message : String(primaryError)).slice(0, 500)
    : undefined;
  try {
    const analyzed = await analyzePage(url, {
      token,
      ...(signal !== undefined ? { signal } : {}),
      ...(lookup !== undefined ? { lookup } : {}),
      budget,
    });
    const links = Array.isArray(analyzed.links) && analyzed.links.length > 0 ? analyzed.links : undefined;
    return {
      url: analyzed.url,
      title: analyzed.title || '',
      content: analyzed.content,
      ...(links ? { links } : {}),
      fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed' },
      ...(safePrimary !== undefined ? { primaryError: safePrimary } : {}),
    };
  } catch {
    const external = await tryExternalFetch(url, env, signal, lookup, primaryError);
    if (external) return external;
    if (primaryError) throw primaryError;
    throw new Error('Diffbot Analyze fallback failed and the native fetch returned no usable content');
  }
}

export function stripHtml(html: string): string {
  return cleanText(html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<[^>]+>/g, ' '));
}

export function cleanText(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BoundedPageText {
  text: string;
  shown: string;
  truncated: boolean;
  omittedChars: number;
}

/** Bound page text to maxChars with a visible truncation marker inside budget. */
export function boundPageText(content: string, maxChars: number): BoundedPageText {
  // Fetch-only semantic presentation (block/sentence truncation, nav
  // filtering, link neutralization) lives in src/web-presentation.ts.
  const presented = presentPageText(content, maxChars);
  return { text: presented.text, shown: presented.shown, truncated: presented.truncated, omittedChars: presented.omittedChars };
}
