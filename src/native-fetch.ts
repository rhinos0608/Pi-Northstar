import type { BackendCallResult } from './backend.js';
import { createAnalyzeBudget } from './diffbot/diffbot-extract.js';
import { callGithubTool } from './github/github-domain.js';
import { parseGithubIssuePrFetchUrl } from './github/github-issue-pr-url.js';
import { northstarTextResult, textResult } from './core/tool-output.js';
import { callReachTool } from './reach-tools.js';
import { isYoutubeFetchVideoUrl } from './media-vision/frame-extract.js';
import { runFetchVideoAnalysis } from './media-vision/video-analysis.js';
import { isVideoSynthesisConfigured } from './media-vision/video-synthesis.js';
import { ScraplingBridge } from './web/access/scrapling-bridge.js';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from './web/access/web-access-content-store.js';
import { WEB_ACCESS_RETRIEVAL_MAX_CHARS, parseWebAccessFetchRequest, WebAccessContractError, type WebAccessProviderId, type WebAccessQueryResult } from './web/access/web-access-contract.js';
import { retrieveWebAccessCorpus } from './web/access/web-access-retrieve.js';
import { runWebAccessCachedSourceCheck } from './web/access/web-access-cached-source-check.js';
import { formatWebAccessSourceCheck } from './web/access/web-access-presentation.js';
import { isPdfUrl, extractWebAccessPdfText, loadUnpdfExtractor, WEB_ACCESS_PDF_MAX_BYTES } from './web/access/web-access-pdf.js';
import { pdfSparsePageWarnings } from './web/access/web-access-pdf-diagnostics.js';
import { describeFetchedImage, fetchRemoteImage, isImageUrl } from './web/access/web-access-image.js';
import { selectWebAccessReaderKind } from './web/access/web-access-specialization.js';
import { validateHttpUrl } from './core/http.js';
import { sanitizeInlineDataUris } from './core/data-uri-sanitize.js';
import { parseWebAccessAuthProfiles, resolveAuthProfileForUrl, type WebAccessAuthProfile } from './web/access/web-access-auth-contract.js';
import { resolvePublicHostname } from './network-policy.js';
import { buildNorthstarResult, parseEntity } from './result-contract.js';
import { validateWebRequest, WEB_ENTITY_CONTENT_MAX } from './web/web-contract.js';
import {
  boundPageText,
  fetchReadablePage,
  requireString,
  semanticCrawl,
  siteMapFetch,
  wordCount,
  type WebToolOptions,
} from './web/web.js';

export interface NativeFetchOptions extends WebToolOptions {}

const webAccessStore = createWebAccessContentStore();

export function getNativeFetchStore(): ReturnType<typeof createWebAccessContentStore> {
  return webAccessStore;
}

export function snippetOf(body: string): string {
  return body.slice(0, 500);
}

