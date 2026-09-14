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
const MAX_TOOL_ERROR_TEXT_CHARS = 2000;

/** SEARCH_MCP_* keys that are non-secret config actually read by this client. Other SEARCH_MCP_* values are secret-capable and never forward implicitly. */
const BENIGN_SEARCH_MCP_KEYS = new Set([
  'SEARCH_MCP_COMMAND',
  'SEARCH_MCP_ARGS_JSON',
  'SEARCH_MCP_CWD',
  'SEARCH_MCP_FORWARD_ENV_JSON',
]);

/** Env keys whose values are obviously benign and safe to echo. Everything else is secret-capable. */
const BENIGN_ENV_KEYS = new Set(['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP']);

function isBenignKey(key: string): boolean {
  const normalized = key.trim().toUpperCase();
  if (BENIGN_ENV_KEYS.has(normalized)) return true;
  if (normalized.startsWith('SEARCH_MCP_')) return BENIGN_SEARCH_MCP_KEYS.has(normalized);
  return false;
}

/** Exact-value secrets forwarded to the MCP server process.
 * Sensitive-by-default: every non-empty forwarded value is secret-capable
 * except obviously-benign keys (PATH/HOME/SHELL/TMPDIR/TMP/TEMP plus known-benign SEARCH_MCP_* config).
 * Key matching is case-insensitive with trim. */
export function secretValuesFromEnv(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  const values: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (value.trim().length === 0) continue;
    if (isBenignKey(key)) continue;
    values.push(value);
    const trimmed = value.trim();
    if (trimmed !== value) values.push(trimmed);
  }
  return values;
}

export function redactSecrets(text: string, secrets: string[]): string {
  let redacted = text;
  const ordered = [...secrets].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) {
    if (!redacted.includes(secret)) continue;
    redacted = redacted.split(secret).join('[redacted]');
  }
  return redacted;
}

/** Typed failure for MCP tool results resolved with isError:true. */
export class SearchMcpToolError extends Error {
  readonly code = 'SEARCH_MCP_TOOL_ERROR';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'SearchMcpToolError';
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

export class SearchMcpClient implements SearchBackend {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;
  private stderrTail = '';

  constructor(private readonly serverParameters: StdioServerParameters) {}

