import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SEARCH_MCP_CONFIG_PATH = '';
export const DEFAULT_ENV_PATH = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env');

type JsonObject = Record<string, unknown>;

const mappings: Array<[string, string]> = [
  ['brave.apiKey', 'BRAVE_API_KEY'],
  ['exa.apiKey', 'EXA_API_KEY'],
  ['tavily.apiKey', 'TAVILY_API_KEY'],
  ['github.token', 'GITHUB_TOKEN'],
  ['reddit.clientId', 'REDDIT_CLIENT_ID'],
  ['reddit.clientSecret', 'REDDIT_CLIENT_SECRET'],
  ['reddit.userAgent', 'REDDIT_USER_AGENT'],
  ['youtube.apiKey', 'YOUTUBE_API_KEY'],
  ['searxng.baseUrl', 'SEARXNG_BASE_URL'],
  ['nitter.baseUrl', 'NITTER_BASE_URL'],
  ['listennotes.apiKey', 'LISTENNOTES_API_KEY'],
  ['producthunt.apiToken', 'PRODUCTHUNT_API_TOKEN'],
  ['patentsview.apiKey', 'PATENTSVIEW_API_KEY'],
  // Optional research API keys (Pi conventions, not vendor-standard names).
  // All are optional; research sources work unauthenticated with lower quotas.
  ['semanticScholar.apiKey', 'SEMANTIC_SCHOLAR_API_KEY'],
  ['openalex.apiKey', 'OPENALEX_API_KEY'],
  ['ncbi.apiKey', 'NCBI_API_KEY'],
  ['ncbi.email', 'NCBI_EMAIL'],
  ['stackexchange.key', 'STACKEXCHANGE_KEY'],
  ['crawl4ai.baseUrl', 'CRAWL4AI_BASE_URL'],
  ['crawl4ai.apiToken', 'CRAWL4AI_API_TOKEN'],
  ['deepResearch.baseUrl', 'DEEP_RESEARCH_BASE_URL'],
  ['deepResearch.workerBaseUrl', 'DEEP_RESEARCH_WORKER_BASE_URL'],
  ['deepResearch.apiToken', 'DEEP_RESEARCH_API_TOKEN'],
  ['deepResearch.model', 'DEEP_RESEARCH_MODEL'],
  ['deepResearch.workerModel', 'DEEP_RESEARCH_WORKER_MODEL'],
  ['embeddingSidecar.provider', 'EMBEDDING_SIDECAR_PROVIDER'],
  ['embeddingSidecar.baseUrl', 'EMBEDDING_SIDECAR_BASE_URL'],
  ['embeddingSidecar.apiToken', 'EMBEDDING_SIDECAR_API_TOKEN'],
  ['embeddingSidecar.dimensions', 'EMBEDDING_SIDECAR_DIMENSIONS'],
  ['embeddingSidecar.codeModel', 'EMBEDDING_SIDECAR_CODE_MODEL'],
  ['llm.provider', 'SEARCH_LLM_PROVIDER'],
  ['llm.apiToken', 'SEARCH_LLM_API_TOKEN'],
  ['llm.baseUrl', 'SEARCH_LLM_BASE_URL'],
  ['ollamaSearch.baseUrl', 'OLLAMA_SEARCH_BASE_URL'],
  ['ollamaSearch.apiKey', 'OLLAMA_SEARCH_API_KEY'],
  ['browser.executablePath', 'BROWSER_EXECUTABLE_PATH'],
  ['browser.proxyServer', 'BROWSER_PROXY_SERVER'],
  ['browser.cdpEndpoint', 'BROWSER_CDP_ENDPOINT'],
  ['browser.profileDir', 'BROWSER_PROFILE_DIR'],
  ['scrapling.proxy', 'PI_SEARCH_SCRAPLING_PROXY'],
  ['embedding.enabled', 'PI_SEARCH_EMBEDDING_ENABLED'],
  ['embedding.model', 'PI_SEARCH_EMBEDDING_MODEL'],
  ['embedding.dimensions', 'PI_SEARCH_EMBEDDING_DIMENSIONS'],
  ['embedding.port', 'PI_SEARCH_EMBEDDING_PORT'],
  ['sidecar.device', 'SIDER_DEVICE'],
];

export function loadSearchMcpEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const envFile = readEnvFile(env.PI_SEARCH_ENV_PATH ?? DEFAULT_ENV_PATH);
  const base = { ...envFile, ...env };
  const configPath = base.SEARCH_MCP_CONFIG_PATH?.trim() || DEFAULT_SEARCH_MCP_CONFIG_PATH;
  const config = readJsonConfig(configPath);
  if (!config) return base;

  const merged: Record<string, string | undefined> = { ...base, SEARCH_MCP_CONFIG_PATH: configPath };
  for (const [path, key] of mappings) {
    if (merged[key]) continue;
    const value = valueAtPath(config, path);
    if (isUsableScalar(value)) merged[key] = String(value);
  }
  return merged;
}

export function loadedConfigSummary(env: Record<string, string | undefined>): { path: string; loaded: boolean; mappedKeys: string[] } {
  const envFile = readEnvFile(env.PI_SEARCH_ENV_PATH ?? DEFAULT_ENV_PATH);
  const base = { ...envFile, ...env };
  const configPath = base.SEARCH_MCP_CONFIG_PATH?.trim() || DEFAULT_SEARCH_MCP_CONFIG_PATH;
  const config = readJsonConfig(configPath);
  if (!config) return { path: configPath, loaded: false, mappedKeys: [] };
  return {
    path: configPath,
    loaded: true,
    mappedKeys: mappings.flatMap(([path, key]) => (isUsableScalar(valueAtPath(config, path)) ? [key] : [])),
  };
}

function readEnvFile(path: string | undefined): Record<string, string> {
  if (!path || !existsSync(path)) return {};
  const parsed: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    if (key && value !== undefined) parsed[key] = unquoteEnvValue(value);
  }
  return parsed;
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readJsonConfig(path: string): JsonObject | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as JsonObject;
  } catch {
    return undefined;
  }
}

function valueAtPath(root: JsonObject, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    return (current as JsonObject)[segment];
  }, root);
}

function isUsableScalar(value: unknown): value is string | number | boolean {
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase();
    return trimmed.length > 0 && trimmed !== 'null' && trimmed !== 'undefined';
  }
  return typeof value === 'number' || typeof value === 'boolean';
}
