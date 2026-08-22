/**
 * Codex/ChatGPT standalone web search provider.
 *
 * Uses the OpenAI Codex CLI's ChatGPT web-search endpoint. The endpoint is
 * undocumented and reverse-engineered from the Codex CLI behavior — it may
 * change or stop working at any time, access may be limited by account
 * eligibility and usage limits, and usage may be subject to OpenAI/ChatGPT
 * terms. This is a best-effort integration and is NOT an official OpenAI
 * integration.
 *
 * Credentials are discovered without exposing the token:
 *  - `CODEX_ACCESS_TOKEN` env var (non-empty) wins, with optional
 *    `CODEX_ACCOUNT_ID`;
 *  - otherwise `${CODEX_HOME || ~/.codex}/auth.json` is read, extracting only
 *    `tokens.access_token` (and optional `tokens.account_id`).
 * Malformed, missing, or unusable sources mean "unconfigured". The token,
 * auth file contents, paths, and raw credential errors are never returned or
 * logged.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fetchInit, safeResponseJson } from './http.js';

export const CODEX_SEARCH_URL = 'https://chatgpt.com/backend-api/codex/alpha/search';
const CODEX_MODEL = 'gpt-4o';
const USER_AGENT = 'pi-northstar/0.3.0';
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export interface CodexCredentials {
  accessToken: string;
  accountId?: string;
}

export interface CodexSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Credential discovery. Env vars win; otherwise the Codex auth file
 * (`${CODEX_HOME || ~/.codex}/auth.json`) is consulted. Returns undefined when
 * unconfigured. Never exposes the token to callers beyond the returned value.
 */
export function readCodexCredentials(env: Record<string, string | undefined>): CodexCredentials | undefined {
  const envToken = env.CODEX_ACCESS_TOKEN;
  if (typeof envToken === 'string' && envToken.trim()) {
    const credentials: CodexCredentials = { accessToken: envToken.trim() };
    const envAccountId = env.CODEX_ACCOUNT_ID;
    if (typeof envAccountId === 'string' && envAccountId.trim()) credentials.accountId = envAccountId.trim();
    return credentials;
  }

  const codexHome = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim()
    ? env.CODEX_HOME
    : join(homedir(), '.codex');
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf8'));
  } catch {
    // Missing or malformed file means unconfigured. Credential errors are never surfaced.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const tokens = (parsed as Record<string, unknown>).tokens;
  if (typeof tokens !== 'object' || tokens === null) return undefined;
  const accessToken = (tokens as Record<string, unknown>).access_token;
  if (typeof accessToken !== 'string' || !accessToken.trim()) return undefined;

  const credentials: CodexCredentials = { accessToken: accessToken.trim() };
  const accountId = (tokens as Record<string, unknown>).account_id;
  if (typeof accountId === 'string' && accountId.trim()) credentials.accountId = accountId.trim();
  return credentials;
}

/** Whether Codex credentials are available (env or auth file). */
export function codexConfigured(env: Record<string, string | undefined>): boolean {
  return readCodexCredentials(env) !== undefined;
}

/**
 * Run a Codex web search. Returns the results mapped to the shared
 * `{ title, url, snippet }` shape with `source` applied by the caller.
 *
 * Fixed endpoint only — no override to avoid token exfiltration to
 * attacker-controlled hosts. Errors carry the HTTP status (so 5xx are
 * retryable and 401/403/429 are not) and never include the response body.
 * Cancellation propagates through the fetch signal.
 */
export async function searchCodex(
  query: string,
  limit: number,
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<CodexSearchResult[]> {
  signal?.throwIfAborted();
  const credentials = readCodexCredentials(env);
  if (!credentials) return [];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (credentials.accountId) headers['ChatGPT-Account-ID'] = credentials.accountId;

  const body = {
    id: randomUUID(),
    model: CODEX_MODEL,
    commands: {
      search_query: [{ q: query }],
    },
  };

  const response = await fetch(CODEX_SEARCH_URL, {
    method: 'POST',
    body: JSON.stringify(body),
    ...fetchInit(headers, signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for Codex search`);

  const data = await safeResponseJson(response, CODEX_SEARCH_URL, DEFAULT_MAX_RESPONSE_BYTES);
  return mapCodexResults(data, limit);
}

/**
 * Validate the external response boundary: only array result objects with a
 * non-empty http/https URL are accepted; title/snippet are trimmed strings.
 */
export function mapCodexResults(data: unknown, limit: number): CodexSearchResult[] {
  if (typeof data !== 'object' || data === null) return [];
  const rawResults = (data as Record<string, unknown>).results;
  if (!Array.isArray(rawResults)) return [];

  const results: CodexSearchResult[] = [];
  for (const item of rawResults) {
    if (results.length >= limit) break;
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.url !== 'string') continue;
    const url = record.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    const snippet = typeof record.snippet === 'string' ? record.snippet.trim() : undefined;
    results.push({ title, url, ...(snippet ? { snippet } : {}) });
  }
  return results;
}