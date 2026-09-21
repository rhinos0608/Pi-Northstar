export const COMMAND_RESULT_SCHEMA = 'northstar.command-result.v1' as const;
export const COMMAND_RESULT_VERSION = 1 as const;
export const COMMAND_OUTCOMES = ['success', 'empty', 'partial', 'degraded', 'failed', 'cancelled', 'suppressed', 'stale', 'outcome_unknown'] as const;
export type CommandOutcome = (typeof COMMAND_OUTCOMES)[number];
export type TrustClassification = 'internal' | 'external' | 'mixed' | 'unknown';
export type Retryability = 'retryable' | 'not_retryable' | 'unknown';
export type CommandSurface = 'cli' | 'pi' | 'skill' | 'workflow' | 'native_tool' | 'internal' | string;
export interface CommandError { code: string; message: string; retryable: boolean; category?: string }
export interface CommandSource { kind: 'internal' | 'external'; name: string; locator?: string }
export interface CommandSideEffect { started: boolean; settled?: boolean; outcome?: 'committed' | 'rolled_back' | 'unknown' | 'not_started' }
export interface CommandNextAction { kind: string; command?: string; reason?: string }
export interface NorthstarCommandResultV1<T = unknown> { schema: typeof COMMAND_RESULT_SCHEMA; version: typeof COMMAND_RESULT_VERSION; commandId: string; invocationId: string; outcome: CommandOutcome; retryability: Retryability; data: T; sources: readonly CommandSource[]; trust: TrustClassification; requestedSurface: CommandSurface; resolvedSurface: CommandSurface; attemptedSurfaces: readonly CommandSurface[]; sideEffect: CommandSideEffect; verifiedArtifacts: readonly string[]; nextActions: readonly CommandNextAction[]; error?: CommandError }

