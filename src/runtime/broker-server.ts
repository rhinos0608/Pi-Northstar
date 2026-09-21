import { createServer, type Server, type Socket } from 'node:net';
import { chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { brokerEndpoint, ensureOwnerOnlyDirectory, assertOwner, removeStaleEndpoint, type BrokerEndpoint } from './broker-endpoint.js';
import { createBrokerAuth, issueBrokerWelcome, verifyBrokerToken, type BrokerAuth } from './broker-auth.js';
import { BrokerError, type BrokerErrorCode } from './broker-errors.js';
import { capabilityForMethod, isBrokerHello, isBrokerRequest, isBrokerQuery, type BrokerHello, type BrokerRequest, type BrokerResponse, type BrokerErrorMessage, type BrokerQuery } from './broker-protocol.js';
import { readBrokerFrames, sendBrokerMessage } from './broker-transport.js';
import { validateRequest, validateReply, type RuntimeRpcReply, type RuntimeRpcV1Request } from './runtime-rpc-protocol.js';
import { BrokerReadIdempotencyCache, BrokerSequenceGuard, isMutationMethod, BrokerReplayError } from './broker-replay.js';
import { BrokerStateStore, BrokerStateError } from './broker-state-store.js';

export interface BrokerAuthorizationContext { clientId: string; sessionId: string; projectId: string; }
export type BrokerAuthorize = (request: RuntimeRpcV1Request, context: BrokerAuthorizationContext) => boolean | Promise<boolean>;
/** Closed policy: requests require an explicit canonical authorization policy. */
export const defaultBrokerAuthorize: BrokerAuthorize = () => false;
export interface BrokerServerOptions { projectId: string; rootDir?: string; secret?: Buffer; handler: (request: RuntimeRpcV1Request, context: BrokerAuthorizationContext) => Promise<RuntimeRpcReply> | RuntimeRpcReply; authorize?: BrokerAuthorize; }

function sendErrorAndClose(socket: Socket, code: BrokerErrorCode): void {
  try { sendBrokerMessage(socket, { version: 2, kind: 'error', code } satisfies BrokerErrorMessage); socket.end(); } catch { socket.destroy(); }
}

export class BrokerServer {
  readonly endpoint: BrokerEndpoint; auth: BrokerAuth; private server: Server | undefined; private readonly state: BrokerStateStore; private readonly reads = new BrokerReadIdempotencyCache<RuntimeRpcReply>();
  private readonly sockets = new Set<Socket>();
  private readonly authorize: BrokerAuthorize;
  constructor(private readonly options: BrokerServerOptions) { this.endpoint = brokerEndpoint(options.projectId, options.rootDir); this.auth = createBrokerAuth(options.secret, randomBytes(16).toString('base64url')); this.state = new BrokerStateStore(`${this.endpoint.rootDir}/broker-state.json`); this.authorize = options.authorize ?? defaultBrokerAuthorize; }
  async start(): Promise<void> {
    await ensureOwnerOnlyDirectory(this.endpoint.rootDir);
    const state = await this.state.open();
    this.auth = createBrokerAuth(this.auth.rootSecret, state.epoch);
    await removeStaleEndpoint(this.endpoint);
    this.server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.endpoint.socketPath, () => resolve()); });
    if (process.platform !== 'win32') await chmod(this.endpoint.socketPath, 0o600);
    if (process.platform !== 'win32') await assertOwner(this.endpoint.socketPath);
  }
  async stop(): Promise<void> { const server = this.server; if (!server) return; for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); await new Promise<void>(resolve => server.close(() => resolve())); this.server = undefined; this.auth = createBrokerAuth(this.auth.rootSecret); await removeStaleEndpoint(this.endpoint).catch(() => false); }
  private connection(socket: Socket): void { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); const peer = socket as Socket & { getPeerCredentials?: () => { uid?: number } }; const creds = peer.getPeerCredentials?.(); if (creds?.uid !== undefined && creds.uid !== process.getuid?.()) { sendErrorAndClose(socket, 'unauthorized'); return; } let welcome: ReturnType<typeof issueBrokerWelcome> | undefined; const sequence = new BrokerSequenceGuard();
    readBrokerFrames(socket, message => { void (async () => { try {
      if (!welcome) { if (!isBrokerHello(message)) throw new BrokerError('unsupported_version'); const hello: BrokerHello = message; if (hello.projectId !== this.options.projectId) throw new BrokerError('project_denied'); welcome = issueBrokerWelcome(this.auth, hello); sendBrokerMessage(socket, welcome); return; }
      if (!isBrokerRequest(message) && !isBrokerQuery(message)) throw new BrokerError('invalid_frame'); if (message.projectId !== this.options.projectId) throw new BrokerError('project_denied'); if (message.epoch !== this.auth.epoch) throw new BrokerError('epoch_mismatch');
      sequence.accept(message.sequence); if (isBrokerQuery(message)) { const query = message as BrokerQuery; verifyBrokerToken(this.auth, query.token, { epoch: this.auth.epoch, clientId: welcome.clientId, sessionId: welcome.sessionId, projectId: this.options.projectId, capability: 'runtime:status' }); if (!(await this.authorize({ version: 1, requestId: query.query.requestId, method: 'status', params: { runId: 'runtime_query' } }, { clientId: welcome.clientId, sessionId: welcome.sessionId, projectId: this.options.projectId }))) throw new BrokerError('scope_denied'); const receipt = await this.state.getReceiptReadOnly(welcome.clientId, query.query.requestId); sendBrokerMessage(socket, { version: 2, kind: 'queryResponse', sequence: query.sequence, ...(receipt === undefined ? {} : { receipt }) }); return; } const request: BrokerRequest = message; const mutationKey = `${welcome.clientId}:${request.request.requestId}`; const capability = capabilityForMethod(request.request.method); verifyBrokerToken(this.auth, request.token, { epoch: this.auth.epoch, clientId: welcome.clientId, sessionId: welcome.sessionId, projectId: this.options.projectId, capability }); const valid = validateRequest(request.request); if (!valid.ok || !(await this.authorize(valid.value, { clientId: welcome.clientId, sessionId: welcome.sessionId, projectId: this.options.projectId }))) throw new BrokerError('scope_denied'); if (isMutationMethod(request.request.method)) { try { await this.state.claimMutation(mutationKey); } catch (error) { if (error instanceof BrokerStateError && error.code === 'duplicate_mutation') throw new BrokerError('duplicate_mutation'); throw error; } } const cached = !isMutationMethod(request.request.method) ? this.reads.get(mutationKey) : undefined; if (cached) { sendBrokerMessage(socket, { version: 2, kind: 'response', sequence: request.sequence, reply: cached } satisfies BrokerResponse); return; } const reply = await this.options.handler(valid.value, { clientId: welcome.clientId, sessionId: welcome.sessionId, projectId: this.options.projectId }); if (socket.destroyed || !this.server) return; if (!validateReply(reply, request.request.requestId, request.request.method).ok) throw new BrokerError('invalid_frame'); if (!isMutationMethod(request.request.method)) this.reads.set(mutationKey, reply);
      if (request.request.method === 'start' && reply.success && typeof reply.data === 'object' && reply.data !== null) { const runId = (reply.data as { runId?: unknown }).runId; if (typeof runId === 'string') await this.state.recordJobSubmission({ jobId: runId, clientId: welcome.clientId, requestId: request.request.requestId, submittedAt: Date.now() }); }
      sendBrokerMessage(socket, { version: 2, kind: 'response', sequence: request.sequence, reply } satisfies BrokerResponse);
    } catch (error) { if (!socket.destroyed && this.server) sendErrorAndClose(socket, error instanceof BrokerError ? error.code : error instanceof BrokerReplayError ? (error.code === 'duplicate_mutation' ? 'duplicate_mutation' : 'sequence_replay') : (error instanceof BrokerStateError && error.code === 'duplicate_mutation') ? 'duplicate_mutation' : 'invalid_frame'); } })(); }, error => sendErrorAndClose(socket, error.code)); }
}
