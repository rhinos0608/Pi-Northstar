// Gemini Web last-resort transport (Plan D Task D3).
//
// Disabled by default: requires the exact opt-in value "1" in
// PI_VISION_GEMINI_WEB_ENABLED. Last resort only — sibling eligibility
// ordering (W-D1) must exhaust native, OpenAI-compatible, and direct Gemini
// tiers first; this module never widens its own eligibility. The Chrome lease
// comes from the actual lease owners (browser-tools / chrome-profile-bridge /
// chrome-profile-adapter) via injection — never chrome-profile-auth (TTL parse
// only), never raw cookie input/config.

import {
  GEMINI_WEB_ENABLED_ENV_VAR,
  isGeminiWebEnabled,
} from './eligibility.js';

export { GEMINI_WEB_ENABLED_ENV_VAR, isGeminiWebEnabled };
import type { GeminiWebChromeOwners } from './gemini-web-lease.js';
export type { GeminiWebChromeOwners };

/** Exact Gemini Web origins a leased tab may target. No other origin allowed. */
export const GEMINI_WEB_ORIGINS: readonly string[] = ['https://gemini.google.com'];

/**
 * Minimal leased-tab seam. Production wiring acquires this from the Chrome
 * lease owners (browser-tools.ts / chrome-profile-bridge.ts /
 * chrome-profile-adapter.ts). Tests inject a mock with a call counter.
 */
export interface GeminiWebLease {
  /** Exact origin of the leased tab (must be in GEMINI_WEB_ORIGINS). */
  readonly origin: string;
  /** Route-specific observability tags, never credentials. */
  readonly warnings?: readonly string[];
  navigate(url: string): Promise<void>;
  /**
   * Optional code-owned local-file attachment primitive. Video Web fallback
   * requires this capability and fails closed when a lease does not expose it.
   */
  attachFile?(filePath: string): Promise<void>;
  /** Run script in the leased tab and return the structured result. */
  evaluate<T>(script: string): Promise<T>;
  /** Optional cleanup for isolated fallback sessions. User-Chrome leases omit it. */
  close?(): Promise<void>;
}

export interface GeminiWebSeams {
  acquireLease(): Promise<GeminiWebLease>;
}

export type GeminiWebResult =
  | { ok: true; text: string; warnings: string[] }
  | {
      ok: false;
      reason: 'disabled' | 'lease-unavailable' | 'lease-origin-rejected' | 'empty-response';
      warnings: string[];
    };

/** Legacy alias for {@link isGeminiWebEnabled} (kept for existing importers). */
export const geminiWebEnabled = isGeminiWebEnabled;

/** Machine-readable code for an unavailable Chrome user lease (fail-closed, never success). */
export const GEMINI_WEB_LEASE_UNAVAILABLE_CODE = 'gemini-web-lease-unavailable';

/**
 * Local lease failure: no user-Chrome lease is available for the Web route.
 * Thrown unwrapped so callers distinguish it from provider errors without
 * string-matching. Never carries credentials or page content.
 */
export class GeminiWebLeaseUnavailableError extends Error {
  readonly code = GEMINI_WEB_LEASE_UNAVAILABLE_CODE;
  constructor(message: string) {
    super(message);
    this.name = 'GeminiWebLeaseUnavailableError';
  }
}

/** True for local lease unavailability; false for provider failures. */
export function isGeminiWebLeaseUnavailableError(error: unknown): boolean {
  if (error instanceof GeminiWebLeaseUnavailableError) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === GEMINI_WEB_LEASE_UNAVAILABLE_CODE
  );
}

/**
 * Production Chrome-lease acquisition seam.
 *
 * Owner-API survey (read-only, no owner touched):
 * - `src/chrome/chrome-profile-adapter.ts` ChromeProfileAdapter.execute()
 *   routes allowed operator browser actions under a Pi-side lock
 *   (authorize/revoke/renew/execute + boundTarget); `evaluate`/`html`/
 *   `cookies` stay denied by the closed operation union.
 * - `src/chrome/chrome-profile-bridge.ts` ChromeBridgeServer.requireOwner()
 *   proves this process owns the pinned companion bridge.
 * - `src/chrome/chrome-profile-auth.ts` owns the TTL/lease parse only.
 * - `src/chrome/chrome-companion-selection.ts` owns operator-facing
 *   inventory/selection (never model input).
 *
 * With no tab-lease primitive on the owners, the real lease lives in
 * `./gemini-web-lease.js`: it adapts adapter.execute() with allowed ops
 * only (exact-origin navigate, code-owned semantic_action fill, text read)
 * behind the PI_VISION_GEMINI_WEB_ENABLED + PI_VISION_VIDEO_GEMINI +
 * live-user-lease triple gate. Without injected owners there is nothing
 * honest to wire, so this seam throws GeminiWebLeaseUnavailableError
 * (never resolves a lease, never fakes success). Callers
 * (runFetchVideoAnalysis) catch the throw and degrade to isolated-backend
 * evidence with a gemini-web-unavailable warning. Disabled flag throws
 * first so a disabled route stays distinguishable from a missing lease.
 * No credentials are read, stored, or forwarded here.
 */
