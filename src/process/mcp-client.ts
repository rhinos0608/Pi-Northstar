import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BackendCallOptions, BackendCallResult, SearchBackend } from '../backend.js';

export const DEFAULT_SEARCH_MCP_COMMAND = 'search-mcp';

export type SearchMcpEnvironment = Record<string, string | undefined>;

export type SearchMcpCallOptions = BackendCallOptions;
export type SearchMcpCallResult = BackendCallResult;

export function buildServerParameters(env: SearchMcpEnvironment): StdioServerParameters {
  const command = env.SEARCH_MCP_COMMAND?.trim() || DEFAULT_SEARCH_MCP_COMMAND;
  const args = parseArgs(env.SEARCH_MCP_ARGS_JSON);
  const processEnv = toProcessEnvironment(env);
  const cwd = env.SEARCH_MCP_CWD?.trim();

  return {
    command,
    args,
    env: processEnv,
    stderr: 'pipe',
    ...(cwd ? { cwd } : {}),
  };
}

const MAX_STDERR_BYTES = 4096;

export class SearchMcpClient implements SearchBackend {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;
  private stderrTail = '';

  constructor(private readonly serverParameters: StdioServerParameters) {}

  async callTool(name: string, args: Record<string, unknown>, options: SearchMcpCallOptions = {}): Promise<SearchMcpCallResult> {
    const client = await this.connect();
    try {
      return await client.callTool(
        { name, arguments: args },
        undefined,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: options.timeout ?? 120_000,
          resetTimeoutOnProgress: true,
        },
      );
    } catch (error) {
      throw withStderr(error, this.stderrTail);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connecting = undefined;
    this.stderrTail = '';
    await transport?.close();
  }

  private async connect(): Promise<Client> {
    if (this.closed) throw new Error('Search MCP client is closed.');
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;

    this.connecting = this.createConnection();

    try {
      const client = await this.connecting;
      if (this.closed) {
        await this.transport?.close();
        throw new Error('Search MCP client is closed.');
      }
      this.client = client;
      return client;
    } finally {
      this.connecting = undefined;
    }
  }

  private async createConnection(): Promise<Client> {
    const transport = new StdioClientTransport(this.serverParameters);
    const client = new Client({ name: 'search-mcp-pi-extension', version: '0.1.0' });

    transport.stderr?.on('data', (chunk) => {
      this.stderrTail = appendBounded(this.stderrTail, chunk.toString());
    });

    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw withStderr(error, this.stderrTail);
    }

    const handleClose = transport.onclose;
    transport.onclose = () => {
      handleClose?.();
      if (this.transport === transport) {
        this.client = undefined;
        this.transport = undefined;
      }
    };

    this.transport = transport;
    return client;
  }
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length > MAX_STDERR_BYTES ? combined.slice(-MAX_STDERR_BYTES) : combined;
}

function withStderr(error: unknown, stderrTail: string): Error {
  const detail = stderrTail.trim();
  if (!detail) return error instanceof Error ? error : new Error(String(error));
  const message = error instanceof Error ? error.message : String(error);
  const combined = new Error(`${message} (server stderr: ${detail})`);
  if (error instanceof Error && error.cause !== undefined) (combined as { cause?: unknown }).cause = error.cause;
  return combined;
}

function parseArgs(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SEARCH_MCP_ARGS_JSON must be a JSON string array: ${String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('SEARCH_MCP_ARGS_JSON must be a JSON string array.');
  }

  return parsed;
}

function toProcessEnvironment(env: SearchMcpEnvironment): Record<string, string> {
  const allowed = new Set([
    'PATH',
    'HOME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'EXA_API_KEY',
    'BRAVE_API_KEY',
    'TAVILY_API_KEY',
    'TAVILY_RESEARCH_MODEL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GRAPH_SPARQL_ENDPOINT',
    'GRAPH_SPARQL_TOKEN',
    'DIFFBOT_TOKEN',
    'FIRECRAWL_API_KEY',
    'JINA_API_KEY',
    'CRAWL4AI_BASE_URL',
    'DEEP_RESEARCH_BASE_URL',
    'DEEP_RESEARCH_MODEL',
    ...parseForwardedEnvironmentKeys(env.SEARCH_MCP_FORWARD_ENV_JSON),
  ]);
  const entries = Object.entries(env).filter((entry): entry is [string, string] => {
    const [key, value] = entry;
    return typeof value === 'string' && (allowed.has(key) || key.startsWith('SEARCH_MCP_'));
  });
  return Object.fromEntries(entries);
}

function parseForwardedEnvironmentKeys(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`SEARCH_MCP_FORWARD_ENV_JSON must be a JSON string array: ${String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('SEARCH_MCP_FORWARD_ENV_JSON must be a JSON string array.');
  }

  return parsed;
}