/**
 * Truncate text to a UTF-8 byte bound without splitting a code point.
 * Cache/envelope paths bound bytes (admission accounts UTF-8), never
 * UTF-16 code units.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

export function resultToSingleText(result: BackendCallResult): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
  }
  return '';
}

export function withFetchResponseId(result: BackendCallResult, responseId: string | undefined): BackendCallResult {
  if (responseId === undefined) return result;
  const details = (result as { details?: Record<string, unknown> }).details;
  if (details !== undefined && typeof details === 'object' && details !== null && typeof (details as { responseId?: unknown }).responseId === 'string') {
    return result;
  }
  return { ...result, details: { ...(typeof details === 'object' && details !== null ? details : {}), responseId } };
}

export function cacheWebSearchForRetrieve(query: string, hits: Array<{ title: string; url: string; snippet?: string; backend?: string }>): string | undefined {
  try {
    const trimmed = query.trim();
    if (!trimmed || hits.length === 0) return undefined;
    const byProvider = new Map<string, Array<{ title: string; url: string; snippet: string }>>();
    for (const hit of hits) {
      if (typeof hit.url !== 'string' || !hit.url) continue;
      const provider = typeof hit.backend === 'string' && hit.backend.length > 0 ? hit.backend : 'parallel';
      const list = byProvider.get(provider) ?? [];
      list.push({ title: typeof hit.title === 'string' ? hit.title : hit.url, url: hit.url, snippet: typeof hit.snippet === 'string' ? hit.snippet : '' });
      byProvider.set(provider, list);
    }
    if (byProvider.size === 0) return undefined;
    const results: WebAccessQueryResult[] = [...byProvider].map(([provider, results], index) => ({
      queryIndex: index,
      query: trimmed,
      response: { provider: provider as WebAccessProviderId, results },
    }));
    const entry = buildWebAccessStoredEntry({ queries: [trimmed], results });
    webAccessStore.put(entry);
    return entry.responseId;
  } catch {
    return undefined;
  }
}

// Fetch cache population: normal-fetch results (read/crawl/urls/pdf) are
// stored as single-query corpus entries so action retrieve/source_check can
// serve them cache-only. Best-effort: never throws, returns undefined when
// there is nothing worth caching.
export function cacheFetchEntries(
  query: string,
  entries: Array<{ title: string; url: string; snippet: string; content: string }>,
): string | undefined {
  try {
    const trimmed = query.trim();
    if (!trimmed || entries.length === 0) return undefined;
    const usable = entries.filter((e) => typeof e.url === 'string' && e.url.length > 0 && typeof e.content === 'string' && e.content.length > 0);
    if (usable.length === 0) return undefined;
    const results: WebAccessQueryResult[] = usable.map((entry, index) => ({
      queryIndex: index,
      query: trimmed,
      response: {
          provider: 'parallel',
          results: [{
            title: entry.title || entry.url,
            url: entry.url,
            snippet: truncateUtf8Bytes(entry.snippet, 500),
          }],
          inlineContent: truncateUtf8Bytes(entry.content, WEB_ACCESS_RETRIEVAL_MAX_CHARS),
        },
    }));
    const stored = buildWebAccessStoredEntry({ queries: [trimmed], results });
    webAccessStore.put(stored);
    return stored.responseId;
  } catch {
    return undefined;
  }
}

export function cacheFetchForRetrieve(input: { query: string; title: string; url: string; snippet: string; content: string }): string | undefined {
  return cacheFetchEntries(input.query, [{ title: input.title, url: input.url, snippet: input.snippet, content: input.content }]);
}

// Map a github.com URL onto the existing github tool. Repo roots and
// blob/tree paths map via parseGithubFetchUrl; issues/pulls map via
// parseGithubIssuePrFetchUrl onto the issues/pulls actions with `number`
// (top-level comments ride the entity body, capped at 50). PR
// files/commits/checks subpaths decline here so the page reader serves them
// (checks/changed-files/commits rendering stays deferred); `conversation`
// subpaths and comment anchors route to the tool. Validation rejects
// ambiguous refs (e.g. branch names containing slashes); callers fall
// through on any throw.
export function parseGithubFetchUrl(raw: string): Record<string, unknown> | undefined {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  // Leading `www.` is stripped before host validation so www.github.com
  // routes exactly like github.com (consistent with parseGithubIssuePrFetchUrl).
  if (parsed.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '') !== 'github.com') return undefined;
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs.length < 2) return undefined;
  const owner = segs[0]!;
  const repo = segs[1]!.replace(/\.git$/, '');
  if (!owner || !repo) return undefined;
  if (segs.length === 2) return { action: 'repo', owner, repo };
  const kind = segs[2];
  if ((kind === 'blob' || kind === 'tree') && segs.length >= 5) {
    const ref = segs[3];
    const path = segs.slice(4).join('/');
    if (!ref || !path) return undefined;
    return kind === 'blob'
      ? { action: 'file', owner, repo, path, ref }
      : { action: 'tree', owner, repo, path, ref };
  }
  return undefined;
}

async function tryGithubUrlFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  try {
    const input = parseGithubFetchUrl(url);
    if (input) {
      return await callGithubTool(input, {
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    }
  } catch {
    return undefined;
  }
  try {
    const pr = parseGithubIssuePrFetchUrl(url);
    if (!pr) return undefined;
    // Deferred-render subpaths fall through to the page reader.
    if (pr.subpath !== undefined && pr.subpath !== 'conversation') return undefined;
    const result = await callGithubTool(
      { action: pr.kind === 'pull' ? 'pulls' : 'issues', owner: pr.owner, repo: pr.repo, number: pr.number },
      {
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    // M5: surface the parsed URL fragment as an output note. The anchor is
    // an id fragment only — never a raw URL part — so it is safe to include.
    if (pr.anchor === undefined) return result;
    const details =
      result.details !== undefined && typeof result.details === 'object' && result.details !== null
        ? (result.details as Record<string, unknown>)
        : {};
    return {
      ...result,
      details: {
        ...details,
        anchor: pr.anchor,
        anchorNote: `Linked section #${pr.anchor}: comments ride the issue/PR body above; deep-scroll to the fragment for full context.`,
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * M8 media route: unchanged transcript-via-media-tool behavior unless a
 * YouTube watch/shorts URL arrives with video analysis opted in (exact-'1'
 * PI_VISION_FETCH_VIDEO_FRAMES or a configured synthesis tier). The analysis
 * envelope carries transcript text as content; keyframe evidence counts and
 * optional synthesis ride details.generatedText-style separation and are
 * never merged into content. Any analysis failure falls back to the plain
 * media result. Never runs on auth hosts (dispatchSpecializedUrl yields
 * first) and never touches local files (D1).
 */
