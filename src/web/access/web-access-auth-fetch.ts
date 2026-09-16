// Cookie-authenticated page fetch: direct HTTP only, operator profiles only.
//
// A matching profile takes precedence over specialist routing and runs only on
// the direct-HTTP path: the Scrapling bridge, Diffbot Analyze, and gated
// external fetch (Firecrawl/Jina) are never invoked for authenticated URLs
// (T6). Cookies come only from the imported cookie jar via `cookieHeaderForUrl`
// (expiry + ByteString filtered); `cookieAuthEnvironment` is never called here
// (T7, T12 — enforced by test). Redirects are manual, same-origin-only, and
// refused outright instead of falling back to header stripping (T1). Every hop
// re-runs static validation + DNS preflight *before* any cookie is attached
// (T4) and must stay HTTPS (T3). Content scope is HTML + PDF only (D4).
// All errors are fixed strings: no cookie, `Set-Cookie`, or URL echo (T8).

import { cookieHeaderForUrl } from '../../chrome/cookie-jar.js';
import { sanitizeInlineDataUris } from '../../core/data-uri-sanitize.js';
import {
  fetchInit,
  isRedirectStatus,
  safeResponseText,
  validateHttpUrl,
} from '../../core/http.js';
import { resolvePublicHostname, type DnsLookup } from '../../network-policy.js';
import { finalizeNativePage } from '../web-page-reader.js';
import {
  assertAuthFetchUrl,
  authFetchRedirectGuard,
  MAX_AUTH_REDIRECTS,
  type WebAccessAuthProfile,
} from './web-access-auth-contract.js';
import type { DeclaredWebLink } from './declared-web-links.js';
import {
  extractWebAccessPdfText,
  isPdfUrl,
  loadUnpdfExtractor,
  type WebAccessPdfExtractor,
} from './web-access-pdf.js';

export const MAX_AUTH_RESPONSE_BYTES = 1_000_000;
export const AUTH_FETCH_TIMEOUT_MS = 15_000;

export interface AuthFetchSeams {
  env: Record<string, string | undefined>;
  signal?: AbortSignal | undefined;
  lookup?: DnsLookup | undefined;
  maxBytes?: number | undefined;
  /** Test-only fetch override; production uses the global fetch. */
  fetchFn?: ((input: string, init?: RequestInit) => Promise<Response>) | undefined;
  /** Test-only PDF extractor override; production loads unpdf. */
  pdfExtractor?: WebAccessPdfExtractor | undefined;
}

export interface AuthenticatedPage {
  url: string;
  title: string;
  content: string;
  declaredLinks?: DeclaredWebLink[] | undefined;
  extraction?: 'html-strip' | 'rsc-flight' | undefined;
  pdf?: { totalPages: number; truncated: boolean } | undefined;
}

/**
 * Fetch one authenticated readable page. HTML resolves through the shared
 * native finalize (stripHtml + RSC rescue + declared-links appendix) plus the
 * M1 sanitize; PDF resolves through the local-only extractor. Anything else
 * rejects with a fixed content-type message.
 */
