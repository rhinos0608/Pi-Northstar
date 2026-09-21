import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from '../backend.js';
import { buildWebAccessStoredEntry, createWebAccessContentStore } from '../web/access/web-access-content-store.js';
import {
  parseWebAccessFetchRequest,
  WebAccessContractError,
  type WebAccessContentStore,
  type WebAccessQueryResult,
} from '../web/access/web-access-contract.js';
import { retrieveWebAccessCorpus } from '../web/access/web-access-retrieve.js';
import { runWebAccessCachedSourceCheck } from '../web/access/web-access-cached-source-check.js';
import { formatWebAccessSourceCheck } from '../web/access/web-access-presentation.js';
import { textResult } from '../core/tool-output.js';
import { getProcessLocalBridgeToken } from '../chrome/chrome-profile-adapter.js';
import { appendUserToolBinsToPath } from '../process/python-child-env.js';

interface CliEnvelope {
  ok: boolean;
  data?: BackendCallResult;
  error?: {
    code: string;
    message: string;
  };
}

const GITHUB_COMMANDS: Readonly<Record<string, string>> = { file: 'github.file', repo: 'github.repo', search: 'github.search', search_repos: 'github.search_repos', issues: 'github.issues', pulls: 'github.pulls', releases: 'github.releases', commits: 'github.commits', tree: 'github.tree', trending: 'github.trending', workflows: 'github.workflows', runs: 'github.runs' };
const RESEARCH_COMMANDS: Readonly<Record<string, string>> = { academic: 'research.search', search: 'research.search', paper: 'research.paper', citations: 'research.citations' };
const SOCIAL_READ_ACTIONS = new Set(['get_post', 'get_thread', 'get_comments', 'get_profile', 'get_community', 'get_feed', 'get_followers', 'get_user_posts', 'get_trending', 'get_community_posts']);
const MEDIA_COMMANDS: Readonly<Record<string, string>> = { details: 'media.details', transcript: 'media.transcript', feed: 'media.feed', search: 'media.search', hot: 'media.hot' };
export function mapCliToolToCommandId(name: string, args: Record<string, unknown>): string {
  const action = typeof args.action === 'string' ? args.action : undefined;
  const commandId = name === 'web_search' ? 'search.web' : name === 'fetch' ? 'fetch.read' : name === 'github' && action ? GITHUB_COMMANDS[action] : name === 'research' && action ? RESEARCH_COMMANDS[action] : name === 'social' && (action === undefined || action === 'search') ? 'social.search' : name === 'social' && action !== undefined && SOCIAL_READ_ACTIONS.has(action) ? 'social.read' : (name === 'video' || name === 'media') && action ? MEDIA_COMMANDS[action] : name === 'feeds' ? 'media.feed' : name === 'kg' && action === 'search' && args.cursor !== undefined && args.providers === undefined ? 'kg.search' : name === 'graph' && (action === 'query' || action === 'probe') ? `graph.${action}` : undefined;
  if (commandId === undefined) throw new Error(`CLI backend does not support tool '${name}' with requested action`);
  return commandId;
}
export function resolveTsxLoader(): string {
  try {
    return import.meta.resolve('tsx');
  } catch {
    throw new Error('source CLI fallback requires dev dependency tsx');
  }
}
export const MAX_CLI_OUTPUT_CHARS = 1_000_000;
const SIGKILL_AFTER_MS = 5_000;

export interface CliStdoutAccumulator {
  text: string;
  truncated: boolean;
}

export function createCliStdoutAccumulator(): CliStdoutAccumulator {
  return { text: '', truncated: false };
}

/** Head-cap append: keep first limit chars, flag overflow, discard rest.
 *  Tail-slicing corrupts JSON envelopes; head-cap fails clean instead. */
export function appendCliStdout(
  state: CliStdoutAccumulator,
  chunk: string,
  limit: number = MAX_CLI_OUTPUT_CHARS,
): boolean {
  if (state.truncated) return true;
  if (state.text.length + chunk.length > limit) {
    state.text += chunk.slice(0, Math.max(0, limit - state.text.length));
    state.truncated = true;
    return true;
  }
  state.text += chunk;
  return false;
}

