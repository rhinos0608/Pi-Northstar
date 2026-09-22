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
import {
  buildNorthstarResult,
  computeStatus,
  parseEntity,
  validateNorthstarResult,
  type NorthstarEntityV1,
  type NorthstarErrorV1,
  type NorthstarErrorCode,
  type NorthstarResultV1,
  type NorthstarSourceOutcome,
  type NorthstarSourceStatusV1,
  type ResultStatus,
} from './result-contract.js';
import { validateWebRequest, DEFAULT_WEB_READ_MAX_CHARS, WEB_ENTITY_CONTENT_MAX, FETCH_RAW_MAX_BYTES } from './web/web-contract.js';
import {
  budgetAnswerContext,
  buildPageQueryMessages,
  checkProbeCoverage,
  checkProbeCoverageWithEmbeddings,
  formatEvidenceOnlyAnswer,
  requireAnswerPrompt,
  PROBE_BACKGROUND_MAX_CHARS,
  PROBE_BACKGROUND_TOPK,
  PROBE_MAX_BACKGROUND_CALLS,
  type PageQueryMessages,
  type ProbeBackgroundItem,
  type ProbeCoverage,
} from './web/page-query.js';
import { isLocalVideoFile } from './media-vision/video-local.js';
import { sanitizeDiagnosticMessage, scrubDiagnosticSecrets } from './core/diagnostic-sanitizer.js';
import {
  boundPageText,
  fetchReadablePage,
  requireString,
  semanticCrawl,
  siteMapFetch,
  webSearch,
  wordCount,
  type WebToolOptions,
} from './web/web.js';

export interface NativeFetchOptions extends WebToolOptions {
  /** Test seam: raw-mode HTTP fetch (default: global fetch). */
  rawFetchImpl?: typeof fetch | undefined;
  /**
   * Test seam: quick-investigate probe call through the ISOLATED session-model
   * instance (ctx.model / ModelRuntime current, bound by the caller). No model
   * id, no env, no config lookup inside: the session model is reused as-is.
   * Absent probe means no session model: fail closed to evidence-only.
   */
  probeCall?: ((messages: PageQueryMessages) => Promise<string>) | undefined;
  /** Deprecated alias for probeCall (model field stays 'answer'). Prefer probeCall. */
  answerModelCall?:
    | ((modelId: string, messages: { system: string; page: string; prompt: string }) => Promise<string>)
    | undefined;
  /**
   * Test seam: bounded background search for the probe (single query).
   * Small topK enforced by the executor. Absent means production webSearch
   * (limit 3, never answer mode); search failure degrades to no background
   * evidence and insufficient coverage escalates instead.
   */
  backgroundSearch?:
    | ((query: string) => Promise<Array<{ title: string; url: string; snippet: string }>>)
    | undefined;
  /**
   * Test seam: bounded background fetch for the probe (remaining call budget).
   * Same SSRF/auth/provenance gates as the primary read; never answer mode.
   * Absent means production fetchReadablePage (2k chars, gates re-applied).
   */
  backgroundFetch?: ((url: string) => Promise<string>) | undefined;
  /** Test seam: batch embeddings for the hybrid coverage gate. Failure degrades to BM25-only. */
  probeEmbed?: ((texts: string[]) => Promise<number[][]>) | undefined;
  /** Answer-mode model context window (tokens). Default 128k; env PI_NORTHSTAR_MODEL_CONTEXT_TOKENS overrides. */
  answerContextTokens?: number | undefined;
}

const webAccessStore = createWebAccessContentStore();

export function getNativeFetchStore(): ReturnType<typeof createWebAccessContentStore> {
  return webAccessStore;
}

export function snippetOf(body: string): string {
  return truncateUtf8Bytes(body, 500);
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
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
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
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
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
    } catch (error) {
      if (isFetchUrlAbort(error, options.signal)) throw error;
      // Fall through to the plain media result below.
    }
  }
  try {
    return await callReachTool('media', { url }, options);
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
    return undefined;
  }
}

