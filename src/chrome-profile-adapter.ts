// Authorized user-Chrome Pi-side adapter (Worker 4).
//
// Consumes Worker 1 (contract/auth/redaction) and Worker 2 (bridge transport)
// vocabulary only. No browser-policy domain-freeze reuse beyond validators +
// DNS preflight, no companion imports, no new runtime dependencies.
//
// Enforcement order per operation:
// 1. Global kill switch (PI_SEARCH_BROWSER_AUTOMATION=0) blocks authorize+execute.
// 2. Action allowlist: evaluate/html/cookies/set_cookies/batch/job always denied,
//    even with PI_SEARCH_BROWSER_ALLOW_SENSITIVE=1.
// 3. Pi-side lock: every op except status-auth-report requires a live grant;
//    pre-auth calls return chrome_locked with zero bridge sends.
// 4. Navigate: validateNavigationUrl -> dnsPreflight -> exact-hostname freeze.
//    Loopback/private/metadata/credentialed/mixed-DNS targets rejected pre-dispatch.
// 5. Bridge envelope carries sessionKey/grantId; typed values travel one way only.
// 6. Outputs redacted; screenshot base64 image-only, never in text/details.

import type { BackendCallResult } from './backend.js';
import {
  BROWSER_ACTIONS,
  MAX_SELECT_VALUES,
  validateScrollCoord,
  validateSelector,
  validateSemanticActionRequest,
  validateText,
  validateWaitMs,
  type BrowserAction,
} from './browser-policy.js';
import { validateNavigationUrl, dnsPreflight } from './browser-policy.js';
import { randomUUID } from 'node:crypto';
import type { DnsLookup } from './network-policy.js';
import {
  CHROME_BRIDGE_PROTOCOL,
  CHROME_LEASE_MAX_MS,
  type ChromeBridgeCommand,
  type ChromeBridgeResult,
  type ChromeDoctorResult,
  type ChromeProfileErrorCode,
  type ChromeProfileOperation,
} from './chrome-profile-contract.js';
import { ChromeProfileAuth, type ChromeRevokeReason } from './chrome-profile-auth.js';
import {
  redactChromeProfileText,
  safeChromeProfileErrorMessage,
} from './chrome-profile-redaction.js';
import { ChromeBridgeError } from './chrome-profile-bridge.js';
import { jsonTextResult, textResult } from './tool-output.js';

export type { ChromeRevokeReason };

/** Process-local bridge session token. Set once the bridge binds; never
 *  published to global process.env. CLI children receive it explicitly via
 *  buildCliEnvironment at spawn time. */
let processLocalBridgeToken: string | undefined;

export function setProcessLocalBridgeToken(token: string | undefined): void {
  processLocalBridgeToken = typeof token === 'string' && token.length > 0 ? token : undefined;
}

export function getProcessLocalBridgeToken(): string | undefined {
  return processLocalBridgeToken;
}

/** Default token resolver: process-local value first, operator env fallback. */
export function defaultBridgeToken(): string | undefined {
  if (processLocalBridgeToken !== undefined) return processLocalBridgeToken;
  const fromEnv = process.env.PI_SEARCH_CHROME_BRIDGE_TOKEN;
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}

/** Actions never allowed in user-chrome, even with ALLOW_SENSITIVE=1. */
export const USER_CHROME_DENIED_ACTIONS: readonly string[] = [
  'evaluate',
  'html',
  'cookies',
  'set_cookies',
  'batch',
  'job',
] as const;

/** Cap for retained typed values used only as redaction secrets (bounded ring). */
const MAX_TYPED_MEMORY_VALUES = 20;

/** Actions that reach the companion bridge after Pi-side checks. */
const USER_CHROME_BRIDGE_ACTIONS: readonly string[] = [
  'navigate',
  'snapshot',
  'text',
  'screenshot',
  'click',
  'type',
  'fill',
  'select',
  'scroll',
  'wait',
  'get_url',
  'get_title',
  'semanticAction',
  'tabs',
  'close',
] as const;