async function tryMediaUrlFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  const env = options.env ?? process.env;
  if (
    isYoutubeFetchVideoUrl(url) &&
    (env.PI_VISION_FETCH_VIDEO_FRAMES === '1' || isVideoSynthesisConfigured(env))
  ) {
    try {
      const analysis = await runFetchVideoAnalysis(url, {
        env,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      if (analysis.text.trim().length > 0) {
        // M1: sanitize at source — the clean text is cached and returned
        // (sanitization is idempotent with the dispatchFetch choke point).
        const cleanAnalysis = sanitizeInlineDataUris(analysis.text, 'fetch.media.analysis').text;
        return withFetchResponseId(
          textResult(cleanAnalysis, {
            url,
            video: {
              keyframes: analysis.keyframes,
              synthesized: analysis.synthesized,
              ...(analysis.synthesis !== undefined ? { synthesisModel: analysis.synthesis.model } : {}),
            },
            ...(analysis.degraded
              ? {
                degraded: true,
                note: 'Keyframes were requested but unavailable; transcript and metadata only.',
              }
              : {}),
            ...(analysis.synthesis !== undefined
              ? {
                generatedText: [
                  {
                    kind: 'video-synthesis',
                    model: analysis.synthesis.model,
                    text: analysis.synthesis.text,
                  },
                ],
              }
              : {}),
            warnings: analysis.warnings,
          }),
          cacheFetchForRetrieve({
            query: url,
            title: url,
            url,
            snippet: snippetOf(cleanAnalysis),
            content: cleanAnalysis,
          }),
        );
      }
    } catch {
      // Fall through to the plain media result below.
    }
  }
  try {
    return await callReachTool('video', { url }, options);
  } catch {
    return undefined;
  }
}

async function tryFeedUrlFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  try {
    return await callReachTool('feeds', { url }, options);
  } catch {
    return undefined;
  }
}

/**
 * Remote-image specialist (M4): extension-gated, magic-byte verified,
 * metadata-only by default. Never runs on github/media/feed/pdf URLs (the
 * dispatcher only calls it for `page` kinds) and never on an authenticated
 * fetch (no auth path exists in this dispatcher). Any failure returns
 * undefined so the page reader keeps current behavior. Described text rides
 * details.generatedText separately (labeled with the vision tier), never
 * merged into content.
 */
async function tryRemoteImageFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  try {
    if (!isImageUrl(url)) return undefined;
    const image = await fetchRemoteImage(url, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.lookup !== undefined ? { lookup: options.lookup } : {}),
    });
    const described = await describeFetchedImage(image.bytes, image.mime, options.env ?? process.env);
    const dims = image.width !== undefined && image.height !== undefined ? `, ${image.width}x${image.height}` : '';
    return textResult(`Image fetched (${image.mime}${dims}, ${image.bytes.byteLength} bytes)`, {
      url,
      image: {
        mime: image.mime,
        bytes: image.bytes.byteLength,
        ...(image.width !== undefined ? { width: image.width } : {}),
        ...(image.height !== undefined ? { height: image.height } : {}),
        ...(image.pixels !== undefined ? { pixels: image.pixels } : {}),
      },
      ...(described !== undefined
        ? { generatedText: [{ kind: 'image-description', tier: described.tier, text: described.text }] }
        : {}),
    });
  } catch {
    return undefined;
  }
}

