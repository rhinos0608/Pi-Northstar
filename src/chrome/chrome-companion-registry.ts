// Multi-companion registry for the single bridge (127.0.0.1:17319).
//
// One registry per bridge port. Companions register an ephemeral instanceId
// (random, held in chrome.storage.session, cleared on browser/extension
// restart) plus claimed family/version/evidence and a lastSeen heartbeat.
// Instance identity is NOT profile identity: no profile path, email, or
// pairing is stored or claimed here.
//
// TRUST POSTURE (deliberate, consistent with the loopback-debug posture where
// the local enforcing proxy plus container egress are the outer defense):
// register() performs structural validation only (assertClaim: known family,
// non-empty bounded version/evidence). There is NO authentication of the
// claimant — any same-user local process can POST a claim to the loopback
// bridge. Hostile same-user processes are explicitly OUT OF SCOPE here: the
// registry never grants authority (no profile paths, no cookies, no tokens),
// so a forged claim yields at most a misleading family/version label in a
// local debug listing. Do not add an auth mechanism to this registry; contain
// at the proxy/egress boundary instead.

import { randomUUID } from 'node:crypto';
import { CHROME_BRIDGE_PORT } from './chrome-profile-contract.js';
import type { ChromiumFamily } from './chrome-os-default.js';
import { CHROMIUM_FAMILIES } from './chrome-os-default.js';

export const COMPANION_REGISTRY_PORT = CHROME_BRIDGE_PORT;
export const COMPANION_HEARTBEAT_TTL_MS = 90_000;
export const COMPANION_MAX_VERSION_CHARS = 64;
export const COMPANION_MAX_EVIDENCE_CHARS = 240;

export interface CompanionClaim {
  family: ChromiumFamily;
  version: string;
  evidence: string;
}

export interface CompanionEntry extends CompanionClaim {
  instanceId: string;
  lastSeen: number;
}

export interface CompanionRegistryDeps {
  now?: (() => number) | undefined;
  randomId?: (() => string) | undefined;
  heartbeatTtlMs?: number | undefined;
}

function defaultRandomId(): string {
  return randomUUID();
}

function cleanBounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function assertClaim(claim: CompanionClaim): { family: ChromiumFamily; version: string; evidence: string } {
  if (!(CHROMIUM_FAMILIES as readonly string[]).includes(claim.family)) {
    throw new Error(`companion-registry: unknown family: ${String(claim.family).slice(0, 32)}`);
  }
  if (typeof claim.version !== 'string' || claim.version.trim().length === 0) {
    throw new Error('companion-registry: version must be a non-empty string');
  }
  if (typeof claim.evidence !== 'string' || claim.evidence.trim().length === 0) {
    throw new Error('companion-registry: evidence must be a non-empty string');
  }
  return {
    family: claim.family,
    version: cleanBounded(claim.version, COMPANION_MAX_VERSION_CHARS),
    evidence: cleanBounded(claim.evidence, COMPANION_MAX_EVIDENCE_CHARS),
  };
}

export class CompanionRegistry {
  private readonly entries = new Map<string, CompanionEntry>();
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly ttlMs: number;

  constructor(deps?: CompanionRegistryDeps) {
    this.now = deps?.now ?? Date.now;
    this.randomId = deps?.randomId ?? defaultRandomId;
    this.ttlMs = deps?.heartbeatTtlMs ?? COMPANION_HEARTBEAT_TTL_MS;
  }

  get port(): number {
    return COMPANION_REGISTRY_PORT;
  }

  /**
   * Register a companion claim; returns the ephemeral entry.
   *
   * Structural validation only — no authentication. Same-user local processes
   * are trusted the same as the genuine companion (out of scope by design;
   * see module header). Claims confer no authority: ephemeral instanceId plus
   * display-only family/version/evidence.
   */
  register(claim: CompanionClaim): CompanionEntry {
    const clean = assertClaim(claim);
    const entry: CompanionEntry = {
      ...clean,
      instanceId: this.randomId(),
      lastSeen: this.now(),
    };
    this.entries.set(entry.instanceId, { ...entry });
    return { ...entry };
  }

  /** Refresh lastSeen for a live instance. Returns false when unknown. */
  heartbeat(instanceId: string): boolean {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) return false;
    entry.lastSeen = this.now();
    return true;
  }

  remove(instanceId: string): boolean {
    return this.entries.delete(instanceId);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Live companions (fresh heartbeat), oldest first. */
  list(): CompanionEntry[] {
    this.prune();
    return [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) => a.lastSeen - b.lastSeen);
  }

  liveCount(): number {
    return this.list().length;
  }

  /** Drop entries with stale heartbeats. Returns removed count. */
  prune(now: number = this.now()): number {
    let removed = 0;
    for (const [id, entry] of this.entries) {
      if (now - entry.lastSeen > this.ttlMs) {
        this.entries.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
