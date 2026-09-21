export type BrokerErrorCode =
  | 'invalid_frame' | 'frame_too_large' | 'unsupported_version' | 'unauthorized'
  | 'expired_token' | 'epoch_mismatch' | 'scope_denied' | 'project_denied'
  | 'endpoint_unsafe' | 'sequence_replay' | 'duplicate_mutation' | 'transport_closed';
export class BrokerError extends Error { readonly code: BrokerErrorCode; constructor(code: BrokerErrorCode, message = code) { super(message); this.name = 'BrokerError'; this.code = code; } }
/** Mutation dispatch ended with transport loss; caller must not retry blindly. */
export class BrokerOutcomeError extends BrokerError {
  readonly outcome = 'outcome_unknown' as const;
  readonly retryable = false as const;
  constructor() { super('transport_closed'); this.name = 'BrokerOutcomeError'; this.message = 'OUTCOME_UNKNOWN: mutation dispatch status unknown'; }
}
export const BROKER_ERROR_MESSAGES: Record<BrokerErrorCode, string> = { invalid_frame: 'Malformed broker frame.', frame_too_large: 'Broker frame exceeds limit.', unsupported_version: 'Unsupported broker protocol version.', unauthorized: 'Broker authentication failed.', expired_token: 'Broker token expired.', epoch_mismatch: 'Broker token belongs to old broker epoch.', scope_denied: 'Broker capability scope denied.', project_denied: 'Broker project scope denied.', endpoint_unsafe: 'Broker endpoint is not owned securely.', sequence_replay: 'Broker request sequence is invalid.', duplicate_mutation: 'Broker mutation was already submitted.', transport_closed: 'Broker transport closed.' };
