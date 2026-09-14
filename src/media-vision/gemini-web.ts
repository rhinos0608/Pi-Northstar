// Gemini Web last-resort transport (Plan D Task D3).
//
// Disabled by default: requires the exact opt-in value "1" in
// PI_VISION_GEMINI_WEB_ENABLED. Last resort only — sibling eligibility
// ordering (W-D1) must exhaust native, OpenAI-compatible, and direct Gemini
// tiers first; this module never widens its own eligibility. The Chrome lease
// comes from the actual lease owners (browser-tools / chrome-profile-bridge /
// chrome-profile-adapter) via injection — never chrome-profile-auth (TTL parse
// only), never raw cookie input/config.

/** Exact-value env enabling the Gemini Web last-resort route. Default off. */
export const GEMINI_WEB_ENABLED_ENV_VAR = 'PI_VISION_GEMINI_WEB_ENABLED';

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
  navigate(url: string): Promise<void>;
  /** Run script in the leased tab and return the structured result. */
  evaluate<T>(script: string): Promise<T>;
}

export interface GeminiWebSeams {
  acquireLease(): Promise<GeminiWebLease>;
}

export type GeminiWebResult =
  | { ok: true; text: string; warnings: string[] }
  | { ok: false; reason: 'disabled' | 'lease-origin-rejected' | 'empty-response'; warnings: string[] };

/** True only on the explicit exact-value opt-in. Absent/any other value: off. */
export function geminiWebEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env[GEMINI_WEB_ENABLED_ENV_VAR] === '1';
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
  if (!GEMINI_WEB_ORIGINS.includes(lease.origin)) {
    return { ok: false, reason: 'lease-origin-rejected', warnings: ['non-gemini-origin'] };
  }
  await lease.navigate(`${lease.origin}/app`);
  const text = await lease.evaluate<string>(
    `prompt:${JSON.stringify(prompt.slice(0, 8000))}`,
  );
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, reason: 'empty-response', warnings: ['empty-model-response'] };
  }
  return { ok: true, text, warnings: ['last-resort-web-route'] };
}
