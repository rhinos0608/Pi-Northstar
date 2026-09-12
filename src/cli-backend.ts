import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from './backend.js';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from './web-access-content-store.js';
import {
  parseWebAccessFetchRequest,
  WebAccessContractError,
  type WebAccessContentStore,
  type WebAccessQueryResult,
} from './web-access-contract.js';
import { retrieveWebAccessCorpus } from './web-access-retrieve.js';
import { runWebAccessCachedSourceCheck } from './web-access-cached-source-check.js';
import { formatWebAccessSourceCheck } from './web-access-presentation.js';
import { textResult } from './tool-output.js';
import { getProcessLocalBridgeToken } from './chrome-profile-adapter.js';

interface CliEnvelope {
  ok: boolean;
  data?: BackendCallResult;
  error?: {
    code: string;
    message: string;
  };
}

const TSX_LOADER_URL = import.meta.resolve('tsx');
const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;

function cliAbortError(): Error {
  const error = new Error('CLI backend aborted');
  error.name = 'AbortError';
  return error;
}

export class CliSearchBackend implements SearchBackend {
  private readonly corpus: WebAccessContentStore = createWebAccessContentStore();
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'),
  ) {}

  async callTool(name: string, args: Record<string, unknown>, options: BackendCallOptions = {}): Promise<BackendCallResult> {
    // Parent-side corpus: one-shot children exit per call, so retrieve /
    // source_check through the CLI runtime serve from this store (same
    // 1h / 128-entry / 128MiB bounds, memory-only, no listing).
    if (name === 'fetch' && typeof args.action === 'string') {
      const served = tryServeCliCorpusAction(this.corpus, args);
      if (served !== undefined) return served;
    }
    const envelope = await this.run(['call', name, JSON.stringify(args)], options.signal, options.timeout);
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'CLI backend failed');
    if (!envelope.data) throw new Error('CLI backend returned no data.');
    return populateCliCorpus(this.corpus, name, envelope.data);
  }

  async close(): Promise<void> {}

  private run(args: string[], signal?: AbortSignal, timeout?: number): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cliAbortError());
        return;
      }
      // Forward the process-local bridge token explicitly at spawn time so
      // late-bound bridges reach one-shot children without global env writes.
      const childEnv = buildCliEnvironment(this.env);
      const bridgeToken = getProcessLocalBridgeToken();
      if (bridgeToken !== undefined && childEnv.PI_SEARCH_CHROME_BRIDGE_TOKEN === undefined) {
        childEnv.PI_SEARCH_CHROME_BRIDGE_TOKEN = bridgeToken;
      }
      const child = spawn(process.execPath, ['--import', TSX_LOADER_URL, this.cliPath, ...args], {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let killTimer: NodeJS.Timeout | undefined;

      // Termination is shared, but the reason is tracked separately: only a
      // caller AbortSignal produces AbortError; a wall-clock timeout is a
      // backend failure (timeout error) so callers can retry or fall back.
      const terminate = () => {
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), SIGKILL_AFTER_MS);
      };
      const onAbort = () => {
        aborted = true;
        terminate();
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };
      const timer = timeout
        ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, timeout)
        : undefined;

      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
      });
      child.on('error', (error) => {
        cleanup();
        if (aborted || signal?.aborted) {
          reject(cliAbortError());
          return;
        }
        reject(error);
      });
      child.on('close', (code) => {
        cleanup();
        const output = stdout;
        const diagnostics = stderr.trim();
        if (aborted || signal?.aborted) {
          reject(cliAbortError());
          return;
        }
        if (timedOut) {
          reject(new Error(`CLI backend timed out after ${timeout}ms${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        let parsed: CliEnvelope;
        try {
          parsed = JSON.parse(output) as CliEnvelope;
        } catch (error) {
          reject(new Error(`CLI backend returned invalid JSON: ${String(error)}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        if (code !== 0 && parsed.ok) {
          reject(new Error(`CLI backend exited with code ${code ?? 1}${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        resolve(parsed);
      });
    });
  }
}

export interface CliCorpusHit {
  title: string;
  url: string;
  snippet?: string | undefined;
  backend?: string | undefined;
  source?: string | undefined;
}

/** Parent-side mirror of webSearchCached: stash web_search hits so a later
 *  retrieve / source_check resolves without spawning a child. Best-effort:
 *  returns the result unchanged when there is nothing worth caching. */
export function populateCliCorpus(
  store: WebAccessContentStore,
  name: string,
  result: BackendCallResult,
): BackendCallResult {
  try {
    if (name !== 'web_search') return result;
    const details = (result as { details?: { query?: unknown; results?: Array<CliCorpusHit & { source?: unknown }>; responseId?: unknown } }).details;
    if (!details || typeof details.query !== 'string' || !Array.isArray(details.results) || details.responseId !== undefined) {
      return result;
    }
    const trimmed = details.query.trim();
    if (!trimmed || details.results.length === 0) return result;
    const byProvider = new Map<string, Array<{ title: string; url: string; snippet: string }>>();
    for (const hit of details.results) {
      if (typeof hit.url !== 'string' || !hit.url) continue;
      // Same precedence as webSearchCached in native-tools: backend first, source fallback.
      const backend = typeof hit.backend === 'string' && hit.backend.length > 0 ? hit.backend : undefined;
      const source = typeof hit.source === 'string' && hit.source.length > 0 ? hit.source : undefined;
      const provider = backend ?? source ?? 'parallel';
      const list = byProvider.get(provider) ?? [];
      list.push({ title: typeof hit.title === 'string' ? hit.title : hit.url, url: hit.url, snippet: typeof hit.snippet === 'string' ? hit.snippet : '' });
      byProvider.set(provider, list);
    }
    if (byProvider.size === 0) return result;
    const results: WebAccessQueryResult[] = [...byProvider].map(([provider, hits], index) => ({
      queryIndex: index,
      query: trimmed,
      response: { provider: provider as WebAccessQueryResult extends { response?: { provider: infer P } } ? P : never, results: hits },
    }));
    const entry = buildWebAccessStoredEntry({ queries: [trimmed], results });
    store.put(entry);
    return { ...result, details: { ...details, responseId: entry.responseId } };
  } catch {
    return result;
  }
}

/** Serve cached-corpus fetch actions from the parent store (no child spawn).
 *  Returns undefined when args are not a corpus action; throws Error (never
 *  ContractError) for unknown responseIds, mirroring the in-process route. */
export function tryServeCliCorpusAction(
  store: WebAccessContentStore,
  args: Record<string, unknown>,
): BackendCallResult | undefined {
  const parsed = parseWebAccessFetchRequest(args);
  if (!parsed || typeof (parsed as { action?: string }).action !== 'string') return undefined;
  const kind = (parsed as { action: string }).action;
  try {
    if (kind === 'retrieve') {
      const req = parsed as { responseId: string; sourceIds?: string[]; offset?: number; limit?: number; findText?: string };
      const out = retrieveWebAccessCorpus(store, req);
      return textResult(out.text, { action: 'retrieve', responseId: out.responseId, sources: out.sources, ...(out.matches !== undefined ? { matches: out.matches } : {}), ...(out.nextOffset !== undefined ? { nextOffset: out.nextOffset } : {}) });
    }
    const req = parsed as { responseId: string; claims: string[]; sourceIds?: string[] };
    const artifact = runWebAccessCachedSourceCheck(store, req);
    return textResult(formatWebAccessSourceCheck(artifact as Parameters<typeof formatWebAccessSourceCheck>[0], null), { action: 'source_check', artifact });
  } catch (error) {
    if (error instanceof WebAccessContractError) throw new Error(error.message);
    throw error;
  }
}

export function buildCliEnvironment(env: Record<string, string | undefined>): Record<string, string> {
  const allowed = [
    'PATH',
    'HOME',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'LANG',
    'LC_ALL',
    'PYTHONIOENCODING',
    'GITHUB_TOKEN',
    'SEARCH_BACKEND',
    'PI_SEARCH_BOOTSTRAP',
    'PI_SEARCH_ALLOW_INSTALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'REDDIT_COOKIE',
    'OPENCLI_HOST',
    'OPENCLI_PORT',
    'OPENCLI_TOKEN',
    'BRAVE_API_KEY',
    'EXA_API_KEY',
    'TAVILY_API_KEY',
    'TAVILY_RESEARCH_MODEL',
    'PARALLEL_API_KEY',
    'TINYFISH_API_KEY',
    'QUERIT_API_KEY',
    'VALYU_API_KEY',
    'BOCHA_API_KEY',
    'XCRAWL_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'BRIGHTDATA_API_KEY',
    'BRIGHTDATA_SERP_ZONE',
    'SERPAPI_KEY',
    'SERPER_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'CODEX_ACCOUNT_ID',
    'CODEX_HOME',
    'REDDIT_CLIENT_ID',
    'REDDIT_CLIENT_SECRET',
    'REDDIT_USER_AGENT',
    'YOUTUBE_API_KEY',
    'SEARXNG_BASE_URL',
    'NITTER_BASE_URL',
    'LISTENNOTES_API_KEY',
    'PRODUCTHUNT_API_TOKEN',
    'PATENTSVIEW_API_KEY',
    // Optional research API keys (Pi conventions; forwarded only when set).
    'SEMANTIC_SCHOLAR_API_KEY',
    'OPENALEX_API_KEY',
    'NCBI_API_KEY',
    'NCBI_EMAIL',
    'STACKEXCHANGE_KEY',
    'CRAWL4AI_BASE_URL',
    'CRAWL4AI_API_TOKEN',
    'DEEP_RESEARCH_BASE_URL',
    'DEEP_RESEARCH_WORKER_BASE_URL',
    'DEEP_RESEARCH_API_TOKEN',
    'DEEP_RESEARCH_MODEL',
    'DEEP_RESEARCH_WORKER_MODEL',
    'FIRECRAWL_API_KEY',
    'JINA_API_KEY',
    'PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS',
    'PI_SEARCH_WEB_AGENT_TIMEOUT_MS',
    'PI_SEARCH_NATIVE_SUMMARIES',
    'PI_SEARCH_NATIVE_ANSWERS',
    'PI_SEARCH_KG_ENRICHMENT',
    'PI_SEARCH_EXTERNAL_FETCH',
    'PI_SEARCH_FETCH_BACKENDS',
    'PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS',
    'DIFFBOT_TOKEN',
    'DIFFBOT_SEARCH_SIZE',
    'DIFFBOT_ENHANCE_SIZE',
    'DIFFBOT_NLP_MAX_CHARS',
    'DIFFBOT_MAX_PROVIDERS',
    'DIFFBOT_FALLBACK_BUDGET',
    'EMBEDDING_SIDECAR_PROVIDER',
    'EMBEDDING_SIDECAR_BASE_URL',
    'EMBEDDING_SIDECAR_API_TOKEN',
    'EMBEDDING_SIDECAR_DIMENSIONS',
    'EMBEDDING_SIDECAR_CODE_MODEL',
    'SEARCH_LLM_PROVIDER',
    'SEARCH_LLM_API_TOKEN',
    'SEARCH_LLM_BASE_URL',
    'OLLAMA_SEARCH_BASE_URL',
    'OLLAMA_SEARCH_API_KEY',
    'SEARCH_OLLAMA_BASE_URL',
    'SEARCH_OLLAMA_API_KEY',
    'BROWSER_EXECUTABLE_PATH',
    'BROWSER_PROXY_SERVER',
    'BROWSER_CDP_ENDPOINT',
    'BROWSER_PROFILE_DIR',
    'SEARCH_MCP_CONFIG_PATH',
    'TWITTER_BACKEND',
    'PI_SEARCH_TWITTER_BACKEND',
    'REDDIT_BACKEND',
    'PI_SEARCH_REDDIT_BACKEND',
    'XIAOHONGSHU_BACKEND',
    'PI_SEARCH_XIAOHONGSHU_BACKEND',
    'FACEBOOK_BACKEND',
    'PI_SEARCH_FACEBOOK_BACKEND',
    'INSTAGRAM_BACKEND',
    'PI_SEARCH_INSTAGRAM_BACKEND',
    'YOUTUBE_BACKEND',
    'PI_SEARCH_YOUTUBE_BACKEND',
    'BILIBILI_BACKEND',
    'PI_SEARCH_BILIBILI_BACKEND',
    'PI_SEARCH_BROWSER_AUTOMATION',
    'PI_SEARCH_ENV_PATH',
    'PI_SEARCH_AUTO_INSTALL',
    'PI_SEARCH_COOKIE_BROWSER',
    'PI_SEARCH_COOKIE_STALE_MS',
    'PI_SEARCH_STATE_DIR',
    'PI_SEARCH_CHROME_BRIDGE_TOKEN',
    'PI_SEARCH_SCRAPLING_PROXY',
    'PI_SEARCH_EMBEDDING_ENABLED',
    'PI_SEARCH_EMBEDDING_MODEL',
    'PI_SEARCH_EMBEDDING_DIMENSIONS',
    'PI_SEARCH_SCRAPLING_ENABLED',
    'PI_SEARCH_SCRAPLING_PYTHON_PATH',
    'PI_SEARCH_WEB_BACKENDS',
    'PI_SEARCH_EMBEDDING_PORT',
    'SIDER_DEVICE',
  ];
  return Object.fromEntries(
    allowed.flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key]]] : [])),
  );
}
