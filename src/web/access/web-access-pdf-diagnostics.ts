// Scanned-PDF degraded marking helper (M6, local-only): surfaces honest
// degradation from the local unpdf path. Built on runPdfPipeline with an
// extractor only and no describePage seam, so no cloud render can trigger;
// returns warnings only (never content), leaving the existing `[p. N]`
// citation text policy in extractWebAccessPdfText untouched.

import { runPdfPipeline } from '../../media-vision/pipeline-pdf.js';
import type { WebAccessPdfExtractor } from './web-access-pdf.js';

export interface PdfSparseDiagnostics {
  warnings: string[];
  totalPages: number;
}

/**
 * Run sparse-page diagnostics over already-fetched PDF bytes. Resolves with
 * the pipeline warnings (e.g. `page-N-possibly-scanned-no-vision`) and the
 * total page count, or with the failure warnings (e.g.
 * `pdf-extraction-failed`) and zero pages when extraction rejects. Never
 * throws for pipeline-level failures; an aborted signal still rejects.
 */
export async function pdfSparsePageWarnings(
  bytes: Uint8Array,
  extractor: WebAccessPdfExtractor,
  signal?: AbortSignal | undefined,
): Promise<PdfSparseDiagnostics> {
  const result = await runPdfPipeline(bytes, {
    extractor,
    ...(signal !== undefined ? { signal } : {}),
  });
  if (!result.ok) return { warnings: result.warnings, totalPages: 0 };
  return { warnings: result.warnings, totalPages: result.totalPages };
}