function cliAbortError(): Error {
  const error = new Error('CLI backend aborted');
  error.name = 'AbortError';
  return error;
}

export class CliSearchBackend implements SearchBackend {
  private readonly corpus: WebAccessContentStore = createWebAccessContentStore();
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cliPath = join(dirname(fileURLToPath(import.meta.url)), fileURLToPath(import.meta.url).endsWith('.js') ? 'worker.js' : 'worker.ts'),
  ) {}

  async callTool(name: string, args: Record<string, unknown>, options: BackendCallOptions = {}): Promise<BackendCallResult> {
    // Parent-side corpus: one-shot children exit per call, so retrieve /
    // source_check through the CLI runtime serve from this store (same
    // 1h / 128-entry / 128MiB bounds, memory-only, no listing).
    if (name === 'fetch' && typeof args.action === 'string') {
      const served = tryServeCliCorpusAction(this.corpus, args);
      if (served !== undefined) return served;
    }
    const commandId = mapCliToolToCommandId(name, args);
    const envelope = await this.run(name, commandId, args, options.signal, options.timeout);
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'CLI backend failed');
    if (!envelope.data) throw new Error('CLI backend returned no data.');
    return populateCliCorpus(this.corpus, name, envelope.data);
  }

  async close(): Promise<void> {}

  private run(toolName: string, commandId: string, args: Record<string, unknown>, signal?: AbortSignal, timeout?: number): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cliAbortError());
        return;
      }
      // Forward the process-local bridge token explicitly at spawn time so
      // late-bound bridges reach related children without global env writes.
      // Scoped like buildCliEnvironment: only tool scopes carrying
      // PI_SEARCH_CHROME_BRIDGE_TOKEN (fetch/browse/reach family) receive it.
      const childEnv = buildCliEnvironment(this.env, toolName);
      const bridgeToken = getProcessLocalBridgeToken();
      if (
        bridgeToken !== undefined &&
        (CLI_TOOL_CREDENTIALS[toolName ?? ''] ?? []).includes('PI_SEARCH_CHROME_BRIDGE_TOKEN') &&
        childEnv.PI_SEARCH_CHROME_BRIDGE_TOKEN === undefined
      ) {
        childEnv.PI_SEARCH_CHROME_BRIDGE_TOKEN = bridgeToken;
      }
      const workerSource = this.cliPath.endsWith('cli.ts') ? this.cliPath.replace(/cli\.ts$/, 'worker.ts') : this.cliPath.endsWith('cli.js') ? this.cliPath.replace(/cli\.js$/, 'worker.js') : this.cliPath;
      if (!existsSync(workerSource)) {
        reject(new Error(`Worker entrypoint not found: ${workerSource}`));
        return;
      }
      let nodeArgs: string[];
      try {
        nodeArgs = workerSource.endsWith('.ts')
          ? ['--import', resolveTsxLoader(), workerSource]
          : [workerSource];
      } catch (err) {
        reject(err);
        return;
      }
      const child = spawn(process.execPath, nodeArgs, {
        env: childEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdin.on('error', () => {});
      child.stdin.write(JSON.stringify({ commandId, args }));
      child.stdin.end();
      const stdoutAcc = createCliStdoutAccumulator();
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
        if (appendCliStdout(stdoutAcc, chunk.toString('utf8'))) terminate();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_CLI_OUTPUT_CHARS);
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
        const output = stdoutAcc.text;
        const diagnostics = stderr.trim();
        if (aborted || signal?.aborted) {
          reject(cliAbortError());
          return;
        }
        if (timedOut) {
          reject(new Error(`CLI backend timed out after ${timeout}ms${diagnostics ? `\n${diagnostics}` : ''}`));
          return;
        }
        if (stdoutAcc.truncated) {
          reject(new Error(`CLI backend response exceeded ${MAX_CLI_OUTPUT_CHARS} chars and was truncated; child terminated for clean failure${diagnostics ? `\n${diagnostics}` : ''}`));
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
 *  returns the result unchanged when there is nothing worth caching.
 *
 *  Always repopulates: the child stamps its own (child-process-local) store
 *  id, which dies with the child and is unresolvable from the parent store.
 *  The parent stores the hits locally and replaces the id so every surfaced
 *  responseId (including ledger suppression pointers) resolves via
 *  tryServeCliCorpusAction. */
export function populateCliCorpus(
  store: WebAccessContentStore,
  name: string,
  result: BackendCallResult,
): BackendCallResult {
  try {
    if (name !== 'web_search') return result;
    const details = (result as { details?: { query?: unknown; results?: Array<CliCorpusHit & { source?: unknown }>; responseId?: unknown } }).details;
    if (!details || typeof details.query !== 'string' || !Array.isArray(details.results)) {
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
  if (typeof args.action !== 'string') return undefined;
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

/** Nonsecret base config forwarded to every one-shot CLI child when set.
 *  Timeouts, feature flags, backend selectors, operator-owned base URLs,
 *  browser paths, and tuning sizes carry no credentials. */
const CLI_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'LANG',
  'LC_ALL',
  'PYTHONIOENCODING',
  'SEARCH_BACKEND',
  'PI_SEARCH_BOOTSTRAP',
  'PI_SEARCH_ALLOW_INSTALL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'TAVILY_RESEARCH_MODEL',
  'SEARXNG_BASE_URL',
  'NITTER_BASE_URL',
  'CRAWL4AI_BASE_URL',
  'DEEP_RESEARCH_BASE_URL',
  'DEEP_RESEARCH_WORKER_BASE_URL',
  'DEEP_RESEARCH_MODEL',
  'DEEP_RESEARCH_WORKER_MODEL',
  'PI_SEARCH_WEB_PROVIDER_TIMEOUT_MS',
  'PI_SEARCH_WEB_AGENT_TIMEOUT_MS',
  'PI_SEARCH_NATIVE_SUMMARIES',
  'PI_SEARCH_NATIVE_ANSWERS',
  'PI_SEARCH_KG_ENRICHMENT',
  'PI_SEARCH_EXTERNAL_FETCH',
  'PI_SEARCH_FETCH_BACKENDS',
  'PI_SEARCH_FETCH_PROVIDER_TIMEOUT_MS',
  'DIFFBOT_SEARCH_SIZE',
  'DIFFBOT_ENHANCE_SIZE',
  'DIFFBOT_NLP_MAX_CHARS',
  'DIFFBOT_MAX_PROVIDERS',
  'DIFFBOT_FALLBACK_BUDGET',
  'EMBEDDING_SIDECAR_PROVIDER',
  'EMBEDDING_SIDECAR_BASE_URL',
  'EMBEDDING_SIDECAR_DIMENSIONS',
  'EMBEDDING_SIDECAR_CODE_MODEL',
  'SEARCH_LLM_PROVIDER',
  'SEARCH_LLM_BASE_URL',
  'OLLAMA_SEARCH_BASE_URL',
  'SEARCH_OLLAMA_BASE_URL',
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
  'PI_SEARCH_EMBEDDING_ENABLED',
  'PI_SEARCH_EMBEDDING_MODEL',
  'PI_SEARCH_EMBEDDING_DIMENSIONS',
  'PI_SEARCH_SCRAPLING_ENABLED',
  'PI_SEARCH_SCRAPLING_PYTHON_PATH',
  'PI_SEARCH_WEB_BACKENDS',
  'PI_SEARCH_EMBEDDING_PORT',
  'SIDECAR_DEVICE',
];

/** Search provider credentials for the web_search child (src/web/providers/*). */
const WEB_SEARCH_CREDENTIALS = [
  'BRAVE_API_KEY',
  'EXA_API_KEY',
  'TAVILY_API_KEY',
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
  'CRAWL4AI_API_TOKEN',
  'DEEP_RESEARCH_API_TOKEN',
  'FIRECRAWL_API_KEY',
  'JINA_API_KEY',
  'DIFFBOT_TOKEN',
  'SEARCH_LLM_API_TOKEN',
  'OLLAMA_SEARCH_API_KEY',
  'SEARCH_OLLAMA_API_KEY',
  'EMBEDDING_SIDECAR_API_TOKEN',
];

/** Page-read credentials for fetch/browse children (native-fetch, page-reader). */
const FETCH_CREDENTIALS = [
  'JINA_API_KEY',
  'FIRECRAWL_API_KEY',
  'CRAWL4AI_API_TOKEN',
  'DIFFBOT_TOKEN',
  'BRIGHTDATA_API_KEY',
  'BRIGHTDATA_SERP_ZONE',
  'PI_SEARCH_CHROME_BRIDGE_TOKEN',
  'PI_SEARCH_SCRAPLING_PROXY',
];

/** Academic API keys for the research child (src/research/*). */
const RESEARCH_CREDENTIALS = [
  'SEMANTIC_SCHOLAR_API_KEY',
  'OPENALEX_API_KEY',
  'NCBI_API_KEY',
  'NCBI_EMAIL',
  'STACKEXCHANGE_KEY',
];

/** Provider presence keys for the canonical social/media-family CLI children
 *  (social, video, feeds, media). Each scoped child checks provider auth across
 *  families, so all four share the same presence keys. Status-only helpers such
 *  as reach_status/reach_setup are not CLI children on this path and resolve to
 *  base config only via the unknown-tool default below. */
const REACH_CREDENTIALS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'REDDIT_COOKIE',
  'REDDIT_CLIENT_ID',
  'REDDIT_CLIENT_SECRET',
  'REDDIT_USER_AGENT',
  'OPENCLI_HOST',
  'OPENCLI_PORT',
  'OPENCLI_TOKEN',
  'YOUTUBE_API_KEY',
  'LISTENNOTES_API_KEY',
  'PRODUCTHUNT_API_TOKEN',
  'PATENTSVIEW_API_KEY',
  'PI_SEARCH_CHROME_BRIDGE_TOKEN',
  ...WEB_SEARCH_CREDENTIALS,
];

/** Per-tool credential scope. Unknown tool names get base config only. */
const CLI_TOOL_CREDENTIALS: Record<string, readonly string[]> = {
  web_search: WEB_SEARCH_CREDENTIALS,
  fetch: FETCH_CREDENTIALS,
  browse: FETCH_CREDENTIALS,
  research: RESEARCH_CREDENTIALS,
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  kg: ['DIFFBOT_TOKEN', 'EMBEDDING_SIDECAR_API_TOKEN'],
  // SPARQL endpoint/token stay out of unrelated children. The graph tool
  // child is the related target: forward env-only operator config so
  // process-env GRAPH_SPARQL_* survives the default CLI boundary.
  graph: ['GRAPH_SPARQL_ENDPOINT', 'GRAPH_SPARQL_TOKEN', 'DIFFBOT_TOKEN'],
  social: REACH_CREDENTIALS,
  video: REACH_CREDENTIALS,
  feeds: REACH_CREDENTIALS,
  media: REACH_CREDENTIALS,
};

export function buildCliEnvironment(env: Record<string, string | undefined>, toolName?: string): Record<string, string> {
  // Deny-by-default: every child gets the nonsecret base config only.
  // Credentials are scoped per tool family below, so a web_search fanout
  // child never carries github/reddit/graph secrets and vice versa.
  const scoped = CLI_TOOL_CREDENTIALS[toolName ?? ''] ?? [];
  const childEnv = Object.fromEntries(
    [...CLI_BASE_ENV_KEYS, ...scoped].flatMap((key) => (typeof env[key] === 'string' ? [[key, env[key]]] : [])),
  );
  const toolPath = appendUserToolBinsToPath(env);
  if (toolPath !== undefined) childEnv.PATH = toolPath;
  return childEnv;
}
