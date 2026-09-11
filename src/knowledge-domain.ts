// Knowledge domain routing/capability orchestration (design sections 6-8, 14).
// Internal capability introspection only: action → capable providers in
// priority order. No tool registration, no config, no HTTP here.

import {
  decodeKgCursor,
  encodeKgCursor,
  KgContractError,
  type DecodedKgCursor,
  type KgAction,
  type KgCursorState,
  type KgError,
  type KgSourceOutcome,
} from './knowledge-contract.js';

/** Deterministic provider priority. First capable configured provider wins auto mode. */
export const KG_PROVIDER_PRIORITY = ['diffbot'] as const;

export type KgDomainProvider = (typeof KG_PROVIDER_PRIORITY)[number];

/** Action → capable providers in priority order (internal introspection only). */
export const KG_ACTION_PROVIDERS: Record<KgAction, readonly string[]> = {
  search: ['diffbot'],
  enhance: ['diffbot'],
  analyze_text: ['diffbot'],
};

/** Capable providers for an action, in priority order. Unknown action → empty. */
export function capableProvidersFor(action: KgAction): readonly string[] {
  return KG_ACTION_PROVIDERS[action] ?? [];
}

/**
 * Omitted-providers auto selection: capable ∩ configured, priority order.
 * Caller tries entries sequentially; first entry is deterministic pick.
 */
export function selectAutoProviders(action: KgAction, configured: Iterable<string>): string[] {
  const available = new Set(configured);
  return capableProvidersFor(action).filter((provider) => available.has(provider));
}

/** Default explicit-providers cap (mirrors DIFFBOT_MAX_PROVIDERS default). */
export const KG_DEFAULT_MAX_PROVIDERS = 3;

/** Hard ceiling for explicit providers (mirrors DIFFBOT_MAX_PROVIDERS ceiling). */
export const KG_MAX_PROVIDERS_CEILING = 8;

export interface KgExplicitPlan {
  /** Requested providers runnable now, in requested order (deduped). */
  runnable: string[];
  /** One typed partition per requested provider that cannot run. Never silently skip. */
  unsupported: KgError[];
}

export interface KgExplicitPlanOptions {
  /** Configured providers; defaults to full registry priority list. */
  configured?: Iterable<string>;
  /** Explicit fanout cap; reject-on-out-of-range, never clamp. */
  maxProviders?: number;
}

/** Typed per-provider partition: unknown/incapable/unconfigured/over-cap. */
export function buildUnsupportedKgError(provider: string, message: string): KgError {
  return { code: 'unsupported_option', message, retryable: false, provider };
}

/**
 * Explicit allowlist plan: runnable ∩ capable ∩ configured run concurrently;
 * every other requested name becomes a typed unsupported_option partition.
 * Never expands beyond requested names; over-cap extras partition in order.
 */
export function planExplicitProviders(
  action: KgAction,
  requested: readonly string[],
  opts: KgExplicitPlanOptions = {},
): KgExplicitPlan {
  const maxProviders = opts.maxProviders ?? KG_DEFAULT_MAX_PROVIDERS;
  if (!Number.isInteger(maxProviders) || maxProviders < 1 || maxProviders > KG_MAX_PROVIDERS_CEILING) {
    throw new KgContractError(
      'unsupported_option',
      `maxProviders out of range: expected integer 1..${KG_MAX_PROVIDERS_CEILING}`,
    );
  }
  const available = opts.configured === undefined ? new Set(KG_PROVIDER_PRIORITY) : new Set(opts.configured);
  const seen = new Set<string>();
  const runnable: string[] = [];
  const unsupported: KgError[] = [];
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!KG_PROVIDER_PRIORITY.includes(name as KgDomainProvider)) {
      unsupported.push(buildUnsupportedKgError(name, `Unknown kg provider: ${name}.`));
    } else if (!capableProvidersFor(action).includes(name)) {
      unsupported.push(buildUnsupportedKgError(name, `Provider ${name} does not support action ${action}.`));
    } else if (!available.has(name)) {
      unsupported.push(buildUnsupportedKgError(name, `Provider ${name} is not configured.`));
    } else if (runnable.length >= maxProviders) {
      unsupported.push(
        buildUnsupportedKgError(name, `Provider ${name} exceeds maxProviders cap (${maxProviders}).`),
      );
    } else {
      runnable.push(name);
    }
  }
  return { runnable, unsupported };
}

