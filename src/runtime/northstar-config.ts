// Northstar operator model/agent selection (operator-owned config).
//
// Threat model (concise): asset = operator-chosen leaf model id + agent
// steering flag. Actors: operator (writes via /northstar slash only), model
// text (must never mutate config), on-disk neighbors (must not read secrets
// — there are none here; auth material stays in ~/.pi/agent/auth.json and is
// never copied into this file). Boundaries: this module owns the
// ~/.pi-northstar/config.json shape, atomic file replacement with 0600/0700
// permissions, and env precedence. Validation mirrors the MODEL_ID shape in
// runtime-rpc-protocol.ts; registry/auth admission happens at the slash
// layer, never here. Status output carries ids and booleans only.

import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const NORTHSTAR_CONFIG_DIR_NAME = '.pi-northstar';
export const NORTHSTAR_CONFIG_FILE_NAME = 'config.json';
export const NORTHSTAR_MODEL_ENV_VAR = 'PI_NORTHSTAR_MODEL';
export const NORTHSTAR_AGENT_STEERING_ENV_VAR = 'PI_NORTHSTAR_AGENT_STEERING';
export const NORTHSTAR_LEAF_MODEL_ENV_VAR = 'PI_NORTHSTAR_LEAF_MODEL';
export const NORTHSTAR_MODEL_ID_MAX_LENGTH = 256;

// Exact mirror of MODEL_ID in runtime-rpc-protocol.ts: exact provider/id,
// no control characters. Kept duplicated (not imported) because the protocol
// constant is module-private.
const NORTHSTAR_MODEL_ID_PATTERN = /^(?![\s\S]*[\x00-\x1f\x7f])[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:+-]+$/;
const NORTHSTAR_THINKING_SUFFIX = /:off$|:minimal$|:low$|:medium$|:high$|:xhigh$|:max$/;

export interface NorthstarFileConfig {
  /** Exact `provider/model` id from operator config. Absent = no override. */
  modelId?: string;
  /** Operator agent-steering preference. Absent = disabled for unified config; legacy leaf env keeps its prior behavior. */
  agentEnabled?: boolean;
}

export interface ResolvedNorthstarModel {
  modelId: string | undefined;
  source: 'env' | 'config' | 'none';
}

export interface ResolvedNorthstarAgent {
  enabled: boolean;
  /** True when PI_NORTHSTAR_AGENT_STEERING=0 forced steering off. */
  forcedOff: boolean;
}

/** Shape check only: exact provider/id, bounded length, no thinking suffix. */
export function isNorthstarModelIdShape(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > NORTHSTAR_MODEL_ID_MAX_LENGTH) return false;
  if (!NORTHSTAR_MODEL_ID_PATTERN.test(value)) return false;
  if (NORTHSTAR_THINKING_SUFFIX.test(value)) return false;
  return true;
}

export function northstarConfigDir(home: string = homedir()): string {
  return join(home, NORTHSTAR_CONFIG_DIR_NAME);
}

export function northstarConfigPath(home: string = homedir()): string {
  return join(northstarConfigDir(home), NORTHSTAR_CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Load operator config. Missing/malformed/invalid files fail closed to defaults. */
export function loadNorthstarConfig(home: string = homedir()): NorthstarFileConfig {
  let parsed: unknown;
  try {
    const path = northstarConfigPath(home);
    if (!existsSync(path)) return {};
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return {};
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: NorthstarFileConfig = {};
  if (isNorthstarModelIdShape(parsed.modelId)) out.modelId = parsed.modelId;
  if (typeof parsed.agentEnabled === 'boolean') out.agentEnabled = parsed.agentEnabled;
  return out;
}

function existingConfigForWrite(target: string): Record<string, unknown> {
  if (!existsSync(target)) return {};
  const stat = lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new TypeError('Northstar config path must be a regular file.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new TypeError('Northstar config is malformed; refusing to overwrite it.');
  }
  if (!isRecord(parsed)) {
    throw new TypeError('Northstar config is malformed; refusing to overwrite it.');
  }
  if ('modelId' in parsed && parsed.modelId !== undefined && !isNorthstarModelIdShape(parsed.modelId)) {
    throw new TypeError('Northstar config contains an invalid modelId; refusing to overwrite it.');
  }
  if ('agentEnabled' in parsed && parsed.agentEnabled !== undefined && typeof parsed.agentEnabled !== 'boolean') {
    throw new TypeError('Northstar config contains an invalid agentEnabled value; refusing to overwrite it.');
  }
  return { ...parsed };
}

/** Atomic file replacement: preserve unknown fields and refuse malformed state. */
export function saveNorthstarConfig(config: NorthstarFileConfig, home: string = homedir()): void {
  if (config.modelId !== undefined && !isNorthstarModelIdShape(config.modelId)) {
    throw new TypeError('modelId must be an exact provider/model id.');
  }
  const dir = northstarConfigDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new TypeError('Northstar config directory must be a real directory.');
  }
  chmodSync(dir, 0o700);
  const target = northstarConfigPath(home);
  const payloadObject = existingConfigForWrite(target);
  delete payloadObject.modelId;
  delete payloadObject.agentEnabled;
  if (config.modelId !== undefined) payloadObject.modelId = config.modelId;
  if (config.agentEnabled !== undefined) payloadObject.agentEnabled = config.agentEnabled;
  const payload = JSON.stringify(payloadObject, null, 2);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, payload, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, target);
  chmodSync(target, 0o600);
}

/** Precedence: PI_NORTHSTAR_MODEL env > config file > none. Env is operator authority. */
export function resolveNorthstarModelId(
  env: Record<string, string | undefined>,
  file: NorthstarFileConfig = loadNorthstarConfig(),
): ResolvedNorthstarModel {
  const fromEnv = env[NORTHSTAR_MODEL_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return isNorthstarModelIdShape(fromEnv)
      ? { modelId: fromEnv, source: 'env' }
      : { modelId: undefined, source: 'env' };
  }
  if (file.modelId !== undefined) return { modelId: file.modelId, source: 'config' };
  return { modelId: undefined, source: 'none' };
}

/**
 * Precedence: PI_NORTHSTAR_AGENT_STEERING=0 forces off > explicit config flag
 * > legacy PI_NORTHSTAR_LEAF_MODEL compatibility. Unified config defaults off
 * until the operator explicitly enables steering.
 */
export function resolveNorthstarAgentEnabled(
  env: Record<string, string | undefined>,
  file: NorthstarFileConfig = loadNorthstarConfig(),
): ResolvedNorthstarAgent {
  if (env[NORTHSTAR_AGENT_STEERING_ENV_VAR]?.trim() === '0') return { enabled: false, forcedOff: true };
  if (typeof file.agentEnabled === 'boolean') return { enabled: file.agentEnabled, forcedOff: false };
  const legacyLeaf = env[NORTHSTAR_LEAF_MODEL_ENV_VAR]?.trim();
  return { enabled: legacyLeaf !== undefined && legacyLeaf !== '', forcedOff: false };
}

/**
 * Unified model id for local broker jobs and adaptive-agent leaf runtime.
 * Single getter so both paths resolve identically: env > config file.
 */
export function getUnifiedModelId(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string | undefined {
  return resolveNorthstarModelId(env).modelId;
}
