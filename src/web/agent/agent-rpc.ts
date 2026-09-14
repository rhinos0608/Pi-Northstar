// Agent RPC capability negotiation (Plan C5): pi-subagents runtime RPC is
// negotiated per the S3 findings; with no handshake present the record is a
// fail-closed no-op and the core runs standalone. The negotiation attempt is
// always recorded on the job — never silently skipped.

export interface AgentRpcRecord {
  /** True once a negotiation attempt ran (even when nothing was found). */
  attempted: boolean;
  negotiated: boolean;
  /** v1 has no remote transport: standalone only. */
  transport: 'standalone';
  reason: string;
}

export interface AgentRpcNegotiationInput {
  /** Operator-supplied RPC endpoint when a handshake exists. Absent = standalone. */
  endpoint?: string;
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
  return {
    attempted: true,
    negotiated: false,
    transport: 'standalone',
    reason: `unrecognized RPC endpoint shape (${endpoint.slice(0, 32)}); core runs standalone`,
  };
}