async function tryLocalPdfFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  try {
    if (!isPdfUrl(url)) return undefined;
    const extractor = await loadUnpdfExtractor();
    if (!extractor) return undefined;
    const validated = validateHttpUrl(url);
    await resolvePublicHostname(new URL(validated).hostname, options.signal, options.lookup);
    // SSRF redirect discipline: manual redirects with static + DNS preflight
    // on every hop (same pattern as http.ts fetchFollowingRedirects). A 30x
    // to a private/metadata target fails closed before any byte is fetched.
    let response: Response | undefined;
    let current = validated;
    for (let hop = 0; hop <= 10; hop++) {
      const hopResponse = await fetch(current, { redirect: "manual", ...(options.signal ? { signal: options.signal } : {}) });
      if (hopResponse.status < 300 || hopResponse.status >= 400) {
        response = hopResponse;
        break;
      }
      const location = hopResponse.headers.get("location");
      try { await hopResponse.body?.cancel(); } catch { /* cancel best-effort */ }
      if (!location || hop >= 10) return undefined;
      let next: string;
      try {
        next = validateHttpUrl(new URL(location, current).href);
      } catch {
        return undefined;
      }
      try {
        await resolvePublicHostname(new URL(next).hostname, options.signal, options.lookup);
      } catch {
        return undefined;
      }
      current = next;
    }
    if (!response || !response.ok) {
      if (response) { try { await response.body?.cancel(); } catch { /* cancel best-effort */ } }
      return undefined;
    }
    const announced = response.headers.get('content-length');
    if (announced !== null) {
      const size = Number(announced);
      if (Number.isFinite(size) && size > WEB_ACCESS_PDF_MAX_BYTES) {
        try { await response.body?.cancel(); } catch { /* cancel best-effort */ }
        return undefined;
      }
    }
    let buffer: Uint8Array;
    if (response.body !== null) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > WEB_ACCESS_PDF_MAX_BYTES) {
          try { await reader.cancel(); } catch { /* cancel best-effort */ }
          return undefined;
        }
        chunks.push(value);
      }
      buffer = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, at);
        at += chunk.byteLength;
      }
    } else {
      buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > WEB_ACCESS_PDF_MAX_BYTES) return undefined;
    }
    if (buffer.byteLength > WEB_ACCESS_PDF_MAX_BYTES) return undefined;
    // unpdf takes ownership of (detaches) the input buffer on parse, so the
    // M6 diagnostics below run on a copy made before extraction consumes it.
    const diagnosticBytes = buffer.slice();
    const pdf = await extractWebAccessPdfText(buffer, { extractor, ...(options.signal ? { signal: options.signal } : {}) });
    // M6: honest scanned-page degradation from the local-only path (no
    // vision seam, so no cloud render can trigger). Diagnostics failure never
    // fails the fetch: the extracted text stands undegraded.
    let degradedNote: string | undefined;
    let pdfWarnings: string[] | undefined;
    try {
      const diagnostics = await pdfSparsePageWarnings(diagnosticBytes, extractor, options.signal);
      if (diagnostics.warnings.length > 0) pdfWarnings = diagnostics.warnings;
      if (diagnostics.warnings.some((warning) => warning.includes('possibly-scanned-no-vision'))) {
        degradedNote =
          'Scanned pages yielded little local text; OCR/vision escalation is not enabled for fetch (local-only PDF policy).';
      }
    } catch {
      // Diagnostics never fail the fetch; extracted text stands as-is.
    }
    // M1: sanitize at source — clean text is cached and returned; the
    // snippet derives from sanitized text (idempotent with choke point).
    const cleanPdf = sanitizeInlineDataUris(pdf.text, 'fetch.pdf.text').text;
    return withFetchResponseId(
      textResult(cleanPdf, {
        url,
        ...(degradedNote !== undefined ? { degraded: true, note: degradedNote } : {}),
        pdf: {
          totalPages: pdf.totalPages,
          truncated: pdf.truncated,
          citations: pdf.citations,
          ...(pdfWarnings !== undefined ? { warnings: pdfWarnings } : {}),
        },
      }),
      cacheFetchForRetrieve({
        query: url,
        title: url.split('/').pop() || url,
        url,
        snippet: snippetOf(cleanPdf),
        content: cleanPdf,
      }),
    );
  } catch {
    return undefined;
  }
}

export async function dispatchSpecializedUrl(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  // M7 precedence: a matching auth profile owns the host, so every
  // specialist yields (the image branch must never run authenticated).
  // Falls through to the authenticated reader in agenticBrowseInner.
  if (resolveAuthProfileForUrl(url, parseWebAccessAuthProfiles(options.env ?? process.env))) return undefined;
  const kind = selectWebAccessReaderKind(url);
  if (kind === 'pdf') return tryLocalPdfFetch(url, options);
  if (kind === 'github') return tryGithubUrlFetch(url, options);
  if (kind === 'media') return tryMediaUrlFetch(url, options);
  if (kind === 'feed') return tryFeedUrlFetch(url, options);
  // Image sniff runs only for plain pages: github/media/feed/pdf precedence
  // above is untouched. tryRemoteImageFetch fails closed to undefined.
  return tryRemoteImageFetch(url, options);
}

