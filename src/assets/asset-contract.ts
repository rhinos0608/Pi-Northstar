// Plan B asset contract: shared ceilings + evidence shape for the asset pipeline.
//
// Pure vocabulary only. No network, no disk, no provider imports.
// Consumers: asset-acquire (B2), budget-ledger (B3), asset-retention (B4).

import { randomUUID } from 'node:crypto';

/** Raw-asset admission ceilings (reject-never-truncate: exceed → throw). */
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;
export const PDF_MAX_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_PAGES = 100;
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
export const VIDEO_MAX_MINUTES = 120;
export const VIDEO_MAX_KEYFRAMES = 12;

/** Per-fetch aggregate accounting ceiling shared with the budget ledger (B3). */
export const AGGREGATE_MAX_BYTES = 512 * 1024 * 1024;

/** Asset provenance: fetched bytes vs pipeline output. */
export type AssetSourceKind = 'extracted' | 'derived';

/** Raw asset kinds admitted by the pipeline. */
export type AssetKind = 'image' | 'pdf' | 'video';

/**
 * Locator for derived evidence: PDF page, video timestamp (seconds),
 * or free-form location label. All fields optional; at least one is
 * expected when the evidence is derived from a sub-range.
 */
export interface AssetLocator {
  page?: number | undefined;
  timestamp?: number | undefined;
  location?: string | undefined;
}

/** Bounded evidence record carried for each admitted asset. */
export interface AssetEvidence {
  kind: AssetKind;
  sourceKind: AssetSourceKind;
  bytes: number;
  locator?: AssetLocator | undefined;
  /** Non-fatal caveats (unverified dimensions, heuristic page count, ...). */
  warnings: string[];
}

export class AssetContractError extends Error {
  readonly code = 'asset_rejected' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AssetContractError';
  }
}

/** UTF-8 byte length of a string (admission accounting unit). */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Admit a UTF-8 string under a byte budget. Returns the byte length.
 * Throws AssetContractError when over budget (never truncates).
 */
export function assertUtf8Admitted(value: string, maxBytes: number, label: string): number {
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) {
    throw new AssetContractError(`${label} exceeds maximum of ${maxBytes} bytes (got ${bytes})`);
  }
  return bytes;
}

/** Byte ceiling by asset kind. */
export function maxBytesForKind(kind: AssetKind): number {
  switch (kind) {
    case 'image':
      return IMAGE_MAX_BYTES;
    case 'pdf':
      return PDF_MAX_BYTES;
    case 'video':
      return VIDEO_MAX_BYTES;
  }
}

/**
 * Default per-entry owner id for the content store when no session id is
 * threaded through: random, isolated, non-shared. Cross-call retrieve under
 * this fallback is not expected to hit; acceptable until session threading
 * lands (Plan B1). Job-derived entries use the job id as owner instead.
 */
export function createAssetOwnerId(randomId?: () => string): string {
  if (randomId) return randomId();
  return randomUUID();
}
