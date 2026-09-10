import { CliSearchBackend } from './cli-backend.js';
import { buildServerParameters, SearchMcpClient, type SearchMcpEnvironment } from './mcp-client.js';

export interface BackendCallOptions {
  signal?: AbortSignal;
  timeout?: number;
}

export interface BackendCallResult {
  content?: unknown;
  /**
   * Structured detail payload alongside `content`. Legacy fields are
   * preserved; canonical V1 results attach additively under
   * `details.northstar` (see result-contract.ts, tool-output.ts).
   */
  details?: unknown;
  [key: string]: unknown;
}

export interface SearchBackend {
  callTool(name: string, args: Record<string, unknown>, options?: BackendCallOptions): Promise<BackendCallResult>;
  close(): Promise<void>;
}

export function createSearchBackend(env: SearchMcpEnvironment = process.env): SearchBackend {
  if (env.SEARCH_BACKEND === 'mcp') return new SearchMcpClient(buildServerParameters(env));
  return new CliSearchBackend(env);
}

export function resultToText(result: BackendCallResult): string {
  if (!Array.isArray(result.content)) {
    return JSON.stringify(result, null, 2);
  }

  return result.content.map(contentItemToText).join('\n');
}

function contentItemToText(item: unknown): string {
  if (isTextContent(item)) return item.text;

  const serialized = JSON.stringify(item);
  return serialized ?? String(item);
}

function isTextContent(item: unknown): item is { type: 'text'; text: string } {
  return (
    typeof item === 'object' &&
    item !== null &&
    'type' in item &&
    'text' in item &&
    item.type === 'text' &&
    typeof item.text === 'string'
  );
}
