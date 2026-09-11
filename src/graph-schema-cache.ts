// Validated 24-hour Diffbot ontology cache. Persisted under
// `~/.pi-northstar/cache/` because Northstar CLI dispatch uses a fresh child
// process per tool call. Atomic temp-write + rename; malformed cache ignored,
// never trusted. Directory/file permissions follow local state conventions
// (0700 dirs, 0600 files).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validateGraphJsonValue } from './graph-contract.js';

export const GRAPH_ONTOLOGY_CACHE_FILENAME = 'diffbot-ontology-v1.json';
export const GRAPH_ONTOLOGY_TTL_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_GRAPH_ONTOLOGY_CACHE_PATH: string = join(homedir(), '.pi-northstar', 'cache', GRAPH_ONTOLOGY_CACHE_FILENAME);

export interface OntologyCachePayload {
  fetchedAt: string;
  ontology: unknown;
}

export type OntologyCacheRead =
  | { ok: true; payload: OntologyCachePayload }
  | { ok: false; malformed: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidCachePayload(value: unknown): value is OntologyCachePayload {
  if (!isRecord(value)) return false;
  if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) return false;
  if (!isRecord(value.ontology) || !isRecord(value.ontology.types)) return false;
  if (!validateGraphJsonValue(value.ontology)) return false;
  return true;
}

/** Freshness TTL: 24 hours. Unparseable/future timestamps are never fresh. */
export function ontologyCacheFresh(fetchedAt: string | undefined, nowMs: number): boolean {
  if (typeof fetchedAt !== 'string') return false;
  const parsed = Date.parse(fetchedAt);
  if (Number.isNaN(parsed)) return false;
  const age = nowMs - parsed;
  return age >= 0 && age <= GRAPH_ONTOLOGY_TTL_MS;
}

export async function readOntologyCacheFile(path: string): Promise<OntologyCacheRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { ok: false, malformed: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, malformed: true };
  }
  if (!isValidCachePayload(parsed)) return { ok: false, malformed: true };
  return { ok: true, payload: parsed };
}

/** Atomic persist: temp-write + rename. Creates parent dirs 0700, file 0600. */
export async function writeOntologyCacheFileAtomic(path: string, payload: OntologyCachePayload): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = join(dirname(path), `.${GRAPH_ONTOLOGY_CACHE_FILENAME}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  await writeFile(staging, JSON.stringify(payload), { mode: 0o600 });
  await rename(staging, path);
}
