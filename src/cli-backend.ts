import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from './backend.js';

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
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts'),
  ) {}

  async callTool(name: string, args: Record<string, unknown>, options: BackendCallOptions = {}): Promise<BackendCallResult> {
    const envelope = await this.run(['call', name, JSON.stringify(args)], options.signal, options.timeout);
    if (!envelope.ok) throw new Error(envelope.error?.message ?? 'CLI backend failed');
    if (!envelope.data) throw new Error('CLI backend returned no data.');
    return envelope.data;
  }

  async close(): Promise<void> {}

  private run(args: string[], signal?: AbortSignal, timeout?: number): Promise<CliEnvelope> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(cliAbortError());
        return;
      }
      const child = spawn(process.execPath, ['--import', TSX_LOADER_URL, this.cliPath, ...args], {
        env: buildCliEnvironment(this.env),
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
    'NODE_OPTIONS',
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
