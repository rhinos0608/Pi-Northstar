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

/** Loud warning: configuring any vision endpoint/credential sends content off-machine. */
export const VISION_PUBLIC_TRANSFER_WARNING =
  'WARNING: configuring a vision endpoint or credential sends admitted image/PDF/video ' +
  'bytes plus OCR/description text to that operator-configured endpoint. ' +
  'Nothing leaves the machine until the operator explicitly opts in by setting the endpoint/credential.';

/** Loud warning: private GitHub content needs the independent exact-value flag. */
export const VISION_PRIVATE_TRANSFER_WARNING =
  'WARNING: private or authenticated GitHub content additionally requires ' +
  `${PRIVATE_GITHUB_VISION_TRANSFER_ENV_VAR}=1 (exact value). ` +
  'Without it, private content must never reach any cloud vision endpoint; ' +
  'degrade to native evidence with warnings.';

/** Content kind under transfer review. */
export type VisionTransferContentKind = 'public' | 'private-github';

/** Input to the transfer decision. `destinationConfigured` is per-destination. */
export interface VisionTransferInput {
  contentKind: VisionTransferContentKind;
  /** True only when THIS destination endpoint/credential is operator-configured. */
  destinationConfigured: boolean;
  env?: NodeJS.ProcessEnv;
}

/** Transfer decision: allowed destination plus the human-readable reason. */
export interface VisionTransferDecision {
  allowed: boolean;
  reason: string;
}

/**
 * Decides whether content may leave the machine for one specific vision
 * destination. Public content requires that destination to be explicitly
 * configured; private GitHub content additionally requires the exact-value
 * operator flag. Per-destination inputs prevent cross-provider leakage: one
 * configured destination never authorizes another.
 */
export function resolveVisionTransfer(input: VisionTransferInput): VisionTransferDecision {
  if (!input.destinationConfigured) {
    return { allowed: false, reason: 'vision_destination_unconfigured' };
  }
  if (input.contentKind === 'private-github') {
    if (!mayTransferPrivateGithubToVision(input.env)) {
      return { allowed: false, reason: 'private_vision_transfer_not_opted_in' };
    }
  }
  return { allowed: true, reason: 'operator_configured_transfer' };
}
