// PDF pipeline (Plan D Task D4): unpdf local text first, scanned/layout
// pages escalate to vision. Extends the src/web/access/web-access-pdf.ts seam
// (extractor injected, same bounds); vision arrives via injected seams so
// tests mock it with counters. Local text is 'extracted'; vision-generated
// page readings are 'derived'. Both are distinct entries with page locators.

import type { WebAccessPdfExtractor } from '../web/access/web-access-pdf.js';
import {
  WEB_ACCESS_PDF_MAX_BYTES,
  WEB_ACCESS_PDF_MAX_CHARS,
  WEB_ACCESS_PDF_MAX_PAGES,
} from '../web/access/web-access-pdf.js';
import {
  untrustedWarnings,
  type EvidenceLocator,
  type VisionEvidence,
} from './pipeline-image.js';

/** PDF ceilings mirror the web-access seam (operator-lower-only).
 * Tiered default: 20 MiB / 100 pages. Hosted engines (datalab/gemini
 * transfer) stay OUT until explicit operator opt-in plus the
 * PI_VISION_PRIVATE transfer gate: `auto` resolves to local unpdf only.
 * Open seam: attach a page-image renderer + hosted engine option behind
 * resolvePdfEngine in web-access-pdf.ts; keep PI_VISION_PDF_CLOUD_RENDER
 * fail-closed until then. */
export const PDF_MAX_BYTES = WEB_ACCESS_PDF_MAX_BYTES;
export const PDF_MAX_PAGES = WEB_ACCESS_PDF_MAX_PAGES;
export const PDF_MAX_CHARS = WEB_ACCESS_PDF_MAX_CHARS;

/** No hosted PDF engine is available in this tree (local-only posture). */
export const PDF_HOSTED_ENGINES_AVAILABLE = false as const;

/** A page is vision-escalation-worthy when local text is sparse/empty. */
export const PDF_SCANNED_PAGE_MIN_CHARS = 48;

export interface PdfVisionSeams {
  extractor: WebAccessPdfExtractor;
  /**
   * Describe one page through vision. Absent = no escalation (warn + local
   * evidence only). Never fabricates: empty text yields a warning, not an entry.
   */
  describePage?: ((input: { page: number; hintText: string }) => Promise<{ text: string; warnings?: string[] | undefined }>) | undefined;
  signal?: AbortSignal | undefined;
}

export type PdfPipelineResult =
  | { ok: true; totalPages: number; evidence: VisionEvidence[]; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

function pageLocator(page: number): EvidenceLocator {
  return { page };
}

/**
 * Full PDF pipeline. Admission rejects before extraction; extractor errors
 * degrade to ok:false (caller falls back to the page reader). Vision
 * escalation applies per sparse page only.
 *
 * Explicit-vision entry point (NOT the fetch hot path): the live fetch PDF
 * path (extractWebAccessPdfText) keeps its own citation-marker text policy
 * and stays local-only by transfer posture — fetch never supplies a
 * describePage seam, so no PDF fetch can implicitly trigger cloud vision.
 * Cloud rendering additionally requires PI_VISION_PDF_CLOUD_RENDER=exact '1'
 * (see isPdfCloudRenderOptIn) AND a page-image renderer, which the repo does
 * not have yet (unpdf ships no render API, no canvas backend — plan TODO).
 * Until a renderer exists the flag stays fail-closed: local text plus
 * page-N-possibly-scanned-no-vision warnings.
 */
/** Exact-'1' opt-in for sparse-page cloud rendering. Accepted as config
 *  today but fail-closed until a page-image renderer exists (see above). */
export const PDF_CLOUD_RENDER_ENV_VAR = 'PI_VISION_PDF_CLOUD_RENDER';

export function isPdfCloudRenderOptIn(env: Record<string, string | undefined> = process.env): boolean {
  return env[PDF_CLOUD_RENDER_ENV_VAR] === '1';
}

export async function runPdfPipeline(
  bytes: Uint8Array,
  seams: PdfVisionSeams,
): Promise<PdfPipelineResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty-bytes', warnings: [] };
  if (bytes.byteLength > PDF_MAX_BYTES) {
    return { ok: false, reason: 'over-byte-ceiling', warnings: ['pdf-over-byte-ceiling'] };
  }
  let raw: { totalPages: number; pages: string[] };
  try {
    raw = await seams.extractor(bytes, { signal: seams.signal });
  } catch {
    return { ok: false, reason: 'extraction-failed', warnings: ['pdf-extraction-failed'] };
  }
  if (raw.totalPages > PDF_MAX_PAGES) {
    return { ok: false, reason: 'over-page-ceiling', warnings: ['pdf-over-page-ceiling'] };
  }

  const warnings: string[] = [];
  const evidence: VisionEvidence[] = [];
  let chars = 0;
  const pageCount = Math.min(raw.totalPages, raw.pages.length);
  for (let i = 0; i < pageCount; i += 1) {
    const page = i + 1;
    const localText = (raw.pages[i] ?? '').replace(/\r\n/g, '\n').trim();
    if (localText.length > 0) {
      const slice = localText.slice(0, PDF_MAX_CHARS - chars);
      evidence.push({
        sourceKind: 'extracted',
        kind: 'pdf-text',
        text: slice,
        locator: pageLocator(page),
        warnings: untrustedWarnings(slice, 'pdf-text'),
      });
      chars += slice.length;
    }
    const sparse = localText.length < PDF_SCANNED_PAGE_MIN_CHARS;
    if (sparse && seams.describePage !== undefined) {
      const derived = await seams.describePage({ page, hintText: localText });
      if (derived.text.trim().length > 0) {
        evidence.push({
          sourceKind: 'derived',
          kind: 'description',
          text: derived.text,
          locator: pageLocator(page),
          warnings: [...(derived.warnings ?? []), ...untrustedWarnings(derived.text, 'description')],
        });
      } else {
        warnings.push(`page-${page}-vision-empty`);
      }
    } else if (sparse) {
      warnings.push(`page-${page}-possibly-scanned-no-vision`);
    }
    if (chars >= PDF_MAX_CHARS) {
      warnings.push('pdf-char-ceiling');
      break;
    }
  }
  if (evidence.length === 0) warnings.push('no-extractable-text');
  return { ok: true, totalPages: raw.totalPages, evidence, warnings };
}
