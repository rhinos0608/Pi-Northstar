// Image pipeline (Plan D Task D4): acquire → MIME/magic → dimensions →
// OCR + description as separate evidence kinds.
//
// Shared vision-evidence contract for all three pipelines (single spelling):
// sourceKind 'extracted' = bytes already present locally (OCR text read from
// the asset, PDF text layer, media metadata/transcript); 'derived' = text a
// vision model generated about the asset. OCR and description are always
// distinct entries with page/timestamp locators + warnings. Ranking flows
// through the existing chunker/BM25/RRF primitives (embedding seam optional).
//
// Vision calls arrive via injected seams so tests mock them with counters;
// sibling W-D1 eligibility/probe files are mid-write, so no static import of
// those modules exists here (mismatch reported to parent).

import { chunkText, type TextChunk } from '../search/chunker.js';
import { BM25Index } from '../search/bm25.js';
import { rrfMerge } from '../search/fusion.js';
import { analyzeUntrustedText } from '../core/untrusted-content.js';

/** Hard ceilings (operator-lower-only): image 20MiB / 40MP per master plan. */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_MEGAPIXELS = 40;

/** Evidence provenance: bytes already local vs model-generated about bytes. */
export type VisionSourceKind = 'extracted' | 'derived';

export interface EvidenceLocator {
  page?: number | undefined;
  timestampMs?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  region?: string | undefined;
}

export interface VisionEvidence {
  sourceKind: VisionSourceKind;
  /** Distinct evidence kind: 'ocr' | 'description' | 'pdf-text' | 'metadata' | 'transcript' | 'keyframe'. */
  kind: string;
  text: string;
  locator: EvidenceLocator;
  warnings: string[];
}

export interface ImageVisionSeams {
  ocrImage(image: { bytes: Uint8Array; mimeType: string }): Promise<{ text: string; warnings?: string[] | undefined }>;
  describeImage(image: { bytes: Uint8Array; mimeType: string }): Promise<{ text: string; warnings?: string[] | undefined }>;
}

export type ImagePipelineResult =
  | { ok: true; evidence: VisionEvidence[]; warnings: string[] }
  | { ok: false; reason: string; warnings: string[] };

export interface DetectedImage {
  mimeType: string;
  width?: number | undefined;
  height?: number | undefined;
}

/** Magic-byte sniff; unknown bytes reject (never guessed). */
export function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
    bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif';
  }
  if (bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

function u16be(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) * 256 + (bytes[at + 1] ?? 0);
}

function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 256;
}

function u24le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) * 256 + (bytes[at + 2] ?? 0) * 65536;
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at] ?? 0) +
    (bytes[at + 1] ?? 0) * 256 +
    (bytes[at + 2] ?? 0) * 65536 +
    (bytes[at + 3] ?? 0) * 16777216
  );
}