export async function acquireGeminiWebLeaseFromChromeOwners(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  owners?: GeminiWebChromeOwners | undefined,
): Promise<GeminiWebLease> {
  if (owners !== undefined) {
    const { acquireChromeGeminiWebLease } = await import('./gemini-web-lease.js');
    return acquireChromeGeminiWebLease(env, owners);
  }
  if (!isGeminiWebEnabled(env)) {
    throw new GeminiWebLeaseUnavailableError(
      `gemini-web disabled: set ${GEMINI_WEB_ENABLED_ENV_VAR}=1 to enable this route`,
    );
  }
  throw new GeminiWebLeaseUnavailableError(
    'gemini-web-lease-unavailable: no Chrome owners wired; degraded to isolated backend',
  );
}

/**
 * Last-resort ask through a leased Gemini Web tab. Zero lease/browser calls
 * when disabled. Rejects non-exact origins before navigation. No cookies,
 * tokens, or raw auth material are accepted here in any form.
 */
export async function askGeminiWeb(
  prompt: string,
  seams: GeminiWebSeams,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<GeminiWebResult> {
  if (!geminiWebEnabled(env)) return { ok: false, reason: 'disabled', warnings: [] };
  if (prompt.trim().length === 0) {
    return { ok: false, reason: 'empty-response', warnings: ['empty-prompt'] };
  }
  const lease = await seams.acquireLease();
  const leaseWarnings = [...(lease.warnings ?? [])];
  try {
    if (!GEMINI_WEB_ORIGINS.includes(lease.origin)) {
      return {
        ok: false,
        reason: 'lease-origin-rejected',
        warnings: [...leaseWarnings, 'non-gemini-origin'],
      };
    }
    await lease.navigate(`${lease.origin}/app`);
    const text = await lease.evaluate<string>(
      `prompt:${JSON.stringify(prompt.slice(0, 8000))}`,
    );
    if (typeof text !== 'string' || text.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty-response',
        warnings: [...leaseWarnings, 'empty-model-response'],
      };
    }
    return {
      ok: true,
      text,
      warnings: [...leaseWarnings, 'last-resort-web-route'],
    };
  } finally {
    if (lease.close !== undefined) {
      try {
        await lease.close();
      } catch {
        // Cleanup must not turn a provider result into a secret-bearing error.
      }
    }
  }
}

/**
 * Video-specific Web ask. Unlike the text-only helper above, this path refuses
 * to run unless the acquired lease exposes an explicit code-owned attachment
 * primitive and the local file is attached before the prompt is submitted.
 * That keeps a missing upload capability from masquerading as video analysis.
 */
export async function askGeminiWebVideo(
  filePath: string,
  prompt: string,
  seams: GeminiWebSeams,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Promise<GeminiWebResult> {
  if (!geminiWebEnabled(env)) return { ok: false, reason: 'disabled', warnings: [] };
  if (prompt.trim().length === 0) {
    return { ok: false, reason: 'empty-response', warnings: ['empty-prompt'] };
  }
  const lease = await seams.acquireLease();
  const leaseWarnings = [...(lease.warnings ?? [])];
  try {
    if (!GEMINI_WEB_ORIGINS.includes(lease.origin)) {
      return {
        ok: false,
        reason: 'lease-origin-rejected',
        warnings: [...leaseWarnings, 'non-gemini-origin'],
      };
    }
    if (lease.attachFile === undefined) {
      throw new GeminiWebLeaseUnavailableError(
        'gemini-web-video-unavailable: acquired lease has no file-attachment primitive',
      );
    }
    await lease.navigate(`${lease.origin}/app`);
    await lease.attachFile(filePath);
    const text = await lease.evaluate<string>(
      `prompt:${JSON.stringify(prompt.slice(0, 8000))}`,
    );
    if (typeof text !== 'string' || text.trim().length === 0) {
      return {
        ok: false,
        reason: 'empty-response',
        warnings: [...leaseWarnings, 'empty-model-response'],
      };
    }
    return {
      ok: true,
      text,
      warnings: [...leaseWarnings, 'last-resort-web-route', 'video-file-attached'],
    };
  } finally {
    if (lease.close !== undefined) {
      try {
        await lease.close();
      } catch {
        // Cleanup must not turn a provider result into a secret-bearing error.
      }
    }
  }
}
