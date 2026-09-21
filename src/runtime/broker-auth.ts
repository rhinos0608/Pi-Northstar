import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BrokerError } from './broker-errors.js';
import { BROKER_TOKEN_TTL_MS, type BrokerCapability, type BrokerWelcome } from './broker-protocol.js';

export interface BrokerAuth { epoch: string; rootSecret: Buffer; }
interface TokenClaims { epoch: string; clientId: string; sessionId: string; projectId: string; capabilities: BrokerCapability[]; expiresAt: number; nonce: string; }
export function createBrokerAuth(rootSecret?: Buffer, epoch = randomBytes(16).toString('base64url')): BrokerAuth { const secret = rootSecret ?? randomBytes(32); if (secret.length < 32) throw new BrokerError('unauthorized'); return { rootSecret: Buffer.from(secret), epoch }; }
function sign(auth: BrokerAuth, claims: TokenClaims): string { const body = Buffer.from(JSON.stringify(claims)).toString('base64url'); return `${body}.${createHmac('sha256', auth.rootSecret).update(body).digest('base64url')}`; }
function verifySignature(auth: BrokerAuth, token: string): TokenClaims {
  const [body, signature] = token.split('.'); if (!body || !signature) throw new BrokerError('unauthorized');
  const expected = createHmac('sha256', auth.rootSecret).update(body).digest(); const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new BrokerError('unauthorized');
  try { const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as TokenClaims; if (!claims || typeof claims !== 'object') throw new Error(); return claims; } catch { throw new BrokerError('unauthorized'); }
}
export function issueBrokerWelcome(auth: BrokerAuth, hello: { clientId: string; projectId: string; requestedCapabilities: BrokerCapability[] }): BrokerWelcome {
  const capabilities = [...new Set(hello.requestedCapabilities)]; const sessionId = randomBytes(16).toString('base64url'); const expiresAt = Date.now() + BROKER_TOKEN_TTL_MS;
  const token = sign(auth, { epoch: auth.epoch, clientId: hello.clientId, sessionId, projectId: hello.projectId, capabilities, expiresAt, nonce: randomBytes(16).toString('base64url') });
  return { version: 2, kind: 'welcome', epoch: auth.epoch, clientId: hello.clientId, sessionId, token, expiresAt, capabilities, projectId: hello.projectId };
}
export function verifyBrokerToken(auth: BrokerAuth, token: string, expected: { epoch: string; clientId: string; sessionId: string; projectId: string; capability: BrokerCapability }): void {
  const claims = verifySignature(auth, token); if (claims.epoch !== auth.epoch || claims.epoch !== expected.epoch) throw new BrokerError('epoch_mismatch');
  if (claims.clientId !== expected.clientId || claims.sessionId !== expected.sessionId) throw new BrokerError('unauthorized');
  if (claims.projectId !== expected.projectId) throw new BrokerError('project_denied'); if (claims.expiresAt <= Date.now()) throw new BrokerError('expired_token');
  if (!claims.capabilities.includes(expected.capability)) throw new BrokerError('scope_denied');
}
