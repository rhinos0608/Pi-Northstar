// Chrome profile authorization state machine (Worker 1).
//
// Pure TTL/lease logic with injectable clock + id generator. No network, no
// disk, no Pi-runtime imports. The bridge (Worker 2) and adapter (Worker 4)
// enforce companion-side grant checks separately; this module is the Pi-side
// lock. `chrome.storage.session` restore and process I/O live elsewhere.
//
// Rules:
// - Initial state locked.
// - authorize() requires explicit confirmation (caller passes confirmed=true).
// - Default TTL 15m; custom Nm integer 1-120m; `indefinite` (ttlMs null)
//   lasts until revoke/shutdown only.
// - Companion lease max 60s regardless; `indefinite` changes Pi expiry only.
// - revoke()/shutdown() lock synchronously before any remote cleanup.
// - PI_SEARCH_BROWSER_AUTOMATION=0 blocks authorize and execution; surfaced
//   here as an injectable automationEnabled flag (env read lives in Worker 5).

import { randomUUID } from 'node:crypto';
import {
  CHROME_LEASE_MAX_MS,
  CHROME_LEASE_RENEW_MS,
  type ChromeAuthorizationState,
} from './chrome-profile-contract.js';

export const CHROME_AUTH_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const CHROME_AUTH_MIN_TTL_MS = 1 * 60 * 1000;
export const CHROME_AUTH_MAX_TTL_MS = 120 * 60 * 1000;

export type ChromeRevokeReason = 'user' | 'expired' | 'shutdown';

export type ChromeTtlSpec =
  | { kind: 'default' }
  | { kind: 'minutes'; minutes: number }
  | { kind: 'indefinite' };

/** Parse `/chrome authorize` TTL args: undefined/'' = 15m, 'Nm', 'indefinite'. */
export function parseChromeAuthorizeArg(arg: string | undefined): ChromeTtlSpec {
  if (arg === undefined || arg.trim() === '') return { kind: 'default' };
  const trimmed = arg.trim().toLowerCase();
  if (trimmed === 'indefinite') return { kind: 'indefinite' };
  const match = /^(\d+)m$/.exec(trimmed);
  if (!match) throw new Error(`invalid authorize argument: ${arg} (expected 15m, 30m, Nm, or indefinite)`);
  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
    throw new Error(`authorize minutes must be an integer in [1, 120], got: ${arg}`);
  }
  return { kind: 'minutes', minutes };
}

export function chromeTtlMsForSpec(spec: ChromeTtlSpec): number | null {
  switch (spec.kind) {
    case 'default':
      return CHROME_AUTH_DEFAULT_TTL_MS;
    case 'minutes':
      return spec.minutes * 60 * 1000;
    case 'indefinite':
      return null;
  }
}

export interface ChromeProfileAuthDeps {
  now?: () => number;
  randomId?: () => string;
  /** False when PI_SEARCH_BROWSER_AUTOMATION=0. Defaults true. */
  automationEnabled?: boolean;
}

export interface ChromeGrantRef {
  sessionKey: string;
  grantId: string;
  nonce: string;
  expiresAt: number | null;
  leaseExpiresAt: number;
}

export class ChromeProfileAuth {
  private expiresAt: number | null = null;
  private revokedReason: 'initial' | 'revoked' | 'expired' | 'shutdown' = 'initial';
  private grant: ChromeGrantRef | null = null;
  /** Grant staged for a companion handshake: inactive until commitAuthorize(). */
  private staged: ChromeGrantRef | null = null;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private automationEnabled: boolean;

  constructor(deps?: ChromeProfileAuthDeps) {
    this.now = deps?.now ?? Date.now;
    this.randomId = deps?.randomId ?? defaultRandomId;
    this.automationEnabled = deps?.automationEnabled ?? true;
  }

  setAutomationEnabled(enabled: boolean): void {
    this.automationEnabled = enabled;
    if (!enabled) {
      this.staged = null;
      this.lockLocal('revoked');
    }
  }

  isAutomationEnabled(): boolean {
    return this.automationEnabled;
  }

  /** Current state, expiring lazily on read under the injected clock. */
  status(): ChromeAuthorizationState {
    if (this.grant === null) {
      return this.revokedReason === 'initial'
        ? { state: 'locked' }
        : { state: 'locked', reason: this.revokedReason };
    }
    if (this.expiresAt !== null && this.now() >= this.expiresAt) {
      this.lockLocal('expired');
      return { state: 'locked', reason: 'expired' };
    }
    return { state: 'authorized', expiresAt: this.expiresAt };
  }

  canExecute(): boolean {
    if (!this.automationEnabled) return false;
    return this.status().state === 'authorized';
  }

