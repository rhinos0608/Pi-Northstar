// Private-content transfer gate (Plan D/E shared contract, parent-authored).
//
// Public-content transfer is authorized by configuring a cloud/OpenAI-compatible
// endpoint or Gemini credentials (with loud README/setup warnings). Private or
// authenticated GitHub content additionally requires this explicit operator flag.
// Policy/auth failure must never broaden provider eligibility.

/** Exact-value opt-in env var permitting private-GitHub → vision transfer. */
export const PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR = 'PI_VISION_PRIVATE_GITHUB_TRANSFER';

/**
 * Returns true only when the operator explicitly opted in with the exact value
 * "1". Absent/empty/any other value denies cloud transfer of private content;
 * callers must degrade to native/local evidence with warnings.
 */
export function mayTransferPrivateGithubToVision(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR] === '1';
}