  async callTool(name: string, args: Record<string, unknown>, options: SearchMcpCallOptions = {}): Promise<SearchMcpCallResult> {
    const client = await this.connect();
    const secrets = secretValuesFromEnv(this.serverParameters.env as Record<string, string> | undefined);
    let result: unknown;
    try {
      result = await client.callTool(
        { name, arguments: args },
        undefined,
        {
          ...(options.signal ? { signal: options.signal } : {}),
          timeout: options.timeout ?? 120_000,
          resetTimeoutOnProgress: true,
        },
      );
    } catch (error) {
      throw withStderr(error, this.stderrTail, secrets);
    }
    if (result !== null && typeof result === 'object' && (result as { isError?: unknown }).isError === true) {
      throw withStderr(new SearchMcpToolError(toolErrorMessage(name, result, secrets)), this.stderrTail, secrets);
    }
    return result as SearchMcpCallResult;
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
      throw withStderr(error, this.stderrTail, secretValuesFromEnv(this.serverParameters.env as Record<string, string> | undefined));
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

function redactCause(cause: unknown, secrets: string[]): unknown {
  if (cause instanceof Error) {
    const redacted = new Error(redactSecrets(cause.message, secrets));
    if (cause.cause !== undefined) {
      (redacted as { cause?: unknown }).cause = redactCause(cause.cause, secrets);
    }
    return redacted;
  }
  if (typeof cause === 'string') return redactSecrets(cause, secrets);
  return undefined;
}

export function withStderr(error: unknown, stderrTail: string, secrets: string[] = []): Error {
  const detail = redactSecrets(stderrTail.trim(), secrets);
  // ALWAYS redact base message + cause chain first; never return raw error carrying secrets.
  const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
  const rawCause = error instanceof Error ? error.cause : undefined;
  const safeCause = rawCause === undefined ? undefined : redactCause(rawCause, secrets);
  const causeOptions = safeCause === undefined ? undefined : { cause: safeCause };
  if (!detail) {
    if (error instanceof SearchMcpToolError) {
      return new SearchMcpToolError(message, causeOptions);
    }
    const redacted = new Error(message, causeOptions);
    return redacted;
  }
  const combinedMessage = `${message} (server stderr: ${detail})`;
  if (error instanceof SearchMcpToolError) {
    return new SearchMcpToolError(combinedMessage, causeOptions);
  }
  return new Error(combinedMessage, causeOptions);
}

function toolErrorMessage(toolName: string, result: unknown, secrets: string[]): string {
  const text = extractToolText(result);
  const redacted = redactSecrets(text, secrets);
  const truncated =
    redacted.length > MAX_TOOL_ERROR_TEXT_CHARS ? `${redacted.slice(0, MAX_TOOL_ERROR_TEXT_CHARS)}…` : redacted;
  return truncated ? `MCP tool "${toolName}" failed: ${truncated}` : `MCP tool "${toolName}" failed.`;
}

function extractToolText(result: unknown): string {
  if (result === null || typeof result !== 'object') return '';
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text') {
      const text = (item as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    } else if (item !== undefined) {
      try {
        parts.push(JSON.stringify(item) ?? String(item));
      } catch {
        parts.push(String(item));
      }
    }
  }
  return parts.join('\n');
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
  // Deny-by-default: only listed provider credentials, benign client config,
  // and explicitly validated forward-list names reach the server process.
  // There is no SEARCH_MCP_* wildcard: unknown SEARCH_MCP_* values are
  // secret-capable and never forward implicitly.
  const forwarded = new Set(parseForwardedEnvironmentKeys(env.SEARCH_MCP_FORWARD_ENV_JSON));
  const allowed = new Set([
    'PATH',
    'HOME',
    'SHELL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SEARCH_MCP_COMMAND',
    'SEARCH_MCP_ARGS_JSON',
    'SEARCH_MCP_CWD',
    'SEARCH_MCP_FORWARD_ENV_JSON',
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
  ]);
  const entries = Object.entries(env).filter((entry): entry is [string, string] => {
    const [key, value] = entry;
    return typeof value === 'string' && (allowed.has(key) || forwarded.has(key));
  });
  return Object.fromEntries(entries);
}

/** Names that look like credentials and must never ride the forward list. */
const SECRET_LIKE_NAME_PATTERN = /(TOKEN|KEY|SECRET|PASSWD|PASSWORD|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION)/i;
const VALID_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

  // The forward list is an explicit allowlist, not a bypass: reject
  // secret-like names (they belong in the listed provider credentials, not
  // in an operator free-form list) and non-benign SEARCH_MCP_* internals
  // (client config, never child payload). Unlisted values never forward.
  for (const item of parsed as string[]) {
    const name = item.trim();
    if (!VALID_ENV_NAME_PATTERN.test(name)) {
      throw new Error(`SEARCH_MCP_FORWARD_ENV_JSON must list valid env names, got: ${JSON.stringify(item)}`);
    }
    const normalized = name.toUpperCase();
    if (normalized.startsWith('SEARCH_MCP_') && !BENIGN_SEARCH_MCP_KEYS.has(normalized)) {
      throw new Error(`SEARCH_MCP_FORWARD_ENV_JSON must not forward SEARCH_MCP_* internals, got: ${name}`);
    }
    if (SECRET_LIKE_NAME_PATTERN.test(name)) {
      throw new Error(`SEARCH_MCP_FORWARD_ENV_JSON must not forward secret-like names, got: ${name}`);
    }
  }

  return (parsed as string[]).map((item) => item.trim());
}
