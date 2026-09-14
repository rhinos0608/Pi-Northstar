// Plan B3 budget ledger: per-fetch aggregate byte accounting + honest
// token-preflight tiers. Tracks bytes/tokens safety bounds only — no
// monetary cost control (backend owns cost).

import { AGGREGATE_MAX_BYTES } from './asset-contract.js';

/** Authoritative token preflight requires count APIs (250k/asset, 1M aggregate). */
export const PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET = 250_000;
export const PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE = 1_000_000;

export class BudgetLedgerError extends Error {
  readonly code = 'budget_exceeded' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BudgetLedgerError';
  }
}

/**
 * Preflight honesty tiers:
 * - 'authoritative': a countTokens-style API measured real input tokens.
 * - 'bounded-bytes': no count API (e.g. OpenAI-compatible path) — hard
 *   media/byte bounds + post-response usage checks only. Callers on this
 *   tier MUST NOT claim preflight happened.
 */
export type PreflightTier = 'authoritative' | 'bounded-bytes';

/** Resolve the tier from count-API capability. No count API → bounded-bytes. */
export function resolvePreflightTier(hasCountTokensApi: boolean): PreflightTier {
  return hasCountTokensApi ? 'authoritative' : 'bounded-bytes';
}

export interface TokenPreflightInput {
  tier: PreflightTier;
  /** Measured input tokens for this asset (authoritative tier only). */
  assetInputTokens?: number | undefined;
  /** Measured aggregate input tokens so far (authoritative tier only). */
  aggregateInputTokens?: number | undefined;
  /** True when the caller would report that preflight ran. */
  claimsPreflight?: boolean | undefined;
}

/**
 * Enforce the token preflight split by capability. Authoritative path
 * enforces 250k input tokens/asset + 1M aggregate via measured counts.
 * Bounded-bytes path asserts must-not-claim preflight and passes (byte
 * bounds are enforced by acquisition + the byte ledger).
 */
export function checkTokenPreflight(input: TokenPreflightInput): void {
  if (input.tier === 'bounded-bytes') {
    if (input.claimsPreflight === true) {
      throw new BudgetLedgerError('bounded-bytes tier must not claim token preflight');
    }
    return;
  }
  checkAuthoritativePreflight(input.assetInputTokens, input.aggregateInputTokens);
}

/** Spec alias: enforcePreflightTokens() is checkTokenPreflight. */
export const enforcePreflightTokens: typeof checkTokenPreflight = checkTokenPreflight;

/** Authoritative tier: measured counts enforced at 250k/asset + 1M aggregate. */
function checkAuthoritativePreflight(assetInputTokens: number | undefined, aggregateInputTokens: number | undefined): void {
  if (assetInputTokens === undefined || aggregateInputTokens === undefined) {
    throw new BudgetLedgerError('authoritative tier requires measured asset and aggregate input tokens');
  }
  if (assetInputTokens > PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET) {
    throw new BudgetLedgerError(
      `asset input tokens ${assetInputTokens} exceed ${PREFLIGHT_MAX_INPUT_TOKENS_PER_ASSET}`,
    );
  }
  if (aggregateInputTokens > PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE) {
    throw new BudgetLedgerError(
      `aggregate input tokens ${aggregateInputTokens} exceed ${PREFLIGHT_MAX_INPUT_TOKENS_AGGREGATE}`,
    );
  }
}

/**
 * Per-fetch byte ledger. Concurrent acquires in one fetch share one
 * instance; reservations exceeding 512MiB aggregate reject. Release on
 * asset rejection so failed acquires do not pin budget.
 */
export class AssetBudgetLedger {
  private usedBytes = 0;
  constructor(private readonly maxBytes: number = AGGREGATE_MAX_BYTES) {}

  get used(): number {
    return this.usedBytes;
  }

  get remaining(): number {
    return this.maxBytes - this.usedBytes;
  }

  /** Reserve bytes; throws BudgetLedgerError when the aggregate would exceed. */
  reserve(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) {
      throw new BudgetLedgerError(`invalid reservation: ${String(bytes)}`);
    }
    if (this.usedBytes + bytes > this.maxBytes) {
      throw new BudgetLedgerError(
        `aggregate asset budget exceeded: ${this.usedBytes + bytes} > ${this.maxBytes}`,
      );
    }
    this.usedBytes += bytes;
  }

  /** Release a prior reservation (asset rejected or evicted). Never below zero. */
  release(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.usedBytes = Math.max(0, this.usedBytes - bytes);
  }
}