const OUTCOME_SET = new Set<string>(COMMAND_OUTCOMES);
const TRUST_SET = new Set<string>(['internal', 'external', 'mixed', 'unknown']);
const RETRY_SET = new Set<string>(['retryable', 'not_retryable', 'unknown']);
const SURFACES = new Set(['cli', 'pi', 'skill', 'workflow', 'native_tool', 'internal']);
const SOURCE_KINDS = new Set(['internal', 'external']);
const SIDE_EFFECT_OUTCOMES = new Set(['committed', 'rolled_back', 'unknown', 'not_started']);
export const COMMAND_RESULT_MAX_DATA_DEPTH = 32;
export const COMMAND_RESULT_MAX_DATA_NODES = 10_000;
export const COMMAND_RESULT_MAX_DATA_BYTES = 256 * 1024;
export const COMMAND_RESULT_MAX_RENDERED_BYTES = 512 * 1024;
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 256;
type SnapshotState = { nodes: number; strings: number; stringBytes: number };
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function snapshot(value: unknown, path: string, state: SnapshotState, depth = 0): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
    if (typeof value === 'string') { if (value.length > MAX_STRING_LENGTH) throw new TypeError(`${path} exceeds maximum string length`); state.strings++; state.stringBytes += value.length; }
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`${path} contains unsupported value`);
  if (depth > COMMAND_RESULT_MAX_DATA_DEPTH) throw new TypeError(`${path} exceeds maximum depth`);
  state.nodes++; if (state.nodes > COMMAND_RESULT_MAX_DATA_NODES) throw new TypeError(`data exceeds maximum node count (${COMMAND_RESULT_MAX_DATA_NODES})`);
  let prototype: object | null; let keys: string[];
  try { prototype = Object.getPrototypeOf(value); keys = Object.keys(value); } catch { throw new TypeError(`${path} is not safely inspectable`); }
  if (Array.isArray(value)) {
    if (keys.length !== value.length || value.length > MAX_ARRAY_LENGTH) throw new TypeError(`${path} exceeds maximum array size`);
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !('value' in descriptor)) throw new TypeError(`${path}[${index}] is accessor-backed`); output.push(snapshot(descriptor.value, `${path}[${index}]`, state, depth + 1)); }
    return output;
  }
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} contains unsupported object`);
  if (keys.length > MAX_OBJECT_KEYS) throw new TypeError(`${path} exceeds maximum key count`);
  const output: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !('value' in descriptor)) throw new TypeError(`${path}.${key} is accessor-backed`); output[key] = snapshot(descriptor.value, `${path}.${key}`, state, depth + 1); }
  return output;
}
function knownKeys(value: Record<string, unknown>, keys: readonly string[], path: string, issues: string[]): void { const allowed = new Set(keys); for (const key of Object.keys(value)) if (!allowed.has(key)) issues.push(`${path}.${key} is unsupported`); }
function boundedString(value: unknown, path: string, issues: string[], required = false): value is string { if (typeof value !== 'string' || (required && value.trim() === '')) { issues.push(`${path} is invalid`); return false; } if (value.length > MAX_STRING_LENGTH) issues.push(`${path} exceeds maximum string length`); return true; }
function validSurface(value: unknown): value is CommandSurface { return boundedString(value, 'surface', []) && (SURFACES.has(value) || /^[a-z][a-z0-9_.-]{0,63}$/.test(value)); }
function validateJsonData(value: unknown, issues: string[]): SnapshotState { const state: SnapshotState = { nodes: 0, strings: 0, stringBytes: 0 }; try { const copied = snapshot(value, 'data', state); const serialized = JSON.stringify(copied); if (serialized === undefined) issues.push('data is not JSON serializable'); else if (new TextEncoder().encode(serialized).byteLength > COMMAND_RESULT_MAX_DATA_BYTES) issues.push(`data exceeds maximum serialized bytes (${COMMAND_RESULT_MAX_DATA_BYTES})`); } catch (error) { issues.push(error instanceof Error ? error.message : 'data is not safely inspectable'); } return state; }
export interface CommandResultValidation { ok: boolean; result?: NorthstarCommandResultV1; issues: string[] }
export function validateCommandResult(value: unknown): CommandResultValidation {
  const issues: string[] = []; let row: Record<string, unknown>;
  try { const copied = snapshot(value, 'result', { nodes: 0, strings: 0, stringBytes: 0 }); if (!record(copied)) return { ok: false, issues: ['result must be an object'] }; row = copied; } catch (error) { return { ok: false, issues: [error instanceof Error ? error.message : 'result is not safely inspectable'] }; }
  knownKeys(row, ['schema','version','commandId','invocationId','outcome','retryability','data','sources','trust','requestedSurface','resolvedSurface','attemptedSurfaces','sideEffect','verifiedArtifacts','nextActions','error'], 'result', issues);
  if (row.schema !== COMMAND_RESULT_SCHEMA) issues.push('schema is invalid'); if (row.version !== COMMAND_RESULT_VERSION) issues.push('version is invalid');
  validateJsonData(row.data, issues);
  boundedString(row.commandId, 'commandId', issues, true); boundedString(row.invocationId, 'invocationId', issues, true);
  if (typeof row.outcome !== 'string' || !OUTCOME_SET.has(row.outcome)) issues.push('outcome is invalid'); if (typeof row.retryability !== 'string' || !RETRY_SET.has(row.retryability)) issues.push('retryability is invalid'); if (typeof row.trust !== 'string' || !TRUST_SET.has(row.trust)) issues.push('trust is invalid');
  if (!validSurface(row.requestedSurface) || !validSurface(row.resolvedSurface)) issues.push('surface is invalid');
  if (!Array.isArray(row.attemptedSurfaces) || row.attemptedSurfaces.length > MAX_ARRAY_LENGTH || row.attemptedSurfaces.some((item) => !validSurface(item))) issues.push('attemptedSurfaces is invalid');
  if (!Array.isArray(row.sources) || row.sources.length > MAX_ARRAY_LENGTH) issues.push('sources must be a bounded array'); else row.sources.forEach((source, index) => { if (!record(source)) { issues.push(`sources[${index}] must be an object`); return; } knownKeys(source, ['kind','name','locator'], `sources[${index}]`, issues); if (typeof source.kind !== 'string' || !SOURCE_KINDS.has(source.kind)) issues.push(`sources[${index}].kind is invalid`); boundedString(source.name, `sources[${index}].name`, issues, true); if (source.locator !== undefined) boundedString(source.locator, `sources[${index}].locator`, issues, true); });
  if (!record(row.sideEffect)) issues.push('sideEffect must be an object'); else { knownKeys(row.sideEffect, ['started','settled','outcome'], 'sideEffect', issues); if (typeof row.sideEffect.started !== 'boolean') issues.push('sideEffect.started is invalid'); if (row.sideEffect.settled !== undefined && typeof row.sideEffect.settled !== 'boolean') issues.push('sideEffect.settled is invalid'); if (row.sideEffect.outcome !== undefined && (typeof row.sideEffect.outcome !== 'string' || !SIDE_EFFECT_OUTCOMES.has(row.sideEffect.outcome))) issues.push('sideEffect.outcome is invalid'); }
  if (!Array.isArray(row.verifiedArtifacts) || row.verifiedArtifacts.length > MAX_ARRAY_LENGTH || row.verifiedArtifacts.some((item) => !boundedString(item, 'verifiedArtifacts', issues, true))) issues.push('verifiedArtifacts is invalid');
  if (!Array.isArray(row.nextActions) || row.nextActions.length > MAX_ARRAY_LENGTH) issues.push('nextActions must be a bounded array'); else row.nextActions.forEach((action, index) => { if (!record(action)) { issues.push(`nextActions[${index}] must be an object`); return; } knownKeys(action, ['kind','command','reason'], `nextActions[${index}]`, issues); boundedString(action.kind, `nextActions[${index}].kind`, issues, true); for (const field of ['command','reason'] as const) if (action[field] !== undefined) boundedString(action[field], `nextActions[${index}].${field}`, issues, true); });
  if (row.error !== undefined) { if (!record(row.error)) issues.push('error must be an object'); else { knownKeys(row.error, ['code','message','retryable','category'], 'error', issues); boundedString(row.error.code, 'error.code', issues, true); boundedString(row.error.message, 'error.message', issues, true); if (typeof row.error.retryable !== 'boolean') issues.push('error.retryable is invalid'); if (row.error.category !== undefined) boundedString(row.error.category, 'error.category', issues, true); } }
  try {
    JSON.stringify(row);
  } catch {
    issues.push('result is not JSON serializable');
  }
  return issues.length === 0 ? { ok: true, result: row as unknown as NorthstarCommandResultV1, issues } : { ok: false, issues };
}
export function parseCommandResult(value: unknown): NorthstarCommandResultV1 { const validation = validateCommandResult(value); if (!validation.ok) throw new TypeError(`Invalid command result: ${validation.issues.join('; ')}`); return validation.result!; }
export function commandResultJson(result: NorthstarCommandResultV1): string {
  const output = JSON.stringify(parseCommandResult(result));
  if (new TextEncoder().encode(output).byteLength > COMMAND_RESULT_MAX_RENDERED_BYTES) throw new Error('rendered command result exceeds maximum bytes');
  return output;
}
