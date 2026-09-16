// Agent RPC capability negotiation (Plan C5): pi-subagents runtime RPC is
// negotiated per the S3 findings; with no handshake present the record is a
// fail-closed no-op and the core runs standalone. The negotiation attempt is
// always recorded on the job — never silently skipped.
//
// Leaf-runtime seam: agent-jobs registers a provider via
// setLeafRuntimeProvider (wired in src/index.ts only when
// PI_NORTHSTAR_LEAF_MODEL is set). executeAgentJob calls refreshReady() per
// job before first use; transport 'leaf-runtime' records only on a fresh
// successful negotiate. Snapshots carry transport + safe reason only — never
// provider/model identity.

export type AgentTransport = 'standalone' | 'leaf-runtime';

export interface AgentRpcRecord {
  /** True once a negotiation attempt ran (even when nothing was found). */
  attempted: boolean;
  negotiated: boolean;
  /** v1 transports: standalone, or leaf-runtime via the registered provider. */
  transport: AgentTransport;
  reason: string;
  /**
   * Negotiated leaf output modes (record-level only; snapshots carry
   * transport + reason only). Absent when nothing negotiated them.
   */
  outputModes?: readonly string[];
  /**
   * Negotiated v2 correlation capability (record-level only). Absent means
   * v1-only: consumers compose v1 correlation forever.
   */
  correlationV2?: {
    ownerPattern: string;
    roles: readonly string[];
  };
  /**
   * Negotiated JSON-schema dialect (record-level only; snapshots carry
   * transport + reason only). Absent means v1-only/text. Observability
   * only — no gating change.
   */
  jsonSchema?: 'flat-v1' | 'structured-v1';
}

export interface AgentRpcNegotiationInput {
  /** Operator-supplied RPC endpoint when a handshake exists. Absent = standalone. */
  endpoint?: string;
}

/** Negotiated leaf capabilities surfaced by providers that negotiate (LeafRuntimeClient). */
export interface LeafNegotiatedCapabilities {
  outputModes: readonly string[];
  correlationV2?: {
    ownerPattern: string;
    roles: readonly string[];
  };
  /**
   * Negotiated JSON-schema dialect (observability only; wire gating lives in
   * the leaf client via getNegotiatedCapabilities/supportsJsonOutput).
   * Absent means v1-only/text.
   */
  jsonSchema?: 'flat-v1' | 'structured-v1';
}

/** Minimal leaf provider surface. Satisfied structurally by LeafRuntimeClient. */
export interface LeafRuntimeProvider {
  refreshReady(): Promise<boolean>;
  runLeaf(
    prompt: string,
    opts?: {
      maxOutputTokens?: number;
      timeoutMs?: number;
      outputSchema?: Record<string, unknown>;
      role?: string;
      stage?: string;
    },
  ): Promise<{ text: string }>;
  /** Optional negotiated capabilities; absence means v1-only/text. */
  getNegotiatedCapabilities?(): LeafNegotiatedCapabilities | undefined;
}

let leafProvider: LeafRuntimeProvider | undefined;

/** Module-level seam: register (or clear) the leaf runtime provider. */
export function setLeafRuntimeProvider(provider: LeafRuntimeProvider | undefined): void {
  leafProvider = provider;
}

/** Module-level seam read: the currently registered provider, if any. */
export function getLeafRuntimeProvider(): LeafRuntimeProvider | undefined {
  return leafProvider;
}

/**
 * Shutdown helper: clear the seam and dispose the leaf client. The seam
 * clears first, so a throwing dispose never leaves a stale provider
 * behind; dispose errors stay best-effort (shutdown path already runs
 * inside Promise.allSettled). Testable without the extension host.
 */
export function shutdownLeafRuntime(client?: { dispose(): void }): void {
  setLeafRuntimeProvider(undefined);
  try {
    client?.dispose();
  } catch {
    // Best-effort shutdown; seam already cleared.
  }
}

/**
 * Fail-closed negotiation: no endpoint (and no known handshake) records
 * negotiated:false and the core runs standalone.
 */
export function negotiateAgentRpc(input: AgentRpcNegotiationInput = {}): AgentRpcRecord {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  if (endpoint === '') {
    return {
      attempted: true,
      negotiated: false,
      transport: 'standalone',
      reason: 'no pi-subagents RPC handshake available; core runs standalone',
    };
  }
  // Unknown endpoint shapes never half-negotiate: fail closed, stay standalone.
  // Static reason: caller-supplied endpoint content must not flow into snapshots.
  return {
    attempted: true,
    negotiated: false,
    transport: 'standalone',
    reason: 'unrecognized RPC endpoint shape; core runs standalone',
  };
}