export type KgExecutor = (provider: string) => Promise<KgSourceOutcome>;

/** Explicit fanout: concurrent execution over runnable allowlist only. */
export async function runKgFanout(execute: KgExecutor, runnable: readonly string[]): Promise<KgSourceOutcome[]> {
  const settled = await Promise.allSettled(runnable.map((provider) => execute(provider)));
  return settled.map((entry, index) => {
    const provider = runnable[index] as string;
    if (entry.status === 'fulfilled') return entry.value;
    const message = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
    return { provider, entities: [], error: { code: 'transport_invalid_response', message, retryable: true } };
  });
}

/**
 * Recoverable outcome: failover to next provider is allowed for transport,
 * contract, and semantic invalid responses plus all-invalid rows. This
 * failover grant is independent of same-provider paid retry (retryable flag):
 * contract/semantic failures fail over without becoming retryable.
 * Upstream, size, input, and unsupported failures stay terminal.
 */
export function isRecoverableKgOutcome(outcome: KgSourceOutcome): boolean {
  if (outcome.error) {
    return (
      outcome.error.code === 'transport_invalid_response' ||
      outcome.error.code === 'contract_invalid_response' ||
      outcome.error.code === 'semantic_invalid_response'
    );
  }
  return (outcome.entities?.length ?? 0) === 0 && (outcome.invalid ?? 0) > 0;
}

export interface KgAutoResult {
  outcome: KgSourceOutcome;
  attempted: string[];
}

/**
 * Omitted-provider auto execution: sequential in priority order, advancing
 * only on recoverable outcomes. Success (including clean empty) and
 * non-retryable errors stop immediately. No hidden fanout: strictly serial.
 */
export async function runKgAuto(execute: KgExecutor, ordered: readonly string[]): Promise<KgAutoResult> {
  if (ordered.length === 0) {
    throw new KgContractError('unsupported_option', 'No capable configured kg provider is available.');
  }
  const attempted: string[] = [];
  let last: KgSourceOutcome | undefined;
  for (const provider of ordered) {
    attempted.push(provider);
    const outcome = await execute(provider);
    last = outcome;
    if (!isRecoverableKgOutcome(outcome)) return { outcome, attempted };
  }
  return { outcome: last as KgSourceOutcome, attempted };
}

// ── Request fingerprint + single-provider cursor ──

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Deterministic request fingerprint (query+providers+limit hash input). Key-order independent. */
export function fingerprintKgRequest(value: unknown): string {
  const text = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface KgIssueCursorInput {
  provider: string;
  fingerprint: string;
  adapterCursorV: number;
  state: KgCursorState;
  /** Explicit fanout never issues a cursor: one bounded page, no continuation. */
  fanout: boolean;
}

/** Issue opaque cursor for single-provider auto mode; undefined for fanout. */
export function issueKgCursor(input: KgIssueCursorInput): string | undefined {
  if (input.fanout) return undefined;
  return encodeKgCursor({
    provider: input.provider,
    fingerprint: input.fingerprint,
    adapterCursorV: input.adapterCursorV,
    state: input.state,
  });
}

export interface KgCursorPin {
  provider: string;
  fingerprint: string;
  adapterCursorV: number;
}

/**
 * Decode cursor and pin provider/version/fingerprint. Any mismatch →
 * cursor_invalid, never trust. Hostile payloads rejected by contract codec.
 */
export function decodePinnedKgCursor(cursor: string, pin: KgCursorPin): DecodedKgCursor {
  const decoded = decodeKgCursor(cursor);
  if (decoded.provider !== pin.provider || decoded.adapterCursorV !== pin.adapterCursorV || decoded.fingerprint !== pin.fingerprint) {
    throw new KgContractError('cursor_invalid', 'Cursor does not match this provider request.');
  }
  return decoded;
}

/**
 * Explicit fanout takes no cursor: presenting one with an explicit provider
 * allowlist → pagination_not_supported. Absent cursor always passes.
 */
export function rejectCursorForExplicitFanout(cursor: string | undefined, explicitProviders?: readonly string[]): void {
  if (cursor === undefined) return;
  if (explicitProviders !== undefined) {
    throw new KgContractError('pagination_not_supported', 'Cursors are not supported for explicit multi-provider requests.');
  }
}
