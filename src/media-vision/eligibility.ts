// Plan D task D1: deterministic vision-provider eligibility (pure function).
//
// Route order is fixed: native -> configured OpenAI-compatible vision ->
// Gemini (Developer API or Vertex) -> Gemini Web (disabled default, last
// resort). Eligibility derives from operator configuration only. Runtime
// policy/auth failure never broadens eligibility: failure drops the failed
// tier (fail-closed subset), it never unlocks a tier that was unconfigured.

import { isOpenAICompatibleVisionConfigured } from './openai-compatible.js';

/** Vision routing tiers in preference order. `native` is always eligible. */
export type VisionTier = 'native' | 'openai-compatible' | 'gemini' | 'gemini-web';

/** Fixed route order. `native` first; `gemini-web` last and only when enabled. */
export const VISION_TIER_ORDER: readonly VisionTier[] = [
  'native',
  'openai-compatible',
  'gemini',
  'gemini-web',
];

/** Env keys proving a Gemini Developer-API credential is configured. */
export const GEMINI_API_KEY_ENV_VARS: readonly string[] = ['GEMINI_API_KEY', 'GOOGLE_GENAI_API_KEY'];

/** Env keys proving a Vertex project is configured (ADC supplies auth). */
export const VERTEX_PROJECT_ENV_VARS: readonly string[] = [
  'GOOGLE_VERTEX_PROJECT',
  'GOOGLE_CLOUD_PROJECT',
];

/** Exact-value opt-in enabling the Gemini Web last-resort tier (off default). */
export const GEMINI_WEB_ENABLED_ENV_VAR = 'PI_VISION_GEMINI_WEB_ENABLED';

export type VisionEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** True when a Gemini Developer key or a Vertex project is configured. */
export function isGeminiConfigured(env: VisionEnv = process.env): boolean {
  for (const key of [...GEMINI_API_KEY_ENV_VARS, ...VERTEX_PROJECT_ENV_VARS]) {
    const value = env[key];
    if (typeof value === 'string' && value.trim().length > 0) return true;
  }
  return false;
}

/** True only on the exact opt-in value "1"; absent/any other value is off. */
export function isGeminiWebEnabled(env: VisionEnv = process.env): boolean {
  return env[GEMINI_WEB_ENABLED_ENV_VAR] === '1';
}

/** Explicit configuration flags. No failure/auth state lives here by design. */
export interface VisionEligibilityInput {
  openAICompatibleConfigured: boolean;
  geminiConfigured: boolean;
  geminiWebEnabled: boolean;
}

/**
 * Deterministic eligibility from configuration flags only. `native` is always
 * present. Later tiers appear only when explicitly configured; `gemini-web`
 * additionally requires an explicit opt-in (disabled default, last resort).
 * Takes no failure input, so a policy/auth failure cannot broaden the set.
 */
export function resolveVisionEligibility(input: VisionEligibilityInput): VisionTier[] {
  const tiers: VisionTier[] = ['native'];
  if (input.openAICompatibleConfigured) tiers.push('openai-compatible');
  if (input.geminiConfigured) tiers.push('gemini');
  if (input.geminiWebEnabled) tiers.push('gemini-web');
  return tiers;
}

/** Eligibility straight from operator environment (convenience wrapper). */
export function resolveVisionEligibilityFromEnv(env: VisionEnv = process.env): VisionTier[] {
  return resolveVisionEligibility({
    openAICompatibleConfigured: isOpenAICompatibleVisionConfigured(env),
    geminiConfigured: isGeminiConfigured(env),
    geminiWebEnabled: isGeminiWebEnabled(env),
  });
}

/**
 * Fail-closed subset after a tier fails at runtime: drops the failed tier
 * without ever adding a tier. Callers degrade to the remaining earlier tiers
 * or to native evidence with warnings.
 */
export function eligibleTiersAfterFailure(
  eligible: readonly VisionTier[],
  failedTier: VisionTier,
): VisionTier[] {
  return eligible.filter((tier) => tier !== failedTier);
}