/**
 * Model-visible browse entry: same M1 sanitize choke point as dispatchFetch
 * (shared sanitizeFetchResultText wrapper, not a duplicate). The `browse`
 * tool routes here directly, bypassing dispatchFetch.
 */
export async function agenticBrowse(args: Record<string, unknown>, options: NativeFetchOptions): Promise<BackendCallResult> {
  return sanitizeFetchResultText(await agenticBrowseInner(args, options));
}

/**
 * M7 authenticated read: direct HTTP with profile cookies, never the bridge,
 * Diffbot, or external fetch. Caches only when the profile opts into
 * `cache: 'session'` (T5); the envelope carries `details.authFetch` with the
 * profile name only (T8).
 */
async function agenticBrowseAuthenticated(
  url: string,
  profile: WebAccessAuthProfile,
  options: NativeFetchOptions,
  env: Record<string, string | undefined>,
  maxChars: number,
): Promise<BackendCallResult> {
  const page = await fetchReadablePage(url, options.signal, undefined, options.lookup, {
    env,
    authFetch: { profile, cachePolicy: profile.cache },
  });
  const bounded = boundPageText(page.content, maxChars);
  // M1: sanitize at source — clean text is cached and returned (idempotent
  // with the agenticBrowse choke point).
  const content = sanitizeInlineDataUris(bounded.text, 'fetch.auth.content').text;
  const parsed = parseEntity(
    { id: page.url, url: page.url, title: page.title, snippet: truncateUtf8Bytes(content, WEB_ENTITY_CONTENT_MAX), source: 'web' },
    { source: 'web', kind: 'article' },
  );
  const envelope = buildNorthstarResult({
    request: { tool: 'agentic_browse', channel: 'web', action: 'read' },
    outcomes: [{ source: 'web', backend: 'native-fetch', entities: parsed.ok ? [parsed.entity] : [] }],
    pagination: { supported: false, limit: 1, hasMore: false },
  });
  const responseId = profile.cache === 'session'
    ? cacheFetchForRetrieve({ query: url, title: page.title, url: page.url, snippet: content.slice(0, 500), content })
    : undefined;
  return northstarTextResult(content, {
    url: page.url,
    title: page.title,
    content,
    ...(responseId !== undefined ? { responseId } : {}),
    wordCount: wordCount(content),
    truncated: bounded.truncated,
    maxChars,
    omittedChars: bounded.omittedChars,
    ...(page.declaredLinks !== undefined ? { declaredLinks: page.declaredLinks.length } : {}),
    ...(page.extraction !== undefined ? { extraction: page.extraction } : {}),
    authFetch: { profile: profile.name, cachePolicy: profile.cache, externalProcessing: false },
  }, envelope);
}