export interface ChromeProfileBridgeTransport {
  send(
    command: ChromeBridgeCommand,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<ChromeBridgeResult>;
  handshake?(options?: { signal?: AbortSignal | undefined }): Promise<boolean>;
}

export interface ChromeProfileAdapterOptions {
  auth?: ChromeProfileAuth | undefined;
  bridge?: ChromeProfileBridgeTransport | undefined;
  /** Selected companion instanceId every command targets. Required for authorize when bridged. */
  targetInstanceId?: string | undefined;
  /** Session token stamped on every command. Defaults to PI_SEARCH_CHROME_BRIDGE_TOKEN. */
  bridgeToken?: string | (() => string | undefined) | undefined;
  now?: (() => number) | undefined;
  randomId?: (() => string) | undefined;
  dnsLookup?: DnsLookup | undefined;
  automationEnabled?: boolean | undefined;
  revokeTimeoutMs?: number | undefined;
}

export interface ChromeProfileExecuteOptions {
  signal?: AbortSignal | undefined;
}

interface PreparedOperation {
  operation: ChromeProfileOperation;
  typedValues: string[];
}

function chromeErrorResult(
  code: ChromeProfileErrorCode,
  message: string,
  retryable = false,
): BackendCallResult {
  const result = jsonTextResult({ ok: false, error: message });
  const details = (result.details ?? {}) as Record<string, unknown>;
  return {
    content: result.content,
    details: { ...details, chromeError: { code, message, retryable } },
  };
}

function defaultRandomId(): string {
  return randomUUID();
}

export class ChromeProfileAdapter {
  private readonly auth: ChromeProfileAuth;
  private readonly bridge: ChromeProfileBridgeTransport | null;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly dnsLookup?: DnsLookup | undefined;
  private readonly revokeTimeoutMs: number;
  private frozenHostname: string | null = null;
  private readonly typedMemory: string[] = [];
  private targetInstanceId: string | null;
  private readonly bridgeToken: string | (() => string | undefined);

  constructor(options?: ChromeProfileAdapterOptions) {
    this.auth =
      options?.auth ??
      new ChromeProfileAuth({
        automationEnabled: options?.automationEnabled ?? true,
      });
    if (options?.automationEnabled !== undefined) {
      this.auth.setAutomationEnabled(options.automationEnabled);
    }
    this.bridge = options?.bridge ?? null;
    this.targetInstanceId = options?.targetInstanceId ?? null;
    const tokenOption = options?.bridgeToken;
    this.bridgeToken = tokenOption ?? defaultBridgeToken;
    this.now = options?.now ?? Date.now;
    this.randomId = options?.randomId ?? defaultRandomId;
    this.dnsLookup = options?.dnsLookup;
    this.revokeTimeoutMs = options?.revokeTimeoutMs ?? 2000;
  }

  setAutomationEnabled(enabled: boolean): void {
    this.auth.setAutomationEnabled(enabled);
    if (!enabled) this.purgeSessionSecrets();
  }

  /** Drop grant-scoped secrets: frozen host + accumulated typed values. */
  private purgeSessionSecrets(): void {
    this.frozenHostname = null;
    this.typedMemory.length = 0;
  }

  /** Purge only when no live grant remains: a failed re-authorize must not
   *  wipe the session secrets of the grant that is still live. */
  private purgeIfLocked(): void {
    if (this.auth.currentGrant() === null) this.purgeSessionSecrets();
  }

  /** Bound companion target for the live grant; null until authorize binds it. */
  boundTarget(): string | null {
    return this.targetInstanceId;
  }

  /** Resolve the session token; undefined when the bridge never published one. */
  private resolveBridgeToken(): string | undefined {
    const token = typeof this.bridgeToken === 'function' ? this.bridgeToken() : this.bridgeToken;
    return typeof token === 'string' && token.length > 0 ? token : undefined;
  }

  /** Target + token stamp for every outbound command; null when unbound. */
  private commandStamp(): { targetInstanceId: string; bridgeToken: string } | null {
    const token = this.resolveBridgeToken();
    if (this.targetInstanceId === null || token === undefined) return null;
    return { targetInstanceId: this.targetInstanceId, bridgeToken: token };
  }

