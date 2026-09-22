// Pi Web Access final: bounded local PDF text extraction.
//
// Local-only (no OCR, no cloud). `unpdf` (^1.8.1) is a hard dependency and
// loads via dynamic import; when extraction fails the caller injects an
// extractor (tests) or fetch falls back to the page reader.
// Bounds live here (not in the shared contract): byte cap, page cap, timeout,
// char cap. Page citations use `[p. N]` markers.

export const WEB_ACCESS_PDF_MAX_BYTES = 20 * 1024 * 1024;
export const WEB_ACCESS_PDF_MAX_PAGES = 100;
export const WEB_ACCESS_PDF_TIMEOUT_MS = 30_000;
export const WEB_ACCESS_PDF_MAX_CHARS = 50_000;

/** Tiered-PDF config ceilings: operator overrides may only lower the
 * normal fetch ceilings; they never widen the local extraction surface. */
export const PDF_TIER_DEFAULT_SIZE_MB = 20;
export const PDF_TIER_HARD_MAX_SIZE_MB = PDF_TIER_DEFAULT_SIZE_MB;
export const PDF_TIER_DEFAULT_MAX_PAGES = WEB_ACCESS_PDF_MAX_PAGES;
export const PDF_TIER_HARD_MAX_PAGES = WEB_ACCESS_PDF_MAX_PAGES;

/** Local engine set. `auto` resolves to `unpdf` today; hosted engines
 * (datalab/gemini transfer) are NOT added until an explicit operator
 * opt-in plus the PI_VISION_PRIVATE transfer gate exists. */
export type PdfEngineOption = 'auto' | 'unpdf';

export interface PdfTierConfig {
  enabled: boolean;
  maxSizeMB: number;
  maxPages: number;
  provider: PdfEngineOption;
}

export function resolvePdfTierConfig(input?: Partial<PdfTierConfig>): PdfTierConfig {
  const provider = input?.provider ?? 'auto';
  if (provider !== 'auto' && provider !== 'unpdf') throw new Error(`unsupported PDF provider: ${String(provider)}`);
  const maxSizeMB = input?.maxSizeMB ?? PDF_TIER_DEFAULT_SIZE_MB;
  if (!Number.isFinite(maxSizeMB) || maxSizeMB < 1 || maxSizeMB > PDF_TIER_HARD_MAX_SIZE_MB) {
    throw new Error(`PDF maxSizeMB must be within 1..${PDF_TIER_HARD_MAX_SIZE_MB} (got ${String(maxSizeMB)})`);
  }
  const maxPages = input?.maxPages ?? PDF_TIER_DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > PDF_TIER_HARD_MAX_PAGES) {
    throw new Error(`PDF maxPages must be an integer 1..${PDF_TIER_HARD_MAX_PAGES} (got ${String(maxPages)})`);
  }
  return { enabled: input?.enabled ?? true, maxSizeMB, maxPages, provider };
}

/** `auto` = local unpdf now. Future hosted engines attach here behind
 * operator opt-in + transfer gate; never silently. */
export function resolvePdfEngine(option: PdfEngineOption = 'auto'): 'unpdf' {
  void option;
  return 'unpdf';
}

export function effectivePdfMaxBytes(config?: Partial<PdfTierConfig>): number {
  return Math.floor(resolvePdfTierConfig(config).maxSizeMB * 1024 * 1024);
}

export interface WebAccessPdfRawResult {
  totalPages: number;
  pages: string[];
}

export type WebAccessPdfExtractor = (
  data: Uint8Array,
  options?: { signal?: AbortSignal | undefined; maxPages?: number | undefined },
) => Promise<WebAccessPdfRawResult>;

export interface WebAccessPdfCitation {
  page: number;
  cite: string;
}

export interface WebAccessPdfText {
  totalPages: number;
  pages: Array<{ page: number; text: string }>;
  citations: WebAccessPdfCitation[];
  text: string;
  /** Answer-mode markdown: `<!-- PAGE N -->` marker per kept page. */
  markdown: string;
  truncated: boolean;
}

export interface WebAccessPdfExtractOptions {
  extractor: WebAccessPdfExtractor;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxPages?: number | undefined;
  maxChars?: number | undefined;
  maxBytes?: number | undefined;
  tier?: Partial<PdfTierConfig> | undefined;
}

/** Build answer-mode markdown with `<!-- PAGE N -->` markers, capped at maxChars. */
export function buildPdfMarkdown(pages: Array<{ page: number; text: string }>, maxChars?: number): string {
  const markdown = pages.map((p) => `<!-- PAGE ${p.page} -->\n${p.text}`).join('\n\n').trimEnd();
  if (maxChars === undefined || markdown.length <= maxChars) return markdown;
  return markdown.slice(0, maxChars);
}

export interface PdfSavedMarkdown {
  path: string;
  bytes: number;
  pages: number;
  chars: number;
  truncated: boolean;
}