async function tryFeedUrlFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  try {
    return await callReachTool('feeds', { url }, options);
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
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
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
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
      } catch (error) {
        if (isFetchUrlAbort(error, options.signal)) throw error;
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
    } catch (error) {
      if (isFetchUrlAbort(error, options.signal)) throw error;
      // Diagnostics never fail the fetch; extracted text stands as-is.
    }
    // M1: sanitize at source — clean text is cached and returned; the
    // snippet derives from sanitized text (idempotent with choke point).
    const cleanPdf = sanitizeInlineDataUris(pdf.text, 'fetch.pdf.text').text;
    const cleanPdfMarkdown = sanitizeInlineDataUris(pdf.markdown, 'fetch.pdf.markdown').text;
    return withFetchResponseId(
      textResult(cleanPdf, {
        url,
        ...(degradedNote !== undefined ? { degraded: true, note: degradedNote } : {}),
        pdf: {
          totalPages: pdf.totalPages,
          truncated: pdf.truncated,
          citations: pdf.citations,
          markdown: cleanPdfMarkdown,
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
  } catch (error) {
    if (isFetchUrlAbort(error, options.signal)) throw error;
    return undefined;
  }
}

// ── Fetch read modes (executor halves; routes validate the vocabulary) ──

/** Default answer-mode model context window (tokens) when no override is set. */
export const FETCH_ANSWER_DEFAULT_CONTEXT_TOKENS = 128_000;

/** Env override for the answer-mode context window. */
export const FETCH_ANSWER_CONTEXT_TOKENS_ENV_VAR = 'PI_NORTHSTAR_MODEL_CONTEXT_TOKENS';

function resolveAnswerContextTokens(options: NativeFetchOptions): number {
  if (options.answerContextTokens !== undefined && Number.isInteger(options.answerContextTokens) && (options.answerContextTokens as number) > 0) {
    return options.answerContextTokens as number;
  }
  const envRaw = options.env === undefined
    ? process.env[FETCH_ANSWER_CONTEXT_TOKENS_ENV_VAR]
    : options.env[FETCH_ANSWER_CONTEXT_TOKENS_ENV_VAR];
  if (envRaw !== undefined) {
    const normalized = envRaw.trim();
    if (/^\d+$/.test(normalized)) {
      const parsed = Number(normalized);
      if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    }
  }
  return FETCH_ANSWER_DEFAULT_CONTEXT_TOKENS;
}

/** Raw-mode content-type gate: text/* plus JSON/XML document types (suffix-aware). */
export function isRawContentTypeAllowed(contentType: string | null): boolean {
  if (contentType === null) return false;
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'text/xml') return true;
  if (mime.endsWith('+json') || mime.endsWith('+xml')) return true;
  return false;
}

/**
 * Raw mode: direct HTTP text body, byte-bounded then UTF-8 decoded. Direct HTTP with SSRF/DNS guards and
 * manual same-guard redirects; text/*+json/xml gate, 5MB cap, utf-8 decode.
 * Non-2xx bodies are preserved with their status (not thrown); readability,
 * specializers, and data-URI sanitize are skipped.
 */
export async function fetchRawUrl(url: string, options: NativeFetchOptions, maxBytes: number = FETCH_RAW_MAX_BYTES): Promise<BackendCallResult> {
  validateHttpUrl(url);
  await resolvePublicHostname(new URL(url).hostname, options.signal, options.lookup);
  const fetchImpl = options.rawFetchImpl ?? fetch;
  let current = url;
  const maxRedirects = 5;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetchImpl(current, { redirect: 'manual', ...(options.signal !== undefined ? { signal: options.signal } : {}) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      try { await response.body?.cancel(); } catch { /* discard best-effort */ }
      if (!location || hop === maxRedirects) throw new Error('fetch raw redirect failed');
      current = validateHttpUrl(new URL(location, current).href);
      await resolvePublicHostname(new URL(current).hostname, options.signal, options.lookup);
      continue;
    }
    const contentType = response.headers.get('content-type');
    if (!isRawContentTypeAllowed(contentType)) {
      try { await response.body?.cancel(); } catch { /* discard best-effort */ }
      throw new Error(`fetch raw rejects content-type '${contentType ?? 'unknown'}': exact-HTTP text only`);
    }
    const announced = response.headers.get('content-length');
    if (announced !== null) {
      const parsed = Number.parseInt(announced, 10);
      if (Number.isInteger(parsed) && parsed > maxBytes) {
        try { await response.body?.cancel(); } catch { /* discard best-effort */ }
        throw new Error(`fetch raw exceeds ${maxBytes} bytes`);
      }
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`fetch raw exceeds ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    } else {
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength > maxBytes) throw new Error(`fetch raw exceeds ${maxBytes} bytes`);
      chunks.push(buffer);
      total = buffer.byteLength;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder('utf-8').decode(merged);
    const ok = response.status >= 200 && response.status < 300;
    const result = ok
      ? textResult(text, { url: current })
      : textResult(text, { url: current, status: response.status, statusText: `HTTP ${response.status} body preserved` });
    const responseId = cacheFetchForRetrieve({
      query: url,
      title: current,
      url: current,
      snippet: snippetOf(text),
      content: text,
    });
    return withFetchResponseId(result, responseId);
  }
  throw new Error('fetch raw redirect failed');
}

/**
 * Local video file route: operator file interrogated via the video-local
 * extract + tier-gated vision path (runFetchVideoAnalysis dispatches on
 * isLocalVideoFile). YouTube/remote handling is untouched.
 */
export async function tryLocalVideoFetch(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  if (!isLocalVideoFile(url)) return undefined;
  const analysis = await runFetchVideoAnalysis(url, {
    env: (options.env ?? process.env) as Record<string, string | undefined>,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  const text = analysis.text.trim().length > 0 ? analysis.text : `(local video: no describable frames for ${url})`;
  const result = textResult(text, {
    url,
    video: {
      keyframes: analysis.keyframes,
      synthesized: analysis.synthesized,
      degraded: analysis.degraded,
      warnings: analysis.warnings,
    },
  });
  const responseId = cacheFetchForRetrieve({
    query: url,
    title: url,
    url,
    snippet: snippetOf(text),
    content: text,
  });
  return withFetchResponseId(result, responseId);
}

/**
 * Quick-investigate probe pipeline (internal primitive `probe`; the public
 * read-mode/model field stays `answer`).
 *
 * 1. Extract page/PDF to readable (existing extractors + budget/truncation).
 * 2. Coverage gate FIRST on the extract (BM25, fused with embeddings when
 *    the probeEmbed seam supplies them). Sufficient -> answer directly.
 * 3. Else bounded background: max 5 small calls (typically 1 search plus
 *    follow-up fetches), same SSRF/auth/provenance gates, no recursion into answer mode.
 * 4. Probe the isolated session-model instance; return concise answer +
 *    background + source URL + truncation notice; full raw stays in the
 *    responseId store. No session model -> evidence-only (fail closed). Hard
 *    question with no background evidence -> evidence + escalate flag for the
 *    full agent (never run here).
 *
 * Guards: prompt required; per-call answerModel rejected (removed);
 * authenticated hosts forbidden (anonymous page probe only).
 */
interface ProbeHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Production background search: canonical webSearch (limit 3, never answer
 * mode — webSearch takes no mode here). Failure throws so the caller
 * degrades to no background evidence (escalate) instead of inventing any.
 */
async function productionProbeSearch(query: string, options: NativeFetchOptions): Promise<ProbeHit[]> {
  const env = (options.env ?? process.env) as Record<string, string | undefined>;
  const result = await webSearch(
    { query, limit: PROBE_BACKGROUND_TOPK },
    { env, ...(options.signal !== undefined ? { signal: options.signal } : {}), ...(options.lookup !== undefined ? { lookup: options.lookup } : {}) },
  );
  const results = (result as { details?: { results?: unknown } }).details?.results;
  if (!Array.isArray(results)) return [];
  const hits: ProbeHit[] = [];
  for (const entry of results) {
    const row = entry as { title?: unknown; url?: unknown; snippet?: unknown };
    if (typeof row.title !== 'string' || typeof row.url !== 'string') continue;
    hits.push({ title: row.title, url: row.url, snippet: typeof row.snippet === 'string' ? row.snippet : '' });
  }
  return hits.slice(0, PROBE_BACKGROUND_TOPK);
}

/**
 * Production background fetch: readable page bound to 2k chars. SSRF/auth
 * gates re-apply here (fetchReadablePage validates URL + DNS preflight)
 * and again per-hit in runProbeBackground before this is called.
 */
async function productionProbeFetch(url: string, options: NativeFetchOptions): Promise<string> {
  const env = (options.env ?? process.env) as Record<string, string | undefined>;
  const page = await fetchReadablePage(url, options.signal, undefined, options.lookup, { env });
  return boundPageText(page.content, PROBE_BACKGROUND_MAX_CHARS).text;
}

async function runProbeBackground(
  prompt: string,
  options: NativeFetchOptions,
): Promise<{ items: ProbeBackgroundItem[]; calls: number }> {
  const items: ProbeBackgroundItem[] = [];
  let calls = 0;
  // Production defaults: a configured session always gets real background
  // calls; only an explicit test seam overrides. No empty-default path.
  const searchFn = options.backgroundSearch ?? ((query: string) => productionProbeSearch(query, options));
  const fetchFn = options.backgroundFetch ?? ((url: string) => productionProbeFetch(url, options));
  const seen = new Set<string>();
  for (const searchQuery of [prompt.slice(0, 200)]) {
    if (calls >= PROBE_MAX_BACKGROUND_CALLS) break;
    let hits: Array<{ title: string; url: string; snippet: string }>;
    calls += 1;
    try {
      hits = await searchFn(searchQuery);
    } catch {
      continue;
    }
    for (const hit of hits.slice(0, PROBE_BACKGROUND_TOPK)) {
      if (calls >= PROBE_MAX_BACKGROUND_CALLS) break;
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      // Same gates as the primary read: SSRF admission + no auth passthrough.
      try {
        validateHttpUrl(hit.url);
        await resolvePublicHostname(new URL(hit.url).hostname, options.signal, options.lookup);
        if (resolveAuthProfileForUrl(hit.url, parseWebAccessAuthProfiles(options.env ?? {})) !== undefined) continue;
      } catch {
        continue;
      }
      try {
        const text = await fetchFn(hit.url);
        calls += 1;
        const snippet = text.slice(0, PROBE_BACKGROUND_MAX_CHARS);
        if (snippet.trim().length > 0) items.push({ source: hit.url, text: snippet });
      } catch {
        calls += 1;
      }
    }
  }
  return { items, calls };
}

/** Resolve the probe call: session-model seam, else legacy alias, else undefined (evidence-only). */
function resolveProbeCall(options: NativeFetchOptions): ((messages: PageQueryMessages) => Promise<string>) | undefined {
  if (options.probeCall !== undefined) return options.probeCall;
  const legacy = options.answerModelCall;
  if (legacy === undefined) return undefined;
  return (messages) => legacy('answer', { system: messages.system, page: messages.page, prompt: messages.prompt });
}

/** Extract answer-mode page text via the PDF/video/page path (no auth: caller rejects first). */
async function extractAnswerSource(url: string, options: NativeFetchOptions): Promise<{ text: string; provenance: string }> {
  const video = await tryLocalVideoFetch(url, options);
  if (video !== undefined) return { text: resultToSingleText(video), provenance: 'video-local' };
  if (isPdfUrl(url)) {
    const pdf = await tryLocalPdfFetch(url, options);
    if (pdf === undefined) throw new Error('fetch answer could not read PDF');
    return { text: resultToSingleText(pdf), provenance: 'pdf' };
  }
  if (isYoutubeFetchVideoUrl(url)) {
    const analysis = await runFetchVideoAnalysis(url, {
      env: (options.env ?? process.env) as Record<string, string | undefined>,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    return { text: analysis.text, provenance: 'video-youtube' };
  }
  const page = await agenticBrowseInner({ url }, options);
  return { text: resultToSingleText(page), provenance: 'page' };
}

/**
 * Answer mode: quick-investigate probe over one fetched page. Prompt required
 * (route-validated, re-required here); per-call answerModel rejected (removed:
 * the probe reuses the session model); auth forbidden (rejects before any
 * read). Coverage gate runs FIRST on the extract: sufficient answers directly,
 * else bounded background (max 5 small calls, same gates, never answer mode).
 * Extract travels as untrusted <page> evidence; full raw extract is kept in
 * the responseId store so the answer stays verifiable. No session model
 * probe -> evidence-only (fail closed). Insufficient coverage with no
 * background evidence -> evidence + escalate flag for the full agent.
 */
export async function fetchAnswerUrl(
  url: string,
  args: { prompt: unknown },
  options: NativeFetchOptions,
): Promise<BackendCallResult> {
  if ((args as { answerModel?: unknown }).answerModel !== undefined) {
    throw new Error("fetch answer rejects 'answerModel': quick-investigate reuses the session model; per-call override removed");
  }
  const prompt = requireAnswerPrompt(args.prompt);
  const env = (options.env ?? process.env) as Record<string, string | undefined>;
  const auth = resolveAuthProfileForUrl(url, parseWebAccessAuthProfiles(env));
  if (auth !== undefined) throw new Error('fetch answer forbids authenticated hosts: answer is anonymous page Q&A only');
  const { text: extract, provenance } = await extractAnswerSource(url, options);
  if (extract.trim().length === 0) throw new Error('fetch answer found no readable text');
  const budget = budgetAnswerContext(extract.length, resolveAnswerContextTokens(options));
  const admitted = budget.truncated ? extract.slice(0, budget.admittedChars) : extract;
  // Coverage gate FIRST: BM25 over the extract, fused with embeddings when supplied.
  const coverage: ProbeCoverage = options.probeEmbed !== undefined
    ? await checkProbeCoverageWithEmbeddings(admitted, prompt, options.probeEmbed)
    : checkProbeCoverage(admitted, prompt);
  const background = coverage.sufficient ? { items: [], calls: 0 } : await runProbeBackground(prompt, options);
  const probe = resolveProbeCall(options);
  const escalate = !coverage.sufficient && background.items.length === 0;
  const responseId = cacheFetchForRetrieve({
    query: url,
    title: url,
    url,
    snippet: snippetOf(extract),
    content: extract,
  });
  const modelNotice = budget.truncated ? `\n\n(extract truncated to ${budget.admittedChars} chars for the model call; full text kept under responseId)` : '';
  const modelEscalateNotice = escalate ? '\n\n(escalate: coverage insufficient and no background evidence gathered; hand to the full agent with this evidence)' : '';
  let probeFailed = false;
  let answer: string;
  if (probe === undefined) {
    answer = formatEvidenceOnlyAnswer({ extract: admitted, url, truncated: budget.truncated, admittedChars: budget.admittedChars, escalate });
  } else {
    try {
      answer = `${await probe(buildPageQueryMessages(admitted, prompt, background.items, url))}${modelNotice}${modelEscalateNotice}`;
    } catch (error) {
      if (isFetchUrlAbort(error, options.signal)) throw error;
      // The page/background evidence is already acquired and cached. A model
      // provider failure must not throw that evidence away or fabricate an
      // answer. Degrade to the same evidence-only shape as a missing session
      // model and expose only a boolean diagnostic, never provider error text.
      probeFailed = true;
      answer = `${formatEvidenceOnlyAnswer({ extract: admitted, url, truncated: budget.truncated, admittedChars: budget.admittedChars, escalate })}

(session model probe unavailable; returning evidence-only)`;
    }
  }
  const result = textResult(answer, {
    url,
    mode: 'answer',
    model: 'answer',
    primitive: 'probe',
    provenance,
    truncated: budget.truncated,
    coverage: { sufficient: coverage.sufficient, method: coverage.method, termCoverage: coverage.termCoverage },
    backgroundCalls: background.calls,
    escalate,
    ...(probeFailed ? { probeFailed: true } : {}),
  });
  return withFetchResponseId(result, responseId);
}

export async function dispatchSpecializedUrl(url: string, options: NativeFetchOptions): Promise<BackendCallResult | undefined> {
  // Local video files are operator paths, not URLs: interrogate via the
  // video-local extract + tier-gated vision path before any URL handling.
  if (isLocalVideoFile(url)) return tryLocalVideoFetch(url, options);
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
  const result = await dispatchFetchInner(args, options);
  // Raw preserves the admitted HTTP text body: data-URI sanitize is skipped by contract.
  if (args.mode === 'raw') return result;
  return sanitizeFetchResultText(result);
}

/**
 * Mode fan-out for the urls branch: per-URL isolation (one failure becomes
 * an error entry, never an aborted array). Mirrors the readable multi
 * branch without its passage-selector machinery (routes forbid query/topK
 * in raw/answer modes).
 */
async function dispatchModeMultiFetch(args: Record<string, unknown>, options: NativeFetchOptions): Promise<BackendCallResult> {
  const mode = args.mode as 'raw' | 'answer';
  const urls = args.urls as unknown[];
  if (args.answerModel !== undefined) throw new Error("fetch answer rejects 'answerModel': quick-investigate reuses the session model; per-call override removed");
  const out: string[] = [];
  const entries: Array<{
    url: string;
    status: ResultStatus;
    responseId?: string;
    error?: { code: NorthstarErrorCode; message: string; retryable: boolean };
  }> = [];
  for (const entry of urls) {
    const singleUrl = String(entry);
    try {
      const single = mode === 'raw'
        ? await fetchRawUrl(singleUrl, options, Math.floor(FETCH_RAW_MAX_BYTES / Math.max(1, urls.length)))
        : await fetchAnswerUrl(singleUrl, { prompt: args.prompt }, options);
      out.push(`## ${singleUrl}\n\n${resultToSingleText(single)}`);
      const sourceResponseId = (single as { details?: { responseId?: unknown } }).details?.responseId;
      entries.push({
        url: singleUrl,
        status: 'ok',
        ...(typeof sourceResponseId === 'string' ? { responseId: sourceResponseId } : {}),
      });
    } catch (error) {
      if (isFetchUrlAbort(error, options.signal)) throw error;
      const mapped = mapFetchUrlError(error);
      out.push(`## ${singleUrl}\n\nError: ${mapped.message}`);
      entries.push({ url: singleUrl, status: 'error', error: mapped });
    }
  }
  const text = out.join('\n\n');
  const first = urls.length > 0 ? String(urls[0]) : '';
  const responseId = cacheFetchForRetrieve({
    query: urls.map((entry) => String(entry)).join(' '),
    title: first,
    url: first,
    snippet: snippetOf(text),
    content: text,
  });
  return withFetchResponseId(textResult(text, { mode, entries }), responseId);
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

function isFetchUrlAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Code-owned per-URL error mapping for the urls branch. Caller abort is never
 * mapped here (callers rethrow before reaching this). Classification uses raw
 * text; emitted message is scrubbed by sanitizeDiagnosticMessage (never raw
 * bodies, stacks, secrets, credentials, or header values).
 * Codes are existing NorthstarErrorCode values only.
 */
function mapFetchUrlError(error: unknown): { code: NorthstarErrorCode; message: string; retryable: boolean } {
  const raw = error instanceof Error ? error.message : String(error);
  const codeProp =
    typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : '';

  // Classify code using original raw text before scrubbing
  let code: NorthstarErrorCode = 'backend_http_error';
  let retryable = true;

  if (/rate[-_ ]?limit|\b429\b/i.test(raw) || codeProp === 'rate_limited') {
    code = 'rate_limited';
    retryable = true;
  } else if (/timed?\s?out|etimedout|\btimeout\b/i.test(raw) || codeProp === 'timeout') {
    code = 'timeout';
    retryable = true;
  } else if (/private\/reserved|blocked hostname|\bssrf\b/i.test(raw) || codeProp === 'ssrf_denied' || codeProp === 'ESSRF') {
    code = 'invalid_input';
    retryable = false;
  } else if (/auth|unauthorized|forbidden|\b401\b|\b403\b/i.test(raw) || codeProp === 'authentication_required' || codeProp === 'auth') {
    // Auth classified before generic invalid/required mapping so "authentication required" classifies as auth, not invalid_input
    code = 'backend_http_error';
    retryable = false;
  } else if (/\binvalid\b|\bunsupported\b|\brequired\b|must be/i.test(raw) || codeProp === 'invalid_input' || codeProp === 'invalid_request') {
    code = 'invalid_input';
    retryable = false;
  } else if (/network|connection|econnreset|eai_again|enotfound|fetch failed|upstream|\b502\b|\b503\b|\b504\b/i.test(raw)) {
    code = 'backend_unavailable';
    retryable = true;
  }

  // Scrub secret values and bound output for emission
  const message = sanitizeDiagnosticMessage(raw, 500) || 'Fetch failed';

  return { code, message, retryable };
}

export function fetchUrlSuccessOutcome(url: string, body: string): NorthstarSourceOutcome {
  const parsed = parseEntity(
    { id: url, url, title: url, snippet: truncateUtf8Bytes(body, WEB_ENTITY_CONTENT_MAX), source: 'web' },
    { source: 'web', kind: 'article' },
  );
  if (parsed.ok) return { source: 'web', backend: 'native-fetch', entities: [parsed.entity] };
  return { source: 'web', backend: 'native-fetch', invalid: 1 };
}

interface SingleUrlExtractedData {
  entities: NorthstarEntityV1[];
  sources: NorthstarSourceStatusV1[];
  errors: NorthstarErrorV1[];
  notes: string[];
  entryStatus: ResultStatus;
  isDegraded: boolean;
  canCache: boolean;
  cleanBody: string;
}

/**
 * Preserve canonical components for a single URL specialist result without multiplicity collapse.
 * Validates envelope before trusting; falls back safely to web/article.
 * Sanitizes and UTF-8 bounds every error message and note copied from canonical envelopes.
 * For error status, bounds diagnostic body to 500 bytes.
 * For partial status, scrubs secrets across the full body and entity snippets without truncating.
 */
function extractSingleUrlCanonical(
  url: string,
  rawBody: string,
  result: BackendCallResult,
): SingleUrlExtractedData {
  const details = (result.details && typeof result.details === 'object' && !Array.isArray(result.details))
    ? (result.details as Record<string, unknown>)
    : undefined;

  const rawEnvelope = details?.northstar;
  const validation = rawEnvelope ? validateNorthstarResult(rawEnvelope) : { ok: false, issues: [] };

  if (validation.ok && validation.result) {
    const validEnvelope: NorthstarResultV1 = validation.result;
    const sanitizedErrors: NorthstarErrorV1[] = validEnvelope.errors.map((err) => ({
      ...err,
      message: sanitizeDiagnosticMessage(err.message, 500) || 'Error',
    }));
    const sanitizedNotes: string[] = validEnvelope.notes.map((note) =>
      sanitizeDiagnosticMessage(note, 500) || note
    );

    // Truthful entry status: use canonical status
    const entryStatus: ResultStatus = validEnvelope.status;

    // Cache policy: only ok/degraded/empty are cacheable; partial and error must not enter retrieve cache
    const canCache = entryStatus === 'ok' || entryStatus === 'degraded' || entryStatus === 'empty';

    // Diagnostic body and entity snippet scrubbing:
    // For error status: 500-byte diagnostic bounded message.
    // For partial status: unbounded secret scrub across the full body and entity snippets.
    // For ok/degraded/empty: leave raw body intact.
    let cleanBody = rawBody;
    let entities = validEnvelope.data.kind === 'entities' ? [...validEnvelope.data.entities] : [];
    if (entryStatus === 'error') {
      cleanBody = sanitizeDiagnosticMessage(rawBody, 500);
    } else if (entryStatus === 'partial') {
      cleanBody = scrubDiagnosticSecrets(rawBody);
      entities = entities.map((ent) => {
        if (ent.snippet === undefined) return ent;
        return {
          ...ent,
          snippet: scrubDiagnosticSecrets(ent.snippet),
        };
      });
    }

    const isDegraded = validEnvelope.status === 'degraded' || validEnvelope.sources.some((s) => s.status === 'degraded') || details?.degraded === true;

    return {
      entities,
      sources: [...validEnvelope.sources],
      errors: sanitizedErrors,
      notes: sanitizedNotes,
      entryStatus,
      isDegraded,
      canCache,
      cleanBody,
    };
  }

  // Fallback for missing or malformed canonical envelope:
  const fallback = fetchUrlSuccessOutcome(url, rawBody);
  const fallbackDegraded = details?.degraded === true;
  const entities: NorthstarEntityV1[] = fallback.entities ? [...fallback.entities] : [];
  const count = entities.length;
  const entryStatus: ResultStatus = fallbackDegraded ? 'degraded' : (count > 0 ? 'ok' : 'empty');

  const sources: NorthstarSourceStatusV1[] = [{
    source: 'web',
    backend: 'native-fetch',
    status: entryStatus,
    count,
  }];

  return {
    entities,
    sources,
    errors: [],
    notes: [],
    entryStatus,
    isDegraded: fallbackDegraded,
    canCache: true,
    cleanBody: rawBody,
  };
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
  // Read modes on the url/urls branches: raw (exact HTTP) and answer
  // (page Q&A). Sitemap/retrieve branches carry no mode fields (the route
  // rejects them there); an unknown mode value fails closed here.
  if (args.mode !== undefined) {
    if (args.mode !== 'raw' && args.mode !== 'answer' && args.mode !== 'readable') {
      throw new Error('fetch mode must be one of readable|raw|answer');
    }
    if (args.mode === 'raw' || args.mode === 'answer') {
      if (args.answerModel !== undefined) throw new Error("fetch answer rejects 'answerModel': quick-investigate reuses the session model; per-call override removed");
      if (Array.isArray(args.urls)) return dispatchModeMultiFetch(args, options);
      if (typeof args.url === 'string') {
        if (args.mode === 'raw') return fetchRawUrl(args.url, options);
        return fetchAnswerUrl(args.url, { prompt: args.prompt }, options);
      }
      throw new Error('fetch mode requires url or urls[1..8]');
    }
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
    // maxChars is a total response budget, not a per-URL allowance: split it
    // evenly so N URLs can never accumulate N x maxChars before the guard.
    // The joined text is truncated to the same budget so the contract holds
    // end to end instead of relying on the later 60k model-output guard.
    const urlCount = (args.urls as unknown[]).length;
    const totalBudget = typeof args.maxChars === 'number' ? args.maxChars : DEFAULT_WEB_READ_MAX_CHARS;
    const perUrlBudget = Math.max(1, Math.floor(totalBudget / Math.max(1, urlCount)));
    const truncateMultiFetchToBudget = (text: string): string => {
      if (text.length <= totalBudget) return text;
      const marker = `\n\n[multi-fetch: response truncated to maxChars budget ${totalBudget}]`;
      const keep = Math.max(0, totalBudget - marker.length);
      return `${text.slice(0, keep)}${marker}`;
    };
    const out: string[] = [];
    const cached: Array<{ title: string; url: string; snippet: string; content: string }> = [];
    const entries: Array<{ url: string; status: ResultStatus; error?: { code: NorthstarErrorCode; message: string; retryable: boolean } }> = [];

    // Aggregated canonical components (lossless preservation in encounter order)
    const aggregateEntities: NorthstarEntityV1[] = [];
    const seenEntityIds = new Set<string>();
    const aggregateSources: NorthstarSourceStatusV1[] = [];
    const aggregateErrors: NorthstarErrorV1[] = [];
    const aggregateNotes: string[] = [];
    let hasAnyDegraded = false;

    // M7: auth-off entries never reach the retrieve cache (T5). A config
    // parse error falls back to cacheable: the fetch itself surfaces it.
    const arrayAuthCacheable = (entryUrl: string): boolean => {
      try {
        return resolveAuthProfileForUrl(entryUrl, parseWebAccessAuthProfiles(options.env ?? process.env))?.cache !== 'off';
      } catch {
        return true;
      }
    };

    function mergeExtracted(extracted: SingleUrlExtractedData, singleUrl: string): void {
      entries.push({
        url: singleUrl,
        status: extracted.entryStatus,
        ...(extracted.errors[0]
          ? { error: { code: extracted.errors[0].code, message: extracted.errors[0].message, retryable: extracted.errors[0].retryable } }
          : {}),
      });

      if (extracted.isDegraded) hasAnyDegraded = true;

      // Entity dedupe by unique entity id (source + kind + id)
      for (const ent of extracted.entities) {
        const entKey = `${ent.source}:${ent.kind}:${ent.id}`;
        if (!seenEntityIds.has(entKey)) {
          seenEntityIds.add(entKey);
          aggregateEntities.push(ent);
        }
      }

      // Append all sources and errors in encounter order without collapsing multiplicity
      aggregateSources.push(...extracted.sources);
      aggregateErrors.push(...extracted.errors);
      aggregateNotes.push(...extracted.notes);

      // Rendered body: cleanBody reflects scrubbed diagnostic for error/partial
      out.push(withQuery ? `## ${singleUrl}\n${extracted.cleanBody}` : extracted.cleanBody);

      // Cache policy: only ok/degraded/empty are cacheable; partial and error must not enter retrieve cache
      if (extracted.canCache && arrayAuthCacheable(singleUrl)) {
        cached.push({ title: singleUrl, url: singleUrl, snippet: snippetOf(extracted.cleanBody), content: extracted.cleanBody });
      }
    }

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
            const authResult = await agenticBrowseInner({ url: single, maxChars: perUrlBudget }, options);
            const authBody = resultToSingleText(authResult);
            const extracted = extractSingleUrlCanonical(single, authBody, authResult);
            mergeExtracted(extracted, single);
          } else {
            const chunked = await semanticCrawl({
              source: { type: 'url', url: single },
              query: args.query,
              ...(typeof args.topK === 'number' ? { topK: args.topK } : {}),
              ...(typeof args.maxPages === 'number' ? { maxPages: args.maxPages } : {}),
              maxChars: perUrlBudget,
            }, options);
            // M1: sanitize at source — clean text is cached and returned.
            const body = sanitizeInlineDataUris(resultToSingleText(chunked), 'fetch.query.content').text;
            const extracted = extractSingleUrlCanonical(single, body, chunked);
            mergeExtracted(extracted, single);
          }
        } else {
          const specialized = await dispatchSpecializedUrl(single, options);
          const singleResult = specialized ?? await agenticBrowseInner({ url: single, maxChars: perUrlBudget }, options);
          const body = sanitizeInlineDataUris(resultToSingleText(singleResult), 'fetch.read.content').text;
          const extracted = extractSingleUrlCanonical(single, body, singleResult);
          mergeExtracted(extracted, single);
        }
      } catch (error) {
        // Caller abort propagates as cancellation; never an isolated error entry.
        if (isFetchUrlAbort(error, options.signal)) throw error;
        const mapped = mapFetchUrlError(error);
        out.push(`## ${single}\nError: ${mapped.message}`);
        entries.push({ url: single, status: 'error', error: mapped });
        aggregateErrors.push({ ...mapped, source: 'web', backend: 'native-fetch' });
        aggregateSources.push({
          source: 'web',
          backend: 'native-fetch',
          status: 'error',
          count: 0,
        });
      }
    }

    const arrayQuery = withQuery && typeof args.query === 'string' ? args.query.trim() : 'fetch';

    // Compute aggregate status following canonical computeStatus precedence
    const overallStatus: ResultStatus = computeStatus({
      entityCount: aggregateEntities.length,
      errorCount: aggregateErrors.length,
      invalidCount: 0,
      degraded: hasAnyDegraded,
    });

    const envelope: NorthstarResultV1 = {
      schema: 'pi-northstar.result',
      version: 1,
      status: overallStatus,
      request: { tool: 'fetch', channel: 'web', action: 'read' },
      data: { kind: 'entities', entities: aggregateEntities },
      pagination: { supported: false, limit: entries.length, returned: aggregateEntities.length, hasMore: false },
      sources: aggregateSources,
      errors: aggregateErrors,
      notes: aggregateNotes,
    };

    // Validate envelope before attachment
    const check = validateNorthstarResult(envelope);
    const validEnvelope = check.ok ? envelope : buildNorthstarResult({
      request: { tool: 'fetch', channel: 'web', action: 'read' },
      outcomes: [{ source: 'web', backend: 'native-fetch', ...(hasAnyDegraded ? { degraded: true } : {}) }],
      pagination: { supported: false, limit: entries.length, hasMore: false },
    });

    return withFetchResponseId(
      northstarTextResult(
        truncateMultiFetchToBudget(out.join('\n\n')),
        { urls: args.urls, entries, maxChars: totalBudget, perUrlMaxChars: perUrlBudget, ...(hasAnyDegraded ? { degraded: true } : {}) },
        validEnvelope,
      ),
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
