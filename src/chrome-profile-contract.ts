// Authorized user-Chrome Phase 1 wire contract (Worker 1).
//
// Pure vocabulary + runtime parser only. No provider imports, no Pi-runtime
// imports, no network, no disk. The bridge (Worker 2), companion (Worker 3),
// adapter (Worker 4), and integration (Worker 5) consume these types.
//
// Invariants:
// - One backend-neutral public `browser` tool; no context/backend model
//   input. `/chrome authorize` selects the privileged backend at runtime;
//   revoke/expiry returns to isolated.
// - Bridge binds literal 127.0.0.1:17319 (never pi-chrome 17318).
// - Closed operation union only: no raw CDP, no free-form command, no eval.
// - Unknown protocol/version fails closed.

export const CHROME_BRIDGE_HOST = '127.0.0.1';
export const CHROME_BRIDGE_PORT = 17319;
export const CHROME_BRIDGE_PROTOCOL = 1;
export const CHROME_LEASE_MAX_MS = 60_000;
export const CHROME_LEASE_RENEW_MS = 30_000;
export const CHROME_BRIDGE_MAX_REQUEST_BYTES = 256 * 1024;
export const CHROME_BRIDGE_MAX_RESULT_BYTES = 1024 * 1024;
export const CHROME_BRIDGE_INSTANCE_STALE_MS = 90_000;
/** Clamp for wait operations so a wait never outlives the bridge command timeout. */
export const CHROME_PROFILE_WAIT_MAX_MS = 60_000;

export interface ChromeBridgeInstanceInfo {
  instanceId: string;
  family: string;
  version: string;
  caps: string;
  lastSeen: number;
}

// Companion DNR dynamic-rule id planning (shared with chrome-extension/service_worker.js
// ruleBaseForTab). Rule ids derive per owned tab as 1000 + (tabId % 2000) * 2 so
// reinstall overwrites instead of leaking and cleanup removes the same ids.
// Pi never assigns these ids directly today: the navigate operation carries
// frozenHostname and the companion derives deny/allow rule ids from the
// per-tab base. Keep both sides on ruleBaseForTab so future Pi-side rule
// planning cannot collide with companion-installed rules.
export const CHROME_DNR_RULE_BASE = 1000;
export const CHROME_DNR_DENY_RULE_ID = CHROME_DNR_RULE_BASE;
export const CHROME_DNR_ALLOW_RULE_ID = CHROME_DNR_RULE_BASE + 1;

// FINAL contract: one backend-neutral `browser` tool with no context/backend
// model input. `/chrome authorize` selects the privileged backend at runtime.
// No BrowserContext vocabulary ships here.

export type ChromeAuthorizationState =
  | { state: 'locked'; reason?: 'initial' | 'revoked' | 'expired' | 'shutdown' }
  | { state: 'authorized'; expiresAt: number | null };

export type ChromeProfileErrorCode =
  | 'chrome_locked'
  | 'chrome_revoked'
  | 'chrome_extension_unavailable'
  | 'chrome_version_mismatch'
  | 'chrome_domain_blocked'
  | 'chrome_no_owned_tab'
  | 'chrome_timeout'
  | 'chrome_invalid_request'
  | 'chrome_invalid_result'
  | 'chrome_debugger_conflict'
  | 'chrome_policy_failure';

const CHROME_PROFILE_ERROR_CODES: readonly string[] = [
  'chrome_locked',
  'chrome_revoked',
  'chrome_extension_unavailable',
  'chrome_version_mismatch',
  'chrome_domain_blocked',
  'chrome_no_owned_tab',
  'chrome_timeout',
  'chrome_invalid_request',
  'chrome_invalid_result',
  'chrome_debugger_conflict',
  'chrome_policy_failure',
];

export function isChromeProfileErrorCode(value: unknown): value is ChromeProfileErrorCode {
  return typeof value === 'string' && CHROME_PROFILE_ERROR_CODES.includes(value);
}

export interface ChromeProfileError {
  code: ChromeProfileErrorCode;
  message: string;
  retryable: boolean;
}

export function chromeProfileError(code: ChromeProfileErrorCode, message: string, retryable = false): ChromeProfileError {
  return { code, message, retryable };
}

// Closed operation union. No evaluate/html/cookies/storage/network/console.
export type ChromeProfileOperation =
  | { kind: 'navigate'; url: string; frozenHostname: string }
  | { kind: 'snapshot'; compact: boolean }
  | { kind: 'text' }
  | { kind: 'screenshot' }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'fill'; selector: string; text: string }
  | { kind: 'select'; selector: string; values: string[] }
  | { kind: 'scroll'; x: number; y: number }
  | { kind: 'wait'; selector?: string; text?: string; waitMs: number }
  | { kind: 'get_url' }
  | { kind: 'get_title' }
  | { kind: 'semantic_action'; request: ChromeSemanticActionRequest }
  | { kind: 'tabs' }
  | { kind: 'close' };

