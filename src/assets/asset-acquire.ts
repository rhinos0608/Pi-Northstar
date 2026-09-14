// Plan B2 bounded acquisition: HTTP(S) fetch with per-hop SSRF checks,
// MIME + magic-byte sniff, image dimension probe, never-truncate ceilings.
//
// Reuses network-policy.ts (assertPublicHostname + resolvePublicHostname)
// on the seed URL and every redirect hop. Exceeding any ceiling throws
// AssetAcquireError — bytes are never truncated.

import { validateHttpUrl } from '../core/http.js';
import { assertPublicHostname, resolvePublicHostname, type DnsLookup } from '../network-policy.js';
import {
  AssetContractError,
  IMAGE_MAX_PIXELS,
  PDF_MAX_PAGES,
  maxBytesForKind,
  type AssetEvidence,
  type AssetKind,
  type AssetSourceKind,
} from './asset-contract.js';

export class AssetAcquireError extends Error {
  readonly code = 'asset_acquire_rejected' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AssetAcquireError';
  }
}

export interface AssetAcquireDeps {
  fetchFn?: typeof fetch | undefined;
  lookup?: DnsLookup | undefined;
  signal?: AbortSignal | undefined;
  /** Max redirect hops followed (default 5). Redirects never followed off https→http. */
  maxRedirects?: number | undefined;
  sourceKind?: AssetSourceKind | undefined;
}

export interface AcquiredAsset {
  url: string;
  finalUrl: string;
  kind: AssetKind;
  mime: string;
  bytes: Uint8Array;
  evidence: AssetEvidence;
  width?: number | undefined;
  height?: number | undefined;
  pdfPagesEstimate?: number | undefined;
}

const MAX_REDIRECTS_DEFAULT = 5;

function sniffKind(bytes: Uint8Array, announced: string | null): AssetKind | 'unknown' {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image';
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image';
  if (
    bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'image';
  if (bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return 'pdf';
  const mime = (announced ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || mime.endsWith('+pdf')) return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  return 'unknown';
}

function isZipBomb(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07);
}

/** PNG IHDR dimensions (big-endian u32 at offsets 16/20). */
function probePng(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 26) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(12) !== 0x49484452) return undefined; // 'IHDR'
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** GIF logical screen dimensions (little-endian u16 at offsets 6/8). */
function probeGif(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** Start-of-frame markers carrying dimensions (SOF0-SOF3, SOF5-SOF11, SOF13-SOF15). */
const JPEG_SOF_MARKERS: ReadonlySet<number> = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** Standalone markers with no length field. */
const JPEG_STANDALONE_MARKERS: ReadonlySet<number> = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);

/** JPEG SOF scan for dimensions without full decode. */
function probeJpeg(bytes: Uint8Array): { width: number; height: number } | undefined {
  let at = 2;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (JPEG_STANDALONE_MARKERS.has(marker)) { at += 2; continue; }
    const len = view.getUint16(at + 2);
    if (len < 2) return undefined;
    if (JPEG_SOF_MARKERS.has(marker)) {
      return { height: view.getUint16(at + 5), width: view.getUint16(at + 7) };
    }
    at += 2 + len;
  }
  return undefined;
}

function probeImageDimensions(bytes: Uint8Array): { width: number; height: number } | { unverified: true } {
  const png = bytes[0] === 0x89 ? probePng(bytes) : undefined;
  if (png) return png;
  const gif = bytes[0] === 0x47 ? probeGif(bytes) : undefined;
  if (gif) return gif;
  const jpeg = bytes[0] === 0xff ? probeJpeg(bytes) : undefined;
  if (jpeg) return jpeg;
  // WebP and other image codecs: no dependency-free probe — byte ceiling
  // only, flagged so callers never claim a pixel check happened.
  return { unverified: true };
}

/**
 * Pre-decode PDF page-count heuristic: max /Count value wins; falls back to
 * counting /Type /Page (not /Pages) nodes. Authoritative counts belong to the
 * consumer (unpdf); this only rejects obvious bombs before parsing.
 */
export function estimatePdfPages(bytes: Uint8Array): number | undefined {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 2_000_000)).toString('latin1');
  let max = -1;
  for (const match of text.matchAll(/\/Count\s+(\d{1,7})/g)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  if (max >= 0) return max;
  const pages = text.match(/\/Type\s*\/Page[^s]/g);
  return pages ? pages.length : undefined;
}

function sniffedName(bytes: Uint8Array): string {
  if (bytes[0] === 0x89) return 'png';
  if (bytes[0] === 0xff) return 'jpeg';
  if (bytes[0] === 0x47) return 'gif';
  if (bytes[0] === 0x52) return 'webp';
  if (bytes[0] === 0x25) return 'pdf';
  return 'unknown';
}

