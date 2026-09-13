// Stage 8 social write policy: deny-by-default gate ONLY.
//
// No write adapter, no dispatch, no POST, no worker/CLI/HTTP execution.
// Every path with the kill switch unset denies without touching any
// network or executable import (this file imports only the contracts).
//
// Order in validateSocialWrite:
//   (a) kill switch PI_SEARCH_SOCIAL_WRITE !== '1' → deny
//   (b) allowlist check via capability matrix (default: everything denied)
//   (c) per-action selector/payload validation via the contract
//   (d) dry-run preview on validation success — no dispatch path exists)

import { SocialError } from './social-contract.js';
import {
  DEFAULT_SOCIAL_WRITE_MATRIX,
  validateSocialWriteRequest,
  type SocialWriteCapabilityMatrix,
  type SocialWriteRequest,
  type SocialWriteRequestInput,
} from './social-write-contract.js';

export const SOCIAL_WRITE_KILL_SWITCH = 'PI_SEARCH_SOCIAL_WRITE';

export type SocialWriteDenyReason =
  | 'social_write_disabled'
  | 'social_write_denied'
  | 'social_write_invalid';

export interface SocialWritePolicyOptions {
  matrix?: SocialWriteCapabilityMatrix;
  audit?: SocialWriteAuditWriter;
}

export interface SocialWritePreview {
  platform: SocialWriteRequest['platform'];
  action: SocialWriteRequest['action'];
  target: string;
  textLength: number;
}

export interface SocialWriteAuditEntry {
  at: string;
  platform: string;
  action: string;
  status: 'denied' | 'dry_run';
  reason: string;
}

export interface SocialWriteAuditWriter {
  record(entry: SocialWriteAuditEntry): void;
}

const AUDIT_ECHO_LIMIT = 32;
const MAX_AUDIT_ENTRIES = 1000;

function cappedEcho(value: string): string {
  return value.slice(0, AUDIT_ECHO_LIMIT);
}

const auditLog: SocialWriteAuditEntry[] = [];
let injectedAuditWriter: SocialWriteAuditWriter | undefined;

export function setSocialWriteAuditWriter(writer: SocialWriteAuditWriter | undefined): void {
  injectedAuditWriter = writer;
}

export function getSocialWriteAuditLog(): readonly SocialWriteAuditEntry[] {
  return [...auditLog];
}

export function clearSocialWriteAuditLog(): void {
  auditLog.length = 0;
}

function audit(entry: SocialWriteAuditEntry, opts?: SocialWritePolicyOptions): void {
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT_ENTRIES) {
    auditLog.splice(0, auditLog.length - MAX_AUDIT_ENTRIES);
  }
  opts?.audit?.record(entry);
  injectedAuditWriter?.record(entry);
}

/** Strict kill switch: only the exact string '1' enables. Default denies. */
export function socialWriteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[SOCIAL_WRITE_KILL_SWITCH] === '1';
}

/** Deny-by-default allowlist check against the capability matrix. */
export function isDeniedSocialWrite(
  platform: SocialWriteRequest['platform'],
  action: SocialWriteRequest['action'],
  matrix: SocialWriteCapabilityMatrix = DEFAULT_SOCIAL_WRITE_MATRIX,
): boolean {
  return !matrix[platform]?.includes(action);
}

export interface ValidatedSocialWrite {
  request: SocialWriteRequest;
  preview: SocialWritePreview;
}

function previewFor(request: SocialWriteRequest): SocialWritePreview {
  const target = request.postId ?? request.user ?? request.commentId ?? request.community ?? request.topic ?? '';
  return {
    platform: request.platform,
    action: request.action,
    target,
    textLength: request.text?.length ?? 0,
  };
}

function deny(
  code: SocialError['code'],
  reason: SocialWriteDenyReason,
  detail: string,
  raw: SocialWriteRequestInput,
  opts?: SocialWritePolicyOptions,
): never {
  audit(
    {
      at: new Date().toISOString(),
      platform: cappedEcho(String(raw.platform)),
      action: cappedEcho(String(raw.action)),
      status: 'denied',
      reason,
    },
    opts,
  );
  throw new SocialError(code, `${reason}: ${detail}`, {
    platform: raw.platform as SocialWriteRequest['platform'],
  });
}

/**
 * Boundary gate. Defense-in-depth: re-checks the kill switch internally —
 * callers cannot bypass it. Throws SocialError on any deny; returns a
 * dry-run preview otherwise. Never dispatches.
 */
export function validateSocialWrite(
  raw: SocialWriteRequestInput,
  env: Record<string, string | undefined> = process.env,
  opts: SocialWritePolicyOptions = {},
): ValidatedSocialWrite {
  if (!socialWriteEnabled(env)) {
    deny('permission_denied', 'social_write_disabled', 'set PI_SEARCH_SOCIAL_WRITE=1 to enable', raw, opts);
  }
  const matrix = opts.matrix ?? DEFAULT_SOCIAL_WRITE_MATRIX;
  const platform = raw.platform as SocialWriteRequest['platform'];
  const action = raw.action as SocialWriteRequest['action'];
  if (isDeniedSocialWrite(platform, action, matrix)) {
    deny(
      'permission_denied',
      'social_write_denied',
      `${cappedEcho(String(raw.platform))}/${cappedEcho(String(raw.action))} not allowlisted`,
      raw,
      opts,
    );
  }
  let validated: ValidatedSocialWrite['request'];
  try {
    validated = validateSocialWriteRequest(raw).request;
  } catch (error) {
    const message = error instanceof SocialError ? error.message : String(error);
    audit(
      {
        at: new Date().toISOString(),
        platform: cappedEcho(String(raw.platform)),
        action: cappedEcho(String(raw.action)),
        status: 'denied',
        reason: 'social_write_invalid',
      },
      opts,
    );
    throw error instanceof SocialError
      ? new SocialError(error.code, `social_write_invalid: ${message}`)
      : new SocialError('invalid_request', `social_write_invalid: ${message}`);
  }
  // Stage 8 has no dispatch path: validation success always returns a
  // dry-run preview. Never dispatches.
  const preview = previewFor(validated);
  audit(
    { at: new Date().toISOString(), platform: validated.platform, action: validated.action, status: 'dry_run', reason: 'dry_run_preview' },
    opts,
  );
  return { request: validated, preview };
}

export type SocialWriteGateResult =
  | { status: 'denied'; reason: SocialWriteDenyReason; preview?: undefined }
  | { status: 'dry_run'; reason: 'dry_run_preview'; preview: SocialWritePreview };

/**
 * Single gate the Stage 8b integrator calls pre-dispatch.
 * Returns denied/dry_run only — never a dispatch.
 */
export function trySocialWrite(
  raw: SocialWriteRequestInput,
  env: Record<string, string | undefined> = process.env,
  opts: SocialWritePolicyOptions = {},
): SocialWriteGateResult {
  try {
    const { preview } = validateSocialWrite(raw, env, opts);
    return { status: 'dry_run', reason: 'dry_run_preview', preview };
  } catch (error) {
    if (error instanceof SocialError) {
      const reason = error.message.split(':')[0] as SocialWriteDenyReason;
      if (reason === 'social_write_disabled' || reason === 'social_write_denied' || reason === 'social_write_invalid') {
        return { status: 'denied', reason };
      }
    }
    return { status: 'denied', reason: 'social_write_invalid' };
  }
}