export interface ChromeSemanticActionRequest {
  locator: string;
  query: string;
  verb: string;
  name?: string | undefined;
  index?: number | undefined;
  value?: string | undefined;
  exact?: boolean | undefined;
}

const CHROME_PROFILE_OPERATION_KINDS: readonly string[] = [
  'navigate', 'snapshot', 'text', 'screenshot', 'click', 'type', 'fill',
  'select', 'scroll', 'wait', 'get_url', 'get_title', 'semantic_action',
  'tabs', 'close',
];

export type ChromeBridgeCommand =
  | { protocol: 1; id: string; sessionKey: string; grantId: string; targetInstanceId: string; bridgeToken: string; kind: 'authorize'; leaseExpiresAt: number }
  | { protocol: 1; id: string; sessionKey: string; grantId: string; targetInstanceId: string; bridgeToken: string; kind: 'renew'; leaseExpiresAt: number }
  | { protocol: 1; id: string; sessionKey: string; grantId: string; targetInstanceId: string; bridgeToken: string; kind: 'execute'; operation: ChromeProfileOperation }
  | { protocol: 1; id: string; sessionKey: string; grantId: string; targetInstanceId: string; bridgeToken: string; kind: 'revoke' };

export type ChromeBridgeResult =
  | { protocol: 1; id: string; ok: true; data?: unknown }
  | { protocol: 1; id: string; ok: false; error: ChromeProfileError };

export class ChromeProfileContractError extends Error {
  readonly code: ChromeProfileErrorCode = 'chrome_invalid_request';
  constructor(message: string) {
    super(message);
    this.name = 'ChromeProfileContractError';
  }
}

function requireNonEmptyString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ChromeProfileContractError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ChromeProfileContractError(`${field} must be a finite number`);
  }
  return value;
}

function parseSemanticActionRequest(value: unknown): ChromeSemanticActionRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChromeProfileContractError('semantic_action.request must be an object');
  }
  const record = value as Record<string, unknown>;
  const locator = requireNonEmptyString(record, 'locator');
  const query = requireNonEmptyString(record, 'query');
  const verb = requireNonEmptyString(record, 'verb');
  const out: ChromeSemanticActionRequest = { locator, query, verb };
  if (record.name !== undefined) {
    if (typeof record.name !== 'string') throw new ChromeProfileContractError('semantic_action.request.name must be a string');
    out.name = record.name;
  }
  if (record.index !== undefined) {
    if (typeof record.index !== 'number' || !Number.isFinite(record.index)) {
      throw new ChromeProfileContractError('semantic_action.request.index must be a finite number');
    }
    out.index = record.index;
  }
  if (record.value !== undefined) {
    if (typeof record.value !== 'string') throw new ChromeProfileContractError('semantic_action.request.value must be a string');
    out.value = record.value;
  }
  if (record.exact === true) out.exact = true;
  else if (record.exact !== undefined && record.exact !== false) {
    throw new ChromeProfileContractError('semantic_action.request.exact must be a boolean when present');
  }
  return out;
}

/** Parse and validate a closed operation. Rejects raw CDP/eval/html/cookies. */
export function parseChromeProfileOperation(value: unknown): ChromeProfileOperation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChromeProfileContractError('operation must be an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !CHROME_PROFILE_OPERATION_KINDS.includes(record.kind)) {
    throw new ChromeProfileContractError(`unknown operation kind: ${String(record.kind).slice(0, 64)}`);
  }
  switch (record.kind) {
    case 'navigate': {
      const url = requireNonEmptyString(record, 'url');
      const frozenHostname = requireNonEmptyString(record, 'frozenHostname').toLowerCase();
      return { kind: 'navigate', url, frozenHostname };
    }
    case 'snapshot': {
      if (typeof record.compact !== 'boolean') throw new ChromeProfileContractError('snapshot.compact must be a boolean');
      return { kind: 'snapshot', compact: record.compact };
    }
    case 'text':
      return { kind: 'text' };
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'click': {
      const selector = requireNonEmptyString(record, 'selector');
      return { kind: 'click', selector };
    }
    case 'type':
    case 'fill': {
      const selector = requireNonEmptyString(record, 'selector');
      const text = requireNonEmptyString(record, 'text');
      return record.kind === 'type' ? { kind: 'type', selector, text } : { kind: 'fill', selector, text };
    }
    case 'select': {
      const selector = requireNonEmptyString(record, 'selector');
      if (!Array.isArray(record.values) || record.values.length === 0 ||
          !record.values.every((v): v is string => typeof v === 'string')) {
        throw new ChromeProfileContractError('select.values must be a non-empty array of strings');
      }
      return { kind: 'select', selector, values: [...record.values] };
    }
    case 'scroll': {
      const x = requireFiniteNumber(record, 'x');
      const y = requireFiniteNumber(record, 'y');
      return { kind: 'scroll', x, y };
    }
    case 'wait': {
      const rawWaitMs = requireFiniteNumber(record, 'waitMs');
      if (rawWaitMs < 0) {
        throw new ChromeProfileContractError('wait.waitMs must be >= 0');
      }
      const waitMs = Math.min(rawWaitMs, CHROME_PROFILE_WAIT_MAX_MS);
      const out: ChromeProfileOperation = { kind: 'wait', waitMs };
      if (record.selector !== undefined) {
        if (typeof record.selector !== 'string' || record.selector.length === 0) {
          throw new ChromeProfileContractError('wait.selector must be a non-empty string when present');
        }
        (out as { selector?: string }).selector = record.selector;
      }
      if (record.text !== undefined) {
        if (typeof record.text !== 'string' || record.text.length === 0) {
          throw new ChromeProfileContractError('wait.text must be a non-empty string when present');
        }
        (out as { text?: string }).text = record.text;
      }
      return out;
    }
    case 'get_url':
      return { kind: 'get_url' };
    case 'get_title':
      return { kind: 'get_title' };
    case 'semantic_action':
      return { kind: 'semantic_action', request: parseSemanticActionRequest(record.request) };
    case 'tabs':
      return { kind: 'tabs' };
    case 'close':
      return { kind: 'close' };
    default:
      throw new ChromeProfileContractError(`unknown operation kind: ${String(record.kind).slice(0, 64)}`);
  }
}