/** Persist markdown under tmp `pi-web-pdf/`; returns path + stats (readable). */
export async function savePdfMarkdownToTmp(
  markdown: string,
  stats: { pages: number; truncated: boolean },
  deps?: { dir?: string | undefined; id?: string | undefined },
): Promise<PdfSavedMarkdown> {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { mkdirSync } = await import('node:fs');
  const base = deps?.dir ?? await mkdtemp(join(tmpdir(), 'pi-web-pdf-'));
  if (deps?.dir !== undefined) mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, 'pdf-'));
  const name = `${deps?.id ?? randomUUID()}.md`;
  const path = join(dir, name);
  await writeFile(path, markdown, { encoding: 'utf8', mode: 0o600 });
  return { path, bytes: Buffer.byteLength(markdown, 'utf8'), pages: stats.pages, chars: markdown.length, truncated: stats.truncated };
}

/** Infer PDF format internally: `.pdf` path or `application/pdf` content type. */
export function isPdfUrl(url: string, contentType?: string | undefined): boolean {
  if (typeof contentType === 'string' && contentType.toLowerCase().includes('application/pdf')) return true;
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.endsWith('.pdf');
  } catch {
    return url.trim().toLowerCase().split(/[?#]/)[0]?.endsWith('.pdf') ?? false;
  }
}

function cleanPageText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, maxChars) : '';
}

function withTimeout<T>(task: Promise<T>, ms: number, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Attach a no-op catch so a late task rejection after the timeout wins
  // the race cannot surface as an unhandled rejection (throw mode kills process).
  task.catch(() => {});
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller?.abort(); reject(new Error(`PDF extraction timed out after ${ms}ms`)); }, ms);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function extractWebAccessPdfText(
  data: Uint8Array,
  options: WebAccessPdfExtractOptions,
): Promise<WebAccessPdfText> {
  if (!(data instanceof Uint8Array)) throw new Error('PDF data must be a Uint8Array');
  if (options.tier !== undefined) {
    const tier = resolvePdfTierConfig(options.tier);
    if (!tier.enabled) throw new Error('PDF processing is disabled by config');
    resolvePdfEngine(tier.provider);
  }
  const byteCap = options.maxBytes ?? effectivePdfMaxBytes(options.tier);
  if (data.byteLength > byteCap) {
    throw new Error(`PDF exceeds maximum of ${byteCap} bytes`);
  }
  if (options.signal?.aborted) throw new Error('PDF extraction aborted');
  const tierPages = options.tier !== undefined ? resolvePdfTierConfig(options.tier).maxPages : undefined;
  const maxPages = options.maxPages ?? tierPages ?? WEB_ACCESS_PDF_MAX_PAGES;
  const maxChars = options.maxChars ?? WEB_ACCESS_PDF_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? WEB_ACCESS_PDF_TIMEOUT_MS;
  const controller = new AbortController();
  const forwardAbort = options.signal !== undefined ? () => controller.abort(options.signal?.reason) : undefined;
  if (options.signal !== undefined && forwardAbort !== undefined) {
    options.signal.addEventListener('abort', forwardAbort, { once: true });
  }
  let onExternalAbort: (() => void) | undefined;
  const externalAbort =
    options.signal !== undefined
      ? new Promise<never>((_, reject) => {
          onExternalAbort = () => {
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error('PDF extraction aborted'));
          };
        })
      : undefined;
  if (options.signal !== undefined && onExternalAbort !== undefined)
    options.signal.addEventListener('abort', onExternalAbort, { once: true });
  try {
    const extraction = withTimeout(
      options.extractor(data, { signal: controller.signal, maxPages }),
      timeoutMs,
      controller,
    );
    const raw =
      externalAbort !== undefined ? await Promise.race([extraction, externalAbort]) : await extraction;
    options.signal?.throwIfAborted();
    const totalPages = Number.isInteger(raw.totalPages) && raw.totalPages >= 0 ? raw.totalPages : raw.pages.length;
    const kept = raw.pages.slice(0, maxPages).map((text, index) => ({ page: index + 1, text: cleanPageText(text, maxChars) }));
    const citations = kept.map((p) => ({ page: p.page, cite: `[p. ${p.page}]` }));
    // Page-cited body: `[p. N]` marker then page text. Char cap keeps citations.
    let text = '';
    for (const [index, page] of kept.entries()) {
      const chunk = `${citations[index]?.cite ?? `[p. ${page.page}]`}\n${page.text}\n\n`;
      if ((text + chunk).length > maxChars + 500) break;
      text += chunk;
    }
    text = text.trimEnd();
  if (text.length > maxChars) text = text.slice(0, maxChars);
  const markdown = buildPdfMarkdown(kept, maxChars);
  return { totalPages, pages: kept, citations, text, markdown, truncated: totalPages > kept.length || text.length >= maxChars || markdown.length >= maxChars };
  } finally {
    if (options.signal !== undefined && forwardAbort !== undefined)
      options.signal.removeEventListener('abort', forwardAbort);
    if (options.signal !== undefined && onExternalAbort !== undefined)
      options.signal.removeEventListener('abort', onExternalAbort);
  }
}

