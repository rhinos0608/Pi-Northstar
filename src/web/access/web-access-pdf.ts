// Pi Web Access final: bounded local PDF text extraction.
//
// Local-only (no OCR, no cloud). `unpdf` (^1.8.1) is a hard dependency and
// loads via dynamic import; when extraction fails the caller injects an
// extractor (tests) or fetch falls back to the page reader.
// Bounds live here (not in the shared contract): byte cap, page cap, timeout,
// char cap. Page citations use `[p. N]` markers.

export const WEB_ACCESS_PDF_MAX_BYTES = 10 * 1024 * 1024;
export const WEB_ACCESS_PDF_MAX_PAGES = 50;
export const WEB_ACCESS_PDF_TIMEOUT_MS = 30_000;
export const WEB_ACCESS_PDF_MAX_CHARS = 50_000;

export interface WebAccessPdfRawResult {
  totalPages: number;
  pages: string[];
}

export type WebAccessPdfExtractor = (
  data: Uint8Array,
  options?: { signal?: AbortSignal | undefined },
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
  truncated: boolean;
}

export interface WebAccessPdfExtractOptions {
  extractor: WebAccessPdfExtractor;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  maxPages?: number | undefined;
  maxChars?: number | undefined;
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
  if (data.byteLength > WEB_ACCESS_PDF_MAX_BYTES) {
    throw new Error(`PDF exceeds maximum of ${WEB_ACCESS_PDF_MAX_BYTES} bytes`);
  }
  if (options.signal?.aborted) throw new Error('PDF extraction aborted');
  const maxPages = options.maxPages ?? WEB_ACCESS_PDF_MAX_PAGES;
  const maxChars = options.maxChars ?? WEB_ACCESS_PDF_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? WEB_ACCESS_PDF_TIMEOUT_MS;
  const controller = new AbortController();
  if (options.signal) options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  const raw = await withTimeout(options.extractor(data, { signal: controller.signal }), timeoutMs, controller);
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
  return { totalPages, pages: kept, citations, text, truncated: totalPages > kept.length || text.length >= maxChars };
}

// ── Optional unpdf loader (dynamic, manifest untouched) ──
// unpdf ^1.8.1 exposes `extractText(data, { mergePages })`. Shape varies
// (string vs string[] text), so adapt best-effort to per-page output. No OCR:
// never passes image/OCR options; scanned-image PDFs yield empty page text.

interface UnpdfModule {
  extractText?: (data: Uint8Array, options?: Record<string, unknown>) => Promise<unknown>;
}

function adaptUnpdfResult(result: unknown): WebAccessPdfRawResult {
  if (typeof result === 'object' && result !== null) {
    const record = result as Record<string, unknown>;
    const totalPages =
      typeof record.totalPages === 'number' && Number.isInteger(record.totalPages)
        ? (record.totalPages as number)
        : Array.isArray(record.text)
          ? (record.text as unknown[]).length
          : 1;
    if (Array.isArray(record.text)) {
      return { totalPages, pages: (record.text as unknown[]).map((t) => (typeof t === 'string' ? t : '')) };
    }
    if (typeof record.text === 'string') return { totalPages, pages: [record.text as string] };
  }
  if (typeof result === 'string') return { totalPages: 1, pages: [result] };
  return { totalPages: 0, pages: [] };
}

/** Dynamically import `unpdf` when installed; `undefined` when absent. */
export async function loadUnpdfExtractor(): Promise<WebAccessPdfExtractor | undefined> {
  let mod: UnpdfModule;
  try {
    // Hard dependency (package.json): dynamic import keeps startup lazy.
    // @ts-ignore - unpdf has no bundled types here; runtime shape checked below.
    mod = (await import('unpdf')) as UnpdfModule;
  } catch {
    return undefined;
  }
  if (typeof mod.extractText !== 'function') return undefined;
  const extractText = mod.extractText.bind(mod);
  return async (data: Uint8Array, options?: { signal?: AbortSignal | undefined }) =>
    adaptUnpdfResult(
      await extractText(data, {
        mergePages: false,
        ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      }),
    );
}