/** Parse a bridge command. Unknown protocol/version fails closed. */
export function parseChromeBridgeCommand(value: unknown): ChromeBridgeCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChromeProfileContractError('command must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== CHROME_BRIDGE_PROTOCOL) {
    throw new ChromeProfileContractError(`unsupported protocol: ${String(record.protocol).slice(0, 32)}`);
  }
  const id = requireNonEmptyString(record, 'id');
  const sessionKey = requireNonEmptyString(record, 'sessionKey');
  const grantId = requireNonEmptyString(record, 'grantId');
  // Per-instance targeting + session token ride every command: the bridge
  // routes by targetInstanceId and rejects token mismatch fail-closed.
  const targetInstanceId = requireNonEmptyString(record, 'targetInstanceId');
  const bridgeToken = requireNonEmptyString(record, 'bridgeToken');
  const kind = record.kind;
  if (kind === 'authorize' || kind === 'renew') {
    const leaseExpiresAt = requireFiniteNumber(record, 'leaseExpiresAt');
    return { protocol: 1, id, sessionKey, grantId, targetInstanceId, bridgeToken, kind, leaseExpiresAt };
  }
  if (kind === 'execute') {
    return { protocol: 1, id, sessionKey, grantId, targetInstanceId, bridgeToken, kind, operation: parseChromeProfileOperation(record.operation) };
  }
  if (kind === 'revoke') {
    return { protocol: 1, id, sessionKey, grantId, targetInstanceId, bridgeToken, kind };
  }
  throw new ChromeProfileContractError(`unknown command kind: ${String(kind).slice(0, 32)}`);
}

/** Parse a bridge result. Unknown protocol fails closed; error codes closed. */
export function parseChromeBridgeResult(value: unknown): ChromeBridgeResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ChromeProfileContractError('result must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.protocol !== CHROME_BRIDGE_PROTOCOL) {
    throw new ChromeProfileContractError(`unsupported protocol: ${String(record.protocol).slice(0, 32)}`);
  }
  const id = requireNonEmptyString(record, 'id');
  if (record.ok === true) {
    const result: ChromeBridgeResult = { protocol: 1, id, ok: true };
    if (record.data !== undefined) (result as { data?: unknown }).data = record.data;
    return result;
  }
  if (record.ok === false) {
    if (typeof record.error !== 'object' || record.error === null || Array.isArray(record.error)) {
      throw new ChromeProfileContractError('error result must carry an error object');
    }
    const errorRecord = record.error as Record<string, unknown>;
    if (!isChromeProfileErrorCode(errorRecord.code)) {
      throw new ChromeProfileContractError(`unknown error code: ${String(errorRecord.code).slice(0, 64)}`);
    }
    if (typeof errorRecord.message !== 'string' || errorRecord.message.length === 0) {
      throw new ChromeProfileContractError('error.message must be a non-empty string');
    }
    if (typeof errorRecord.retryable !== 'boolean') {
      throw new ChromeProfileContractError('error.retryable must be a boolean');
    }
    return {
      protocol: 1,
      id,
      ok: false,
      error: { code: errorRecord.code, message: errorRecord.message, retryable: errorRecord.retryable },
    };
  }
  throw new ChromeProfileContractError('result.ok must be a boolean');
}

export interface ChromeDoctorResult {
  bridgeReachable: boolean;
  protocol: 1;
  authorized: boolean;
  latencyMs?: number | undefined;
}

export interface ChromeBackendCallResult {
  ok: boolean;
  text: string;
  details?: Record<string, unknown> | undefined;
  image?: { mimeType: 'image/png'; dataBase64: string } | undefined;
}