// ── Optional unpdf loader (dynamic, manifest untouched) ──
// unpdf ^1.8.1 exposes `getDocumentProxy(data)` plus per-page `getPage(n)`.
// The loader opens the proxy, gates on `numPages`, and reads only the first
// capped pages — never `extractText`, which fans out over ALL pages and
// outlives the caller timeout on huge-page-count PDFs. No OCR: never passes
// image/OCR options; scanned-image PDFs yield empty page text.

interface UnpdfPageProxy {
  getTextContent: () => Promise<{ items: Array<{ str?: unknown; hasEOL?: unknown }> }>;
}

interface UnpdfDocumentProxy {
  numPages: number;
  getPage: (pageNumber: number) => Promise<UnpdfPageProxy>;
  loadingTask?: { destroy: () => Promise<void> } | undefined;
  destroy?: () => Promise<void> | void;
}

interface UnpdfModule {
  getDocumentProxy?: (data: Uint8Array, options?: Record<string, unknown>) => Promise<UnpdfDocumentProxy>;
}

/** Join one page's text items the same way `unpdf` does (`str + hasEOL break`). */
function joinPageItems(items: Array<{ str?: unknown; hasEOL?: unknown }>): string {
  return items
    .filter((item) => typeof item.str === 'string')
    .map((item) => `${item.str as string}${item.hasEOL === true ? '\n' : ''}`)
    .join('');
}

async function destroyProxy(proxy: UnpdfDocumentProxy): Promise<void> {
  try {
    if (proxy.loadingTask) await proxy.loadingTask.destroy();
    else if (typeof proxy.destroy === 'function') await proxy.destroy();
  } catch {
    // Best-effort cleanup; extraction result already captured.
  }
}

/**
 * Bounded extraction over an already-opened document proxy: inspect
 * `numPages` first, then read only the first `maxPages` pages. Never fans
 * out across the full page count, so a sub-10MB huge-page-count PDF cannot
 * outlive the caller timeout in per-page parsing.
 */
export async function extractBoundedProxyPages(
  openProxy: () => Promise<UnpdfDocumentProxy>,
  maxPages: number,
  signal?: AbortSignal | undefined,
): Promise<WebAccessPdfRawResult> {
  signal?.throwIfAborted();
  const pending = openProxy();
  let cleaned = false;
  const cleanupOnce = (proxy: UnpdfDocumentProxy): Promise<void> => {
    if (cleaned) return Promise.resolve();
    cleaned = true;
    return destroyProxy(proxy);
  };
  // getDocumentProxy takes no signal option: when abort/timeout fires before
  // open settles, destroy the eventual proxy when it resolves instead of leaking it.
  pending.then(
    (proxy) => {
      if (signal?.aborted) void cleanupOnce(proxy);
    },
    () => {},
  );
  const proxy = await pending;
  signal?.throwIfAborted();
  // Abort during page reads cannot cancel in-flight getPage promises either:
  // destroy the proxy promptly instead of waiting for page completion.
  const onAbortDuringRead = (): void => {
    void cleanupOnce(proxy);
  };
  signal?.addEventListener('abort', onAbortDuringRead, { once: true });
  try {
    const totalPages =
      Number.isInteger(proxy.numPages) && (proxy.numPages as number) >= 0 ? (proxy.numPages as number) : 0;
    const pageCount = Math.min(totalPages, maxPages);
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      signal?.throwIfAborted();
      const page = await proxy.getPage(pageNumber);
      signal?.throwIfAborted();
      const content = await page.getTextContent();
      signal?.throwIfAborted();
      pages.push(joinPageItems(Array.isArray(content.items) ? content.items : []));
    }
    return { totalPages, pages };
  } finally {
    signal?.removeEventListener('abort', onAbortDuringRead);
    await cleanupOnce(proxy);
  }
}

/** Dynamically import `unpdf` when installed; `undefined` when absent. */
export async function loadUnpdfExtractor(injected?: unknown): Promise<WebAccessPdfExtractor | undefined> {
  let mod: UnpdfModule;
  try {
    // Hard dependency (package.json): dynamic import keeps startup lazy.
    // `injected` is a test-only seam (fake proxy module); production omits it.
    mod = ((injected as UnpdfModule | undefined) ?? ((await import('unpdf')) as UnpdfModule));
  } catch {
    return undefined;
  }
  if (typeof mod.getDocumentProxy !== 'function') return undefined;
  const getDocumentProxy = mod.getDocumentProxy.bind(mod);
  return async (
    data: Uint8Array,
    options?: { signal?: AbortSignal | undefined; maxPages?: number | undefined },
  ) => {
    const maxPages = options?.maxPages ?? WEB_ACCESS_PDF_MAX_PAGES;
    const boundedPages = Math.min(WEB_ACCESS_PDF_MAX_PAGES, Math.max(1, maxPages));
    return extractBoundedProxyPages(() => getDocumentProxy(data), boundedPages, options?.signal);
  };
}