async function readBounded(response: Response, cap: number, label: string): Promise<Uint8Array> {
  if (response.body === null) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > cap) throw new AssetAcquireError(`${label} exceeds maximum of ${cap} bytes (got ${buf.byteLength})`);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* best-effort */ }
      throw new AssetAcquireError(`${label} exceeds maximum of ${cap} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/**
 * Fetch one asset under Plan B ceilings. Throws AssetAcquireError on any
 * ceiling breach, SSRF failure, MIME/magic mismatch, or transport error.
 * Never truncates: over-budget bytes reject the whole asset.
 */
export async function acquireAsset(rawUrl: string, kind: AssetKind, deps: AssetAcquireDeps = {}): Promise<AcquiredAsset> {
  const fetchFn = deps.fetchFn ?? fetch;
  const maxRedirects = deps.maxRedirects ?? MAX_REDIRECTS_DEFAULT;
  const cap = maxBytesForKind(kind);
  let current: string;
  try {
    current = validateHttpUrl(rawUrl);
  } catch (error) {
    throw new AssetAcquireError(`invalid asset url: ${error instanceof Error ? error.message : String(error)}`);
  }

  let response: Response | undefined;
  let hops = 0;
  for (;;) {
    const parsed = new URL(current);
    try {
      assertPublicHostname(parsed.hostname);
      await resolvePublicHostname(parsed.hostname, deps.signal, deps.lookup);
    } catch (error) {
      throw new AssetAcquireError(`blocked asset host: ${error instanceof Error ? error.message : String(error)}`);
    }
    let hop: Response;
    try {
      hop = await fetchFn(current, { redirect: 'manual', ...(deps.signal ? { signal: deps.signal } : {}) });
    } catch (error) {
      throw new AssetAcquireError(`asset fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (hop.status < 300 || hop.status >= 400) { response = hop; break; }
    const location = hop.headers.get('location');
    try { await hop.body?.cancel(); } catch { /* best-effort */ }
    if (!location || hops >= maxRedirects) {
      throw new AssetAcquireError(!location ? `asset redirect without location (status ${hop.status})` : 'asset redirect limit exceeded');
    }
    let next: string;
    try {
      next = validateHttpUrl(new URL(location, current).href);
    } catch {
      throw new AssetAcquireError('asset redirect target is not a public http(s) url');
    }
    // Never downgrade https → http on redirect.
    if (parsed.protocol === 'https:' && next.startsWith('http:')) {
      throw new AssetAcquireError('asset redirect downgrades https to http');
    }
    current = next;
    hops++;
  }

  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* best-effort */ }
    throw new AssetAcquireError(`asset fetch status ${response.status}`);
  }
  const announced = response.headers.get('content-length');
  if (announced !== null) {
    const size = Number(announced);
    if (Number.isFinite(size) && size > cap) {
      try { await response.body?.cancel(); } catch { /* best-effort */ }
      throw new AssetAcquireError(`asset announces ${size} bytes, over maximum of ${cap}`);
    }
  }
  // Stream under the kind ceiling first so bombs reject pre-decode; the
  // aggregate 512MiB ledger (B3) accounts these bytes per fetch.
  const bytes = await readBounded(response, cap, `${kind} asset`);

  // Zip/container payloads are never valid image/pdf/video assets.
  if (isZipBomb(bytes)) {
    throw new AssetAcquireError('asset is a zip container, not image/pdf/video');
  }
  const contentType = response.headers.get('content-type');
  const sniffed = sniffKind(bytes, contentType);
  if (sniffed === 'unknown') {
    throw new AssetAcquireError(`asset magic bytes do not match ${kind} (${sniffedName(bytes)}, content-type ${contentType ?? 'absent'})`);
  }
  if (sniffed !== kind) {
    throw new AssetAcquireError(`asset magic bytes say ${sniffed}, expected ${kind}`);
  }

  const warnings: string[] = [];
  let width: number | undefined;
  let height: number | undefined;
  let pdfPagesEstimate: number | undefined;
  if (kind === 'image') {
    const dims = probeImageDimensions(bytes);
    if ('unverified' in dims) {
      warnings.push('image dimensions unverified for this codec; byte ceiling only');
    } else {
      width = dims.width; height = dims.height;
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new AssetAcquireError('asset image dimensions unreadable');
      }
      if (width * height > IMAGE_MAX_PIXELS) {
        throw new AssetAcquireError(`asset image ${width}x${height} exceeds ${IMAGE_MAX_PIXELS} pixels`);
      }
    }
  }
  if (kind === 'pdf') {
    pdfPagesEstimate = estimatePdfPages(bytes);
    if (pdfPagesEstimate !== undefined && pdfPagesEstimate > PDF_MAX_PAGES) {
      throw new AssetAcquireError(`asset pdf page estimate ${pdfPagesEstimate} exceeds ${PDF_MAX_PAGES}`);
    }
    if (pdfPagesEstimate === undefined) warnings.push('pdf page count unreadable pre-decode; byte ceiling only');
  }
  if (kind === 'video') {
    // DEFERRED-TO-PLAN-D: VIDEO_MAX_MINUTES / VIDEO_MAX_KEYFRAMES (asset-contract)
    // unenforced here — this seam is bytes-only with no container-metadata parser;
    // byte ceiling only. Plan D pipelines own duration/keyframe enforcement.
    warnings.push('video duration/keyframes need container metadata; byte ceiling only');
  }

  return {
    url: rawUrl,
    finalUrl: current,
    kind,
    mime: contentType ?? 'application/octet-stream',
    bytes,
    evidence: {
      kind,
      sourceKind: deps.sourceKind ?? 'extracted',
      bytes: bytes.byteLength,
      warnings,
    },
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(pdfPagesEstimate !== undefined ? { pdfPagesEstimate } : {}),
  };
}

/** Re-throw contract-shaped ceiling errors as acquire errors (shared helper). */
export function toAcquireError(error: unknown): AssetAcquireError {
  if (error instanceof AssetAcquireError) return error;
  if (error instanceof AssetContractError) return new AssetAcquireError(error.message);
  return new AssetAcquireError(error instanceof Error ? error.message : String(error));
}