export async function fetchAuthenticatedReadablePage(
  rawUrl: string,
  profile: WebAccessAuthProfile,
  seams: AuthFetchSeams,
): Promise<AuthenticatedPage> {
  const maxBytes = boundMaxBytes(seams.maxBytes);
  assertAuthFetchUrl(profile, rawUrl);
  let current = validateHttpUrl(rawUrl);
  await resolvePublicHostname(new URL(current).hostname, seams.signal, seams.lookup);

  const fetchFn = seams.fetchFn ?? ((input: string, init?: RequestInit) => fetch(input, init));
  let redirects = 0;
  for (;;) {
    // Cookie attaches only after this hop passed static + DNS validation.
    const cookie = cookieHeaderForUrl(profile.provider, current, seams.env);
    const headers: Record<string, string> = cookie !== undefined ? { cookie } : {};
    const response = await fetchFn(
      current,
      fetchInit(headers, seams.signal, AUTH_FETCH_TIMEOUT_MS, 'manual'),
    );
    if (isRedirectStatus(response.status)) {
      const location = response.headers.get('location');
      try {
        await response.body?.cancel();
      } catch {
        // Cancel best-effort; the hop is rejected regardless.
      }
      if (!location) throw new Error('authenticated fetch redirect without a valid Location header');
      if (redirects >= MAX_AUTH_REDIRECTS) {
        throw new Error('authenticated fetch exceeded the redirect limit');
      }
      const from = new URL(current);
      let next: string;
      try {
        next = validateHttpUrl(new URL(location, current).href);
      } catch {
        throw new Error('authenticated fetch redirect target rejected');
      }
      if (new URL(next).protocol !== 'https:') {
        throw new Error('authenticated fetch requires HTTPS for every redirect hop');
      }
      try {
        await resolvePublicHostname(new URL(next).hostname, seams.signal, seams.lookup);
      } catch {
        throw new Error('authenticated fetch redirect target blocked');
      }
      authFetchRedirectGuard(profile, from, new URL(next));
      current = next;
      redirects += 1;
      continue;
    }
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Cancel best-effort; the request fails regardless.
      }
      throw new Error(`authenticated fetch request failed with HTTP ${response.status}`);
    }
    return readAuthenticatedBody(response, current, seams, maxBytes);
  }
}

async function readAuthenticatedBody(
  response: Response,
  current: string,
  seams: AuthFetchSeams,
  maxBytes: number,
): Promise<AuthenticatedPage> {
  const announced = response.headers.get('content-length');
  if (announced !== null) {
    const size = Number(announced);
    if (Number.isFinite(size) && size > maxBytes) {
      try {
        await response.body?.cancel();
      } catch {
        // Cancel best-effort.
      }
      throw new Error('authenticated fetch response exceeds the size limit');
    }
  }
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const pdf = mime === 'application/pdf' || (mime === '' && isPdfUrl(current));
  const html = mime === 'text/html' || mime === 'application/xhtml+xml' || (mime === '' && !isPdfUrl(current));
  if (pdf) {
    const bytes = await readBoundedBytes(response, maxBytes);
    const extractor = seams.pdfExtractor ?? (await loadUnpdfExtractor());
    if (!extractor) throw new Error('authenticated PDF extraction is unavailable');
    const pdfText = await extractWebAccessPdfText(bytes, {
      extractor,
      ...(seams.signal !== undefined ? { signal: seams.signal } : {}),
    });
    return {
      url: current,
      title: current.split('/').pop() || current,
      content: pdfText.text,
      pdf: { totalPages: pdfText.totalPages, truncated: pdfText.truncated },
    };
  }
  if (!html) {
    try {
      await response.body?.cancel();
    } catch {
      // Cancel best-effort; the content type rejects regardless.
    }
    throw new Error('authenticated fetch supports HTML and PDF content types only');
  }
  // Fixed label (not the URL): size errors must not echo the target (T8).
  const body = await safeResponseText(response, 'authenticated fetch', maxBytes);
  const title = cleanTitle(body);
  const finalized = finalizeNativePage({ url: current, title, html: body });
  const sanitized = sanitizeInlineDataUris(finalized.content, 'fetch.authenticated.content');
  return {
    url: current,
    title: finalized.title,
    content: sanitized.text,
    ...(finalized.declaredLinks !== undefined ? { declaredLinks: finalized.declaredLinks } : {}),
    ...(finalized.extraction !== undefined ? { extraction: finalized.extraction } : {}),
  };
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error('authenticated fetch response exceeds the size limit');
    return buffer;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // Cancel best-effort.
      }
      throw new Error('authenticated fetch response exceeds the size limit');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function boundMaxBytes(value: number | undefined): number {
  if (value === undefined) return MAX_AUTH_RESPONSE_BYTES;
  if (!Number.isInteger(value) || value <= 0 || value > MAX_AUTH_RESPONSE_BYTES) {
    throw new Error('authenticated fetch byte bound out of range');
  }
  return value;
}

function cleanTitle(html: string): string {
  return (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}