async function agenticBrowseInner(args: Record<string, unknown>, options: NativeFetchOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'read';
  if (action !== 'read' && action !== 'browse') {
    throw new Error(`Native agentic_browse only supports read and browse actions, got: ${action}`);
  }

  const url = requireString(args.url, 'url');
  // Contract validation before dispatch: maxChars honored with
  // reject-on-out-of-range (same bound as the crawl path).
  const readInput: { action: string; url?: string; maxChars?: number } = { action: 'read', url };
  if (typeof args.maxChars === 'number') readInput.maxChars = args.maxChars;
  const { request } = validateWebRequest(readInput);
  const maxChars = request.maxChars;

  // Try Scrapling bridge if available (auto-detect)
  let bridge: ScraplingBridge | undefined;
  try {
    bridge = new ScraplingBridge({
      fetcher: 'stealthy',
      solveCloudflare: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env?.PI_SEARCH_SCRAPLING_PROXY ? { proxy: options.env.PI_SEARCH_SCRAPLING_PROXY } : {}),
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
  } catch { /* use fallback */ }

  // Direct reads share the per-fetch Diffbot Analyze context (env + budget)
  // with the crawl path; fetchReadablePage stays token-free without DIFFBOT_TOKEN.
  const readEnv = options.env ?? process.env;
  const readRuntime = {
    ...(options.fetchPageText ? { fetchPageText: options.fetchPageText } : {}),
    env: readEnv,
    ...(readEnv.DIFFBOT_TOKEN?.trim() ? { fallbackBudget: createAnalyzeBudget(undefined, readEnv) } : {}),
  };
  // M7: a matching auth profile takes the authenticated reader (direct HTTP
  // with profile cookies). The fetchPageText test seam, bridge, Diffbot, and
  // external fetch are skipped by construction: the auth runtime carries no
  // seam and the page reader honors authFetch first.
  const authProfile = resolveAuthProfileForUrl(url, parseWebAccessAuthProfiles(readEnv));
  if (authProfile) {
    return agenticBrowseAuthenticated(url, authProfile, options, readEnv, maxChars);
  }
  try {
    const page = await fetchReadablePage(
      url,
      options.signal,
      bridge,
      options.lookup,
      readRuntime,
    );
    const bounded = boundPageText(page.content, maxChars);
    // M1: sanitize at source — clean text is cached and returned; the snippet
    // derives from sanitized text (idempotent with the choke point).
    const content = sanitizeInlineDataUris(bounded.text, 'fetch.read.content').text;
    const parsed = parseEntity(
      { id: page.url, url: page.url, title: page.title, snippet: truncateUtf8Bytes(content, WEB_ENTITY_CONTENT_MAX), source: 'web' },
      { source: 'web', kind: 'article' },
    );
    // Execution-fallback markers (not quality judgments): Diffbot Analyze
    // text or gated external fetch (Firecrawl/Jina) after native exhaustion
    // degrades the envelope, matching the crawl path. Vendor-generated
    // summaries ride details.generatedText separately, never merged into
    // content; external processing is always labeled.
    const fallbackUsed = page.fallback !== undefined;
    const externalUsed = page.externalFetch !== undefined;
    const degradedRead = fallbackUsed || externalUsed;
    const envelope = buildNorthstarResult({
      request: { tool: 'agentic_browse', channel: 'web', action: 'read' },
      outcomes: [{ source: 'web', backend: 'native-fetch', ...(degradedRead ? { degraded: true } : {}), entities: parsed.ok ? [parsed.entity] : [] }],
      pagination: { supported: false, limit: 1, hasMore: false },
      ...(fallbackUsed
        ? { notes: ['Diffbot Analyze fallback supplied page text after native fetch exhaustion; content quality not assessed.'] }
        : {}),
      ...(externalUsed
        ? { notes: ['Ordered external fetch supplied page text after native fetch exhaustion; content quality not assessed; external processing applied.'] }
        : {}),
    });
    // Read results populate the retrieve cache best-effort (never throws).
    const readResponseId = cacheFetchForRetrieve({
      query: url,
      title: page.title || page.url,
      url: page.url,
      snippet: snippetOf(content),
      content,
    });
    return northstarTextResult(content, {
      url: page.url,
      title: page.title,
      content,
      ...(readResponseId !== undefined ? { responseId: readResponseId } : {}),
      wordCount: wordCount(content),
      truncated: bounded.truncated,
      maxChars,
      omittedChars: bounded.omittedChars,
      // M2/M3 envelope signals (counts/labels only, never content duplication).
      ...(page.declaredLinks !== undefined ? { declaredLinks: page.declaredLinks.length } : {}),
      ...(page.extraction !== undefined ? { extraction: page.extraction } : {}),
      ...(fallbackUsed
        ? { fallback: { provider: 'diffbot', path: 'fallback', qualityImpact: 'not_assessed', ...(page.primaryError !== undefined ? { primaryFailure: page.primaryError } : {}) } }
        : {}),
      ...(externalUsed
        ? {
          externalFetch: {
            backend: page.externalFetch!.backend,
            externalProcessing: true as const,
            qualityImpact: 'not_assessed' as const,
            ...(page.primaryError !== undefined ? { primaryFailure: page.primaryError } : {}),
          },
        }
        : {}),
      ...(externalUsed && page.generatedText !== undefined && page.generatedText.length > 0
        ? { generatedText: page.generatedText }
        : {}),
    }, envelope);
  } finally {
    if (bridge) await bridge.close();
  }
}

export async function dispatchFetch(args: Record<string, unknown>, options: NativeFetchOptions): Promise<BackendCallResult> {
  return sanitizeFetchResultText(await dispatchFetchInner(args, options));
}

/**
 * Model-visible fetch choke point (M1): every BackendCallResult leaving
 * dispatchFetch gets inline `data:` URIs replaced in `content` text only.
 * `details` envelopes (citations, counts) are never touched; thumbnails
 * and frames are untouched by construction (no such fields exist here).
 */
function sanitizeFetchResultText(result: BackendCallResult): BackendCallResult {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (!Array.isArray(content)) return result;
  let changed = false;
  const sanitized = content.map((item, index) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return item;
    const out = sanitizeInlineDataUris(item.text, `fetch.content[${index}]`);
    if (out.omissions.length === 0) return item;
    changed = true;
    return { ...item, text: out.text };
  });
  return changed ? { ...result, content: sanitized } : result;
}