  /**
   * Two-phase handshake: stage a grant (inactive: status() stays locked,
   * canExecute()/currentGrant()/matchesGrant() all closed), then
   * commitAuthorize() only after the companion authorize ack, or
   * abortAuthorize() on failure. A concurrent execute() during staging
   * observes locked and sends zero commands.
   */
  stageAuthorize(ttlMs: number | null, confirmed: boolean): ChromeGrantRef {
    if (this.staged !== null) throw new Error('chrome_locked: authorization already in progress');
    const grant = this.buildGrant(ttlMs, confirmed);
    this.staged = grant;
    return { ...grant };
  }

  /** Activate the staged grant. Throws chrome_revoked when nothing staged
   *  (e.g. a revoke/shutdown raced the handshake and discarded it). */
  commitAuthorize(): ChromeGrantRef {
    const staged = this.staged;
    if (staged === null) throw new Error('chrome_revoked: authorization superseded');
    this.staged = null;
    staged.leaseExpiresAt = this.now() + CHROME_LEASE_MAX_MS;
    this.grant = staged;
    this.expiresAt = staged.expiresAt;
    this.revokedReason = 'initial';
    return { ...staged };
  }

  /** Discard the staged grant; live grant (if any) untouched. */
  abortAuthorize(): void {
    this.staged = null;
  }

  /**
   * Authorize a new grant. Requires confirmed=true (ctx.ui.confirm).
   * Prefer stageAuthorize/commitAuthorize for bridged handshakes so the
   * grant goes live only after the companion authorize ack; this immediate
   * form is for local-only callers with no bridge round-trip.
   */
  authorize(ttlMs: number | null, confirmed: boolean): ChromeGrantRef {
    const grant = this.buildGrant(ttlMs, confirmed);
    this.grant = grant;
    this.expiresAt = grant.expiresAt;
    this.revokedReason = 'initial';
    return { ...grant };
  }

  private buildGrant(ttlMs: number | null, confirmed: boolean): ChromeGrantRef {
    if (!this.automationEnabled) throw new Error('chrome_locked: browser automation is disabled');
    if (!confirmed) throw new Error('chrome_locked: authorization requires confirmation');
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) {
      throw new Error('chrome_locked: invalid TTL');
    }
    const now = this.now();
    return {
      sessionKey: this.randomId(),
      grantId: this.randomId(),
      nonce: this.randomId(),
      expiresAt: ttlMs === null ? null : now + ttlMs,
      leaseExpiresAt: now + CHROME_LEASE_MAX_MS,
    };
  }

  /** Dual-grant check: both sessionKey and grantId must match the live grant. */
  matchesGrant(sessionKey: string, grantId: string): boolean {
    if (this.status().state !== 'authorized' || this.grant === null) return false;
    return this.grant.sessionKey === sessionKey && this.grant.grantId === grantId;
  }

  /** Ms until the companion lease expires; -Infinity when no grant. */
  msUntilLeaseExpiry(): number {
    if (this.grant === null) return Number.NEGATIVE_INFINITY;
    return this.grant.leaseExpiresAt - this.now();
  }

  /**
   * True when the 60s companion lease should be renewed now: live grant
   * whose remaining lease is within the 30s renewal window.
   */
  leaseRenewalDue(): boolean {
    if (this.grant === null || this.status().state !== 'authorized') return false;
    return this.msUntilLeaseExpiry() <= CHROME_LEASE_RENEW_MS;
  }

  /** Renew the companion lease (max 60s from now). Pi expiry unchanged. */
  renewLease(): number {
    const grant = this.requireGrant();
    const now = this.now();
    if (grant.expiresAt !== null && now >= grant.expiresAt) {
      this.lockLocal('expired');
      throw new Error('chrome_revoked: grant expired');
    }
    grant.leaseExpiresAt = now + CHROME_LEASE_MAX_MS;
    return grant.leaseExpiresAt;
  }

  isLeaseLive(): boolean {
    if (this.grant === null) return false;
    return this.now() < this.grant.leaseExpiresAt;
  }

  currentGrant(): ChromeGrantRef | null {
    if (this.status().state !== 'authorized') return null;
    return this.grant === null ? null : { ...this.grant };
  }

  /** Synchronous local lock; remote cleanup happens after, best-effort. */
  revoke(_reason: ChromeRevokeReason): void {
    this.lockLocal(_reason === 'shutdown' ? 'shutdown' : _reason === 'expired' ? 'expired' : 'revoked');
  }

  shutdown(): void {
    this.lockLocal('shutdown');
  }

  private requireGrant(): ChromeGrantRef {
    if (this.grant === null || this.status().state !== 'authorized') {
      throw new Error('chrome_locked: not authorized');
    }
    return this.grant;
  }

  private lockLocal(reason: 'revoked' | 'expired' | 'shutdown' | 'initial'): void {
    this.grant = null;
    this.staged = null;
    this.expiresAt = null;
    this.revokedReason = reason === 'initial' ? 'initial' : reason;
  }
}

function defaultRandomId(): string {
  return randomUUID();
}