/** Best-effort dimension parse for PNG/GIF/JPEG/WebP; undefined when unreadable. */
export function readImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  try {
    if (mimeType === 'image/png' && bytes.length >= 24) {
      const width = (bytes[16] ?? 0) * 16777216 + (bytes[17] ?? 0) * 65536 + (bytes[18] ?? 0) * 256 + (bytes[19] ?? 0);
      const height = (bytes[20] ?? 0) * 16777216 + (bytes[21] ?? 0) * 65536 + (bytes[22] ?? 0) * 256 + (bytes[23] ?? 0);
      if (width > 0 && height > 0) return { width, height };
      return undefined;
    }
    if (mimeType === 'image/gif' && bytes.length >= 10) {
      const width = u16le(bytes, 6);
      const height = u16le(bytes, 8);
      if (width > 0 && height > 0) return { width, height };
      return undefined;
    }
    if (mimeType === 'image/jpeg') {
      let at = 2;
      while (at + 9 < bytes.length) {
        if (bytes[at] !== 0xff) break;
        const marker = bytes[at + 1] ?? 0;
        const len = u16be(bytes, at + 2);
        if (len < 2) break;
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const height = u16be(bytes, at + 5);
          const width = u16be(bytes, at + 7);
          if (width > 0 && height > 0) return { width, height };
          return undefined;
        }
        at += 2 + len;
      }
      return undefined;
    }
    if (mimeType === 'image/webp' && bytes.length >= 16) {
      const tag = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
      if (tag === 'VP8 ' && bytes.length >= 30) {
        const width = u16le(bytes, 26) & 0x3fff;
        const height = u16le(bytes, 28) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8L' && bytes.length >= 25) {
        // Lossless bitstream: byte 20 is the 0x2f signature, bytes 21-24 pack
        // 14-bit (width - 1) in bits 0-13 and 14-bit (height - 1) in bits
        // 14-27. The top height bits live in byte 24, so all four bytes are
        // required; `>>>` avoids signed 32-bit truncation of the height field.
        const bits = u32le(bytes, 21);
        const width = (bits & 0x3fff) + 1;
        const height = ((bits >>> 14) & 0x3fff) + 1;
        if (width > 0 && height > 0) return { width, height };
      } else if (tag === 'VP8X' && bytes.length >= 30) {
        const width = u24le(bytes, 24) + 1;
        const height = u24le(bytes, 27) + 1;
        if (width > 0 && height > 0) return { width, height };
      }
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Flag prompt-injection-shaped provider text as warnings (never redacts). */
export function untrustedWarnings(text: string, surface: string): string[] {
  const analysis = analyzeUntrustedText(text);
  const warnings: string[] = [];
  if (analysis.instructionLanguage || analysis.encodedDirectives) {
    warnings.push(`${surface}-possible-prompt-injection`);
  }
  if (analysis.unicodeFormatting || analysis.controlChars) warnings.push(`${surface}-suspicious-formatting`);
  return warnings;
}

/**
 * Full image pipeline. Admission rejects (empty/unknown/oversize) before any
 * vision call. OCR and description are always separate evidence entries.
 */
export async function runImagePipeline(
  bytes: Uint8Array,
  seams: ImageVisionSeams,
  mimeHint?: string | undefined,
): Promise<ImagePipelineResult> {
  if (bytes.byteLength === 0) return { ok: false, reason: 'empty-bytes', warnings: [] };
  if (bytes.byteLength > IMAGE_MAX_BYTES) {
    return { ok: false, reason: 'over-byte-ceiling', warnings: ['image-over-byte-ceiling'] };
  }
  const sniffed = sniffImageMime(bytes);
  if (sniffed === undefined) return { ok: false, reason: 'unknown-image-type', warnings: [] };
  if (mimeHint !== undefined && mimeHint !== sniffed) {
    return { ok: false, reason: 'unknown-image-type', warnings: [] };
  }
  const mimeType = sniffed;

  const warnings: string[] = [];
  const dims = readImageDimensions(bytes, mimeType);
  const locator: EvidenceLocator = dims === undefined
    ? {}
    : { width: dims.width, height: dims.height };
  if (dims === undefined) {
    warnings.push('dimensions-unreadable');
  } else {
    const megapixels = (dims.width * dims.height) / 1_000_000;
    if (megapixels > IMAGE_MAX_MEGAPIXELS) {
      return { ok: false, reason: 'over-megapixel-ceiling', warnings: ['image-over-megapixel-ceiling'] };
    }
  }

  const image = { bytes, mimeType };
  const [ocr, description] = await Promise.all([
    seams.ocrImage(image),
    seams.describeImage(image),
  ]);
  const evidence: VisionEvidence[] = [];
  if (ocr.text.trim().length > 0) {
    evidence.push({
      sourceKind: 'extracted',
      kind: 'ocr',
      text: ocr.text,
      locator: { ...locator },
      warnings: [...(ocr.warnings ?? []), ...untrustedWarnings(ocr.text, 'ocr')],
    });
  } else {
    warnings.push('ocr-empty');
  }
  if (description.text.trim().length > 0) {
    evidence.push({
      sourceKind: 'derived',
      kind: 'description',
      text: description.text,
      locator: { ...locator },
      warnings: [...(description.warnings ?? []), ...untrustedWarnings(description.text, 'description')],
    });
  } else {
    warnings.push('description-empty');
  }
  return { ok: true, evidence, warnings };
}

export interface RankedVisionChunk {
  chunk: TextChunk;
  evidenceIndex: number;
  bm25Score: number;
}

/** Chunk each evidence text with the existing chunker, tagged by evidence index. */
export function chunkVisionEvidence(
  evidence: readonly VisionEvidence[],
  options?: { maxChars?: number | undefined; overlap?: number | undefined; minChars?: number | undefined } | undefined,
): Array<{ chunk: TextChunk; evidenceIndex: number }> {
  const out: Array<{ chunk: TextChunk; evidenceIndex: number }> = [];
  evidence.forEach((item, evidenceIndex) => {
    if (item.text.trim().length === 0) return;
    // Evidence texts are already atomic units: keep short OCR/transcript
    // strings rankable instead of dropping them at the chunker default.
    const chunkOptions = options === undefined
      ? { minChars: 1 }
      : {
        ...(options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        ...(options.overlap !== undefined ? { overlap: options.overlap } : {}),
        ...(options.minChars !== undefined ? { minChars: options.minChars } : { minChars: 1 }),
      };
    for (const chunk of chunkText(item.text, chunkOptions)) {
      out.push({ chunk, evidenceIndex });
    }
  });
  return out;
}

/** Score evidence chunks for a query with the existing BM25 index. */
export function rankVisionChunks(
  chunked: ReadonlyArray<{ chunk: TextChunk; evidenceIndex: number }>,
  query: string,
): RankedVisionChunk[] {
  const index = new BM25Index();
  chunked.forEach((entry, id) => index.add(String(id), entry.chunk.text));
  const scores = index.search(query);
  const byId = new Map(scores.map((s) => [s.id, s.score]));
  return chunked
    .map((entry, id) => ({
      chunk: entry.chunk,
      evidenceIndex: entry.evidenceIndex,
      bm25Score: byId.get(String(id)) ?? 0,
    }))
    .sort((a, b) => b.bm25Score - a.bm25Score);
}

/**
 * Fuse the BM25 ranking with original evidence order through the existing
 * RRF primitive. Both rankings reference chunk positions ("c:<id>").
 */
export function fuseVisionRankings(
  bm25OrderedIds: readonly number[],
  evidenceOrderedIds: readonly number[],
): Array<{ id: number; rrfScore: number }> {
  const key = (id: number): string => `c:${id}`;
  const merged = rrfMerge<string>(
    [bm25OrderedIds.map(key), evidenceOrderedIds.map(key)],
    { keyFn: (item) => item },
  );
  return merged.map((entry) => ({
    id: Number.parseInt(entry.item.slice(2), 10),
    rrfScore: entry.rrfScore,
  }));
}