async function dispatchFetchInner(args: Record<string, unknown>, options: NativeFetchOptions): Promise<BackendCallResult> {
  // No hidden controls: provider selection is operator-only
  // (PI_SEARCH_WEB_BACKENDS) and format does not exist as fetch input.
  if (args.provider !== undefined) {
    throw new Error('provider selection is operator-only (PI_SEARCH_WEB_BACKENDS); omit provider');
  }
  if (args.format !== undefined) {
    throw new Error('format is not a supported fetch field');
  }
  // FINAL discriminated fetch: retrieve/source_check served from the
  // bounded memory cache only (no network). Presence-based union routing:
  // claims selects claim-check, responseId selects retrieve. Validation via
  // the shared contract; unknown responseIds throw ContractError with
  // re-run guidance.
  if (args.responseId !== undefined || args.claims !== undefined) {
    const parsed = parseWebAccessFetchRequest(args);
    if (parsed && typeof (parsed as { action?: string }).action === 'string') {
      const kind = (parsed as { action: string }).action;
      if (kind === 'retrieve') {
        const req = parsed as { responseId: string; sourceIds?: string[]; offset?: number; limit?: number; findText?: string };
        try {
          const out = retrieveWebAccessCorpus(webAccessStore, req);
          return textResult(out.text, { action: 'retrieve', responseId: out.responseId, sources: out.sources, ...(out.matches !== undefined ? { matches: out.matches } : {}), ...(out.nextOffset !== undefined ? { nextOffset: out.nextOffset } : {}) });
        } catch (error) {
          if (error instanceof WebAccessContractError) throw new Error(error.message);
          throw error;
        }
      }
      const req = parsed as { responseId: string; claims: string[]; sourceIds?: string[] };
      try {
        const artifact = runWebAccessCachedSourceCheck(webAccessStore, req);
        return textResult(formatWebAccessSourceCheck(artifact as Parameters<typeof formatWebAccessSourceCheck>[0], null), { action: 'source_check', artifact });
      } catch (error) {
        if (error instanceof WebAccessContractError) throw new Error(error.message);
        throw error;
      }
    }
  }
  // Sitemap mode intercepts before read/crawl routing: strict boolean,
  // combos rejected inside siteMapFetch before any dispatch.
  if (args.siteMap !== undefined) {
    if (typeof args.siteMap !== 'boolean') throw new Error('siteMap must be a boolean');
    if (args.siteMap) return siteMapFetch(args, options);
  }
  // URL-array fetch: sequential readable reads in input order.
  if (Array.isArray(args.urls)) {
    // Defense-in-depth: forward the full url-array surface so contract
    // validation (urls readable-only, no followLinks/sitemap) also holds on
    // the direct callNativeTool path, not just the schema route.
    const parsed = parseWebAccessFetchRequest({ ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(typeof args.url === 'string' ? { url: args.url } : {}), urls: args.urls, ...(typeof args.topK === 'number' ? { topK: args.topK } : {}), ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}), ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}), ...(args.followLinks !== undefined ? { followLinks: args.followLinks } : {}), ...(args.siteMap !== undefined ? { siteMap: args.siteMap } : {}) });
    void parsed;
    // urls + query honors the passage selector per URL: each URL is read
    // through the chunk-ranking crawl (same engine as singular url+query),
    // not returned as full text. Per-URL isolation: one failure becomes
    // an error entry, never an aborted array that loses prior results.
    const withQuery = typeof args.query === 'string' && args.query.trim().length > 0;
    const out: string[] = [];
    const cached: Array<{ title: string; url: string; snippet: string; content: string }> = [];
    // M7: auth-off entries never reach the retrieve cache (T5). A config
    // parse error falls back to cacheable: the fetch itself surfaces it.
    const arrayAuthCacheable = (entryUrl: string): boolean => {
      try {
        return resolveAuthProfileForUrl(entryUrl, parseWebAccessAuthProfiles(options.env ?? process.env))?.cache !== 'off';
      } catch {
        return true;
      }
    };
    for (const url of args.urls as unknown[]) {
      const single = String(url);
      try {
        if (withQuery) {
          // M7 (T5/T6): an auth-host URL skips semanticCrawl entirely (no
          // bridge/Diffbot/external processing on auth hosts); it routes
          // through agenticBrowseInner, which already carries the authFetch
          // seam and owns the session-only cache gate.
          let entryIsAuth = false;
          try {
            entryIsAuth =
              resolveAuthProfileForUrl(single, parseWebAccessAuthProfiles(options.env ?? process.env)) !== undefined;
          } catch {
            entryIsAuth = false;
          }
          if (entryIsAuth) {
            const authResult = await agenticBrowseInner({ url: single, ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}) }, options);
            const authBody = resultToSingleText(authResult);
            out.push(`## ${single}\n${authBody}`);
            if (arrayAuthCacheable(single)) {
              cached.push({ title: single, url: single, snippet: snippetOf(authBody), content: authBody });
            }
          } else {
          const chunked = await semanticCrawl({
            source: { type: 'url', url: single },
            query: args.query,
            ...(typeof args.topK === 'number' ? { topK: args.topK } : {}),
            ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}),
            ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
          }, options);
          // M1: sanitize at source — clean text is cached and returned.
          const body = sanitizeInlineDataUris(resultToSingleText(chunked), 'fetch.query.content').text;
          out.push(`## ${single}\n${body}`);
          if (arrayAuthCacheable(single)) {
            cached.push({ title: single, url: single, snippet: snippetOf(body), content: body });
          }
          }
        } else {
          const specialized = await dispatchSpecializedUrl(single, options);
          const singleResult = specialized ?? await agenticBrowseInner({ url: single, ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}) }, options);
          const body = sanitizeInlineDataUris(resultToSingleText(singleResult), 'fetch.read.content').text;
          out.push(body);
          if (arrayAuthCacheable(single)) {
            cached.push({ title: single, url: single, snippet: snippetOf(body), content: body });
          }
        }
      } catch (error) {
        out.push(`## ${single}\nError: ${String(error instanceof Error ? error.message : error).slice(0, 500)}`);
      }
    }
    const arrayQuery = withQuery && typeof args.query === 'string' ? args.query.trim() : 'fetch';
    return withFetchResponseId(
      textResult(out.join('\n\n'), { urls: args.urls }),
      cacheFetchEntries(arrayQuery, cached),
    );
  }
  // Internal specialization: query-less singular urls route through the
  // existing subsystems (local unpdf for PDF, github tool for repo/blob
  // urls, media tool for video urls, feeds tool for RSS/Atom urls).
  // Every specialist fails closed to undefined so unsupported shapes
  // fall through to the page reader. No format/provider input exists.
  if (typeof args.url === 'string' && args.query === undefined && args.searchQuery === undefined) {
    const specialized = await dispatchSpecializedUrl(args.url, options);
    if (specialized) return specialized;
  }
  // Singular fetch with a query ranks page chunks via the same chunk-ranking
  // crawl as the urls branch above (one URL, same engine). Query acts as a
  // ranking-hint only: crawl failure falls back to the plain read, never
  // throws. Empty/whitespace query keeps the plain read path.
  if (typeof args.url === 'string' && typeof args.query === 'string' && args.query.trim().length > 0) {
    const single = args.url;
    const singleQuery = args.query;
    // M7 (T5/T6): an auth-host URL never enters semanticCrawl (no
    // bridge/Diffbot/external processing on auth hosts); the agenticBrowse
    // path already carries the authFetch seam and owns the session-only
    // cache gate. A config parse error falls back to the default path.
    try {
      if (resolveAuthProfileForUrl(single, parseWebAccessAuthProfiles(options.env ?? process.env)) !== undefined) {
        return agenticBrowseInner(args, options);
      }
    } catch {
      // Fall through to the default query path below.
    }
    try {
      const chunked = await semanticCrawl({
        source: { type: 'url', url: single },
        query: singleQuery,
        ...(typeof args.topK === 'number' ? { topK: args.topK } : {}),
        ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}),
        ...(typeof args.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
      }, options);
      // M1: sanitize at source — clean text is cached and returned.
      const body = sanitizeInlineDataUris(resultToSingleText(chunked), 'fetch.query.content').text;
      const text = `## ${single}\n${body}`;
      // M7 (T5): the singular query branch honors the same session-only
      // auth cache gate as the array branch; a parse error stays cacheable.
      let queryCacheable = true;
      try {
        queryCacheable =
          resolveAuthProfileForUrl(single, parseWebAccessAuthProfiles(options.env ?? process.env))?.cache !== 'off';
      } catch {
        queryCacheable = true;
      }
      return withFetchResponseId(
        textResult(text, { url: single }),
        queryCacheable
          ? cacheFetchForRetrieve({
            query: singleQuery.trim(),
            title: single,
            url: single,
            snippet: snippetOf(body),
            content: body,
          })
          : undefined,
      );
    } catch {
      return agenticBrowseInner(args, options);
    }
  }
  return agenticBrowseInner(args, options);
}