  /** Best-effort revoke of staged credentials after a post-ACK commit
   *  failure; the companion acked them, so locked Pi-side must not strand
   *  a live companion grant. Never throws. */
  private async revokeStagedRemote(grant: { sessionKey: string; grantId: string }): Promise<void> {
    if (this.bridge === null) return;
    const stamp = this.commandStamp();
    if (stamp === null) return;
    const command: ChromeBridgeCommand = {
      protocol: 1,
      id: this.randomId(),
      sessionKey: grant.sessionKey,
      grantId: grant.grantId,
      ...stamp,
      kind: 'revoke',
    };
    try {
      await this.sendWithTimeout(command, this.revokeTimeoutMs);
    } catch {
      // Intentionally ignored: local lock already holds; remote cleanup best-effort.
    }
  }

  status(): { state: 'locked'; reason?: string } | { state: 'authorized'; expiresAt: number | null } {
    return this.auth.status();
  }

  frozenHost(): string | null {
    return this.frozenHostname;
  }

  async authorize(ttlMs: number | null, confirmed: boolean, targetInstanceId?: string): Promise<BackendCallResult> {
    // Two-phase: stage the grant (inactive, Pi-side lock held) and go live
    // only after the companion authorize ack. Concurrent execute() during
    // the await observes locked and sends zero commands.
    let grant: { sessionKey: string; grantId: string; leaseExpiresAt: number };
    try {
      grant = this.auth.stageAuthorize(ttlMs, confirmed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return chromeErrorResult('chrome_locked', safeChromeProfileErrorMessage(message));
    }
    // Bind the grant to the selected companion before any bridge send: without
    // a target the authorize would be consumable by whichever instance polls first.
    const target = targetInstanceId ?? this.targetInstanceId;
    if (this.bridge !== null && (typeof target !== 'string' || target.length === 0)) {
      this.auth.abortAuthorize();
      this.purgeIfLocked();
      return chromeErrorResult('chrome_locked', 'authorization requires a selected companion instance');
    }
    const token = this.resolveBridgeToken();
    if (this.bridge !== null && token === undefined) {
      this.auth.abortAuthorize();
      this.purgeIfLocked();
      return chromeErrorResult('chrome_extension_unavailable', 'user-chrome bridge token unavailable', true);
    }
    if (this.bridge !== null) {
      this.targetInstanceId = target;
      const command: ChromeBridgeCommand = {
        protocol: 1,
        id: this.randomId(),
        sessionKey: grant.sessionKey,
        grantId: grant.grantId,
        targetInstanceId: target as string,
        bridgeToken: token as string,
        kind: 'authorize',
        leaseExpiresAt: grant.leaseExpiresAt,
      };
      try {
        const result = await this.bridge.send(command);
        if (!result.ok) {
          this.auth.abortAuthorize();
          this.purgeIfLocked();
          return chromeErrorResult(
            result.error.code,
            safeChromeProfileErrorMessage(result.error.message),
            result.error.retryable,
          );
        }
      } catch (error) {
        // Failed handshake discards the staged grant; a live grant survives.
        this.auth.abortAuthorize();
        this.purgeIfLocked();
        if (error instanceof ChromeBridgeError) {
          return chromeErrorResult(error.code, safeChromeProfileErrorMessage(error.message), error.retryable);
        }
        return chromeErrorResult(
          'chrome_extension_unavailable',
          safeChromeProfileErrorMessage(error instanceof Error ? error.message : String(error)),
          true,
        );
      }
    }
    if (this.bridge === null) {
      // Fail closed: no companion transport means no grant. Discard the
      // staged grant so /chrome status cannot report authorized for an
      // unusable backend.
      this.auth.abortAuthorize();
      this.purgeIfLocked();
      return chromeErrorResult('chrome_extension_unavailable', 'user-chrome bridge unavailable', true);
    }
    // Companion acked: go live. A revoke racing the handshake discarded the
    // staged grant, so commit throws and the late ack never resurrects it.
    // A failed commit after ACK leaves an orphan companion grant behind, so
    // revoke the staged credentials best-effort before reporting locked.
    try {
      this.auth.commitAuthorize();
    } catch (error) {
      await this.revokeStagedRemote(grant);
      this.purgeIfLocked();
      return chromeErrorResult('chrome_revoked', safeChromeProfileErrorMessage(error instanceof Error ? error.message : String(error)));
    }
    this.purgeSessionSecrets();
    const state = this.auth.status();
    return jsonTextResult({ ok: true, state: state.state, expiresAt: state.state === 'authorized' ? state.expiresAt : null });
  }

  async revoke(reason: ChromeRevokeReason = 'user'): Promise<BackendCallResult> {
    const grant = this.auth.currentGrant();
    // Sync local lock first; remote cleanup is bounded best-effort.
    this.auth.revoke(reason);
    this.purgeSessionSecrets();
    if (this.bridge !== null && grant !== null) {
      const stamp = this.commandStamp();
      if (stamp === null) {
        return jsonTextResult({ ok: true, revoked: true });
      }
      const command: ChromeBridgeCommand = {
        protocol: 1,
        id: this.randomId(),
        sessionKey: grant.sessionKey,
        grantId: grant.grantId,
        ...stamp,
        kind: 'revoke',
      };
      try {
        await this.sendWithTimeout(command, this.revokeTimeoutMs);
      } catch {
        // Intentionally ignored: local lock already holds; remote cleanup best-effort.
      }
    }
    return jsonTextResult({ ok: true, revoked: true });
  }

  async shutdown(): Promise<void> {
    const grant = this.auth.currentGrant();
    this.auth.shutdown();
    this.purgeSessionSecrets();
    if (this.bridge !== null && grant !== null) {
      const stamp = this.commandStamp();
      if (stamp !== null) {
        const command: ChromeBridgeCommand = {
          protocol: 1,
          id: this.randomId(),
          sessionKey: grant.sessionKey,
          grantId: grant.grantId,
          ...stamp,
          kind: 'revoke',
        };
        try {
          await this.sendWithTimeout(command, this.revokeTimeoutMs);
        } catch {
          // Intentionally ignored: shutdown lock already holds; remote cleanup best-effort.
        }
      }
    }
  }

  async doctor(signal?: AbortSignal): Promise<ChromeDoctorResult> {
    const authorized = this.auth.status().state === 'authorized';
    if (this.bridge?.handshake === undefined) {
      return { bridgeReachable: this.bridge !== null, protocol: CHROME_BRIDGE_PROTOCOL, authorized };
    }
    const started = this.now();
    try {
      const reachable = await this.bridge.handshake(signal !== undefined ? { signal } : undefined);
      return {
        bridgeReachable: reachable,
        protocol: CHROME_BRIDGE_PROTOCOL,
        authorized,
        latencyMs: this.now() - started,
      };
    } catch {
      return { bridgeReachable: false, protocol: CHROME_BRIDGE_PROTOCOL, authorized };
    }
  }

  async execute(
    rawArgs: Record<string, unknown>,
    options?: ChromeProfileExecuteOptions,
  ): Promise<BackendCallResult> {
    const actionRaw = typeof rawArgs.action === 'string' ? rawArgs.action : 'status';
    if (!(BROWSER_ACTIONS as readonly string[]).includes(actionRaw)) {
      return chromeErrorResult('chrome_invalid_request', `unsupported browser action: ${actionRaw.slice(0, 64)}`);
    }
    const action = actionRaw as BrowserAction;

    // status reports Pi-side auth state only; never touches the bridge.
    if (action === 'status') {
      const state = this.auth.status();
      return jsonTextResult({ ok: true, context: 'user-chrome', ...state });
    }

    // Phase 1 allowlist. ALLOW_SENSITIVE must not override these denials.
    if ((USER_CHROME_DENIED_ACTIONS as readonly string[]).includes(action)) {
      const reason = action === 'job' ? 'deferred in user-chrome context' : 'denied in user-chrome context';
      return chromeErrorResult('chrome_invalid_request', `action '${action}' ${reason}`);
    }
    if (!(USER_CHROME_BRIDGE_ACTIONS as readonly string[]).includes(action)) {
      return chromeErrorResult('chrome_invalid_request', `action '${action}' denied in user-chrome context`);
    }

    // Pi-side lock before any bridge dispatch.
    if (!this.auth.canExecute()) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    const grant = this.auth.currentGrant();
    if (grant === null) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    if (this.bridge === null) {
      return chromeErrorResult('chrome_extension_unavailable', 'user-chrome bridge unavailable', true);
    }

    let prepared: PreparedOperation;
    try {
      prepared = await this.prepareOperation(action, rawArgs, options?.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^chrome_[a-z_]+:/.test(message)
        ? (message.split(':')[0] as ChromeProfileErrorCode)
        : 'chrome_invalid_request';
      const clean = message.replace(/^[a-z_]+:\s*/, '');
      if (code === 'chrome_domain_blocked') {
        return chromeErrorResult(code, safeChromeProfileErrorMessage(clean));
      }
      return chromeErrorResult('chrome_invalid_request', safeChromeProfileErrorMessage(clean));
    }

    const secrets = {
      sessionKey: grant.sessionKey,
      grantId: grant.grantId,
      typedValues: [...this.typedMemory, ...prepared.typedValues],
    };
    const grantSessionKey = grant.sessionKey;
    const grantGrantId = grant.grantId;
    const stamp = this.commandStamp();
    if (stamp === null) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    const command: ChromeBridgeCommand = {
      protocol: 1,
      id: this.randomId(),
      sessionKey: grant.sessionKey,
      grantId: grant.grantId,
      ...stamp,
      kind: 'execute',
      operation: prepared.operation,
    };
    let result: ChromeBridgeResult;
    try {
      result = await this.bridge.send(command, options?.signal !== undefined ? { signal: options.signal } : undefined);
      if (prepared.typedValues.length > 0) {
        this.typedMemory.push(...prepared.typedValues);
        if (this.typedMemory.length > MAX_TYPED_MEMORY_VALUES) {
          this.typedMemory.splice(0, this.typedMemory.length - MAX_TYPED_MEMORY_VALUES);
        }
      }
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        return chromeErrorResult(error.code, safeChromeProfileErrorMessage(error.message, secrets), error.retryable);
      }
      return chromeErrorResult(
        'chrome_extension_unavailable',
        safeChromeProfileErrorMessage(error instanceof Error ? error.message : String(error), secrets),
        true,
      );
    }

    // Revoke race: a revoke during flight invalidates the local grant first;
    // a late success must never surface as success-after-revoke.
    const live = this.auth.currentGrant();
    if (live === null || live.sessionKey !== grantSessionKey || live.grantId !== grantGrantId) {
      return chromeErrorResult('chrome_revoked', 'command revoked before completion');
    }

    if (!result.ok) {
      return chromeErrorResult(
        result.error.code,
        safeChromeProfileErrorMessage(result.error.message, secrets),
        result.error.retryable,
      );
    }
    return this.toBackendResult(action, result.data, secrets);
  }

  /** Renew the companion lease (send-first: local lease renews only on companion ack). */
  async renewLease(options?: ChromeProfileExecuteOptions): Promise<BackendCallResult> {
    if (!this.auth.canExecute()) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    const grant = this.auth.currentGrant();
    if (grant === null) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    if (this.bridge === null) {
      return chromeErrorResult('chrome_extension_unavailable', 'user-chrome bridge unavailable', true);
    }
    const leaseExpiresAt = this.now() + CHROME_LEASE_MAX_MS;
    const stamp = this.commandStamp();
    if (stamp === null) {
      return chromeErrorResult('chrome_locked', 'user-chrome control locked; run /chrome authorize first');
    }
    const command: ChromeBridgeCommand = {
      protocol: 1,
      id: this.randomId(),
      sessionKey: grant.sessionKey,
      grantId: grant.grantId,
      ...stamp,
      kind: 'renew',
      leaseExpiresAt,
    };
    try {
      const result = await this.bridge.send(command, options?.signal !== undefined ? { signal: options.signal } : undefined);
      if (!result.ok) {
        return chromeErrorResult(
          result.error.code,
          safeChromeProfileErrorMessage(result.error.message),
          result.error.retryable,
        );
      }
    } catch (error) {
      if (error instanceof ChromeBridgeError) {
        return chromeErrorResult(error.code, safeChromeProfileErrorMessage(error.message), error.retryable);
      }
      return chromeErrorResult(
        'chrome_extension_unavailable',
        safeChromeProfileErrorMessage(error instanceof Error ? error.message : String(error)),
        true,
      );
    }
    // Companion acked: renew the Pi-side lease. A stale local expiry surfaces here.
    try {
      this.auth.renewLease();
    } catch (error) {
      return chromeErrorResult('chrome_revoked', safeChromeProfileErrorMessage(error instanceof Error ? error.message : String(error)));
    }
    const live = this.auth.currentGrant();
    return jsonTextResult({ ok: true, leaseExpiresAt: live?.leaseExpiresAt ?? leaseExpiresAt });
  }

  private async sendWithTimeout(command: ChromeBridgeCommand, timeoutMs: number): Promise<ChromeBridgeResult> {
    if (this.bridge === null) throw new ChromeBridgeError('chrome_extension_unavailable', 'bridge unavailable', true, 503);
    // Capture the send promise first and neutralize a late rejection so the
    // losing side of the race cannot crash the process as unhandled.
    const send = this.bridge.send(command);
    send.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ChromeBridgeError('chrome_timeout', 'revoke cleanup timed out', false, 504)), timeoutMs);
        if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref();
        }
      });
      return await Promise.race([send, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async prepareOperation(
    action: BrowserAction,
    raw: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<PreparedOperation> {
    switch (action) {
      case 'navigate': {
        if (typeof raw.url !== 'string' || raw.url.trim().length === 0) {
          throw new Error('chrome_invalid_request: url is required');
        }
        if (raw.url.length > 8000) throw new Error('chrome_invalid_request: url too long');
        let normalized: string;
        try {
          normalized = validateNavigationUrl(raw.url);
        } catch (error) {
          throw new Error(`chrome_domain_blocked: ${error instanceof Error ? error.message : String(error)}`);
        }
        const hostname = new URL(normalized).hostname.toLowerCase();
        try {
          await dnsPreflight(hostname, signal, this.dnsLookup);
        } catch (error) {
          throw new Error(`chrome_domain_blocked: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (this.frozenHostname === null) {
          this.frozenHostname = hostname;
        } else if (hostname !== this.frozenHostname) {
          throw new Error(
            `chrome_domain_blocked: navigation to ${hostname} blocked by frozen host ${this.frozenHostname}`,
          );
        }
        return { operation: { kind: 'navigate', url: normalized, frozenHostname: this.frozenHostname }, typedValues: [] };
      }
      case 'snapshot': {
        return { operation: { kind: 'snapshot', compact: raw.compact === true }, typedValues: [] };
      }
      case 'text':
        return { operation: { kind: 'text' }, typedValues: [] };
      case 'screenshot':
        return { operation: { kind: 'screenshot' }, typedValues: [] };
      case 'click': {
        if (typeof raw.selector !== 'string') throw new Error('chrome_invalid_request: selector is required');
        return { operation: { kind: 'click', selector: validateSelector(raw.selector) }, typedValues: [] };
      }
      case 'type':
      case 'fill': {
        if (typeof raw.selector !== 'string') throw new Error('chrome_invalid_request: selector is required');
        if (typeof raw.text !== 'string') throw new Error('chrome_invalid_request: text is required');
        const selector = validateSelector(raw.selector);
        const text = validateText(raw.text);
        return {
          operation: action === 'type' ? { kind: 'type', selector, text } : { kind: 'fill', selector, text },
          typedValues: [text],
        };
      }
      case 'select': {
        if (typeof raw.selector !== 'string') throw new Error('chrome_invalid_request: selector is required');
        if (!Array.isArray(raw.values) || raw.values.length === 0) {
          throw new Error('chrome_invalid_request: values must be a non-empty array of strings');
        }
        if (raw.values.length > MAX_SELECT_VALUES) {
          throw new Error(`chrome_invalid_request: too many values (max ${MAX_SELECT_VALUES})`);
        }
        if (!raw.values.every((v): v is string => typeof v === 'string')) {
          throw new Error('chrome_invalid_request: values must be an array of strings');
        }
        const selector = validateSelector(raw.selector);
        const values = raw.values.map((v) => validateText(v));
        return { operation: { kind: 'select', selector, values }, typedValues: [...values] };
      }
      case 'scroll': {
        const x = validateScrollCoord(raw.x, 'x');
        const y = validateScrollCoord(raw.y, 'y');
        return { operation: { kind: 'scroll', x, y }, typedValues: [] };
      }
      case 'wait': {
        const waitMs = validateWaitMs(typeof raw.waitMs === 'number' ? raw.waitMs : 0);
        const op: ChromeProfileOperation = { kind: 'wait', waitMs };
        if (raw.selector !== undefined) {
          if (typeof raw.selector !== 'string') throw new Error('chrome_invalid_request: selector must be a string');
          (op as { selector?: string }).selector = validateSelector(raw.selector);
        }
        if (raw.text !== undefined) {
          if (typeof raw.text !== 'string') throw new Error('chrome_invalid_request: text must be a string');
          (op as { text?: string }).text = validateText(raw.text);
        }
        return { operation: op, typedValues: [] };
      }
      case 'get_url':
        return { operation: { kind: 'get_url' }, typedValues: [] };
      case 'get_title':
        return { operation: { kind: 'get_title' }, typedValues: [] };
      case 'semanticAction': {
        if (typeof raw.semanticAction !== 'object' || raw.semanticAction === null) {
          throw new Error('chrome_invalid_request: semanticAction is required');
        }
        const validated = validateSemanticActionRequest(raw.semanticAction as Record<string, unknown>);
        const typedValues = typeof validated.value === 'string' ? [validated.value] : [];
        return {
          operation: {
            kind: 'semantic_action',
            request: {
              locator: validated.locator,
              query: validated.query,
              verb: validated.verb,
              ...(validated.name !== undefined ? { name: validated.name } : {}),
              ...(validated.index !== undefined ? { index: validated.index } : {}),
              ...(validated.value !== undefined ? { value: validated.value } : {}),
              ...(validated.exact === true ? { exact: true as const } : {}),
            },
          },
          typedValues,
        };
      }
      case 'tabs':
        return { operation: { kind: 'tabs' }, typedValues: [] };
      case 'close': {
        const result: PreparedOperation = { operation: { kind: 'close' }, typedValues: [] };
        return result;
      }
      default:
        throw new Error(`chrome_invalid_request: action '${action}' denied in user-chrome context`);
    }
  }

  private toBackendResult(
    action: BrowserAction,
    data: unknown,
    secrets: { sessionKey: string; grantId: string; typedValues: string[] },
  ): BackendCallResult {
    const record = (typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}) as Record<
      string,
      unknown
    >;
    if (action === 'screenshot') {
      const base64 = record['screenshotBase64'];
      if (typeof base64 !== 'string' || base64.length === 0) {
        return chromeErrorResult('chrome_invalid_result', 'screenshot returned no data');
      }
      // Image-only: base64 never duplicated into text/details.
      return {
        content: [{ type: 'image', mimeType: 'image/png', data: base64 }],
        details: { mediaType: 'image/png', context: 'user-chrome' },
      };
    }
    if (action === 'snapshot' && typeof record['snapshot'] === 'string') {
      return textResult(redactChromeProfileText(record['snapshot'], secrets), {
        context: 'user-chrome',
      });
    }
    if (action === 'text' && typeof record['text'] === 'string') {
      return textResult(redactChromeProfileText(record['text'], secrets), { context: 'user-chrome' });
    }
    if (action === 'get_url' && typeof record['url'] === 'string') {
      return textResult(redactChromeProfileText(record['url'], secrets), { context: 'user-chrome' });
    }
    if (action === 'get_title' && typeof record['title'] === 'string') {
      return textResult(redactChromeProfileText(record['title'], secrets), { context: 'user-chrome' });
    }
    if (action === 'type' || action === 'fill') {
      // Typed values reach the page payload but are never echoed back.
      return jsonTextResult({ ok: true });
    }
    if (action === 'close') {
      this.frozenHostname = null;
      return jsonTextResult({ ok: true, closed: true });
    }
    const text = JSON.stringify(data ?? { ok: true });
    return textResult(redactChromeProfileText(text, secrets), { context: 'user-chrome' });
  }
}
