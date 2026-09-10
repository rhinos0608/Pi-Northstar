import type { BackendCallResult } from './backend.js';
import { callGithubTool } from './github-domain.js';
import { guardResult, northstarTextResult } from './tool-output.js';
import { searchResearchPage } from './research-sources.js';
import { callReachTool } from './reach-tools.js';
import { ScraplingBridge } from './scrapling-bridge.js';
import { buildNorthstarResult, parseEntity } from './result-contract.js';
import { resolveWebActionForTool, validateWebRequest } from './web-contract.js';
import {
  fetchReadablePage,
  requireString,
  semanticCrawl,
  webSearch,
  wordCount,
  type WebToolOptions,
} from './web.js';

type NativeToolName = 'web_search' | 'semantic_crawl' | 'fetch' | 'agentic_browse' | 'browse' | 'research' | 'github';

interface NativeToolOptions extends WebToolOptions {}

export async function callNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions = {},
): Promise<BackendCallResult> {
  const reachResult = await callReachTool(name, args, options);
  if (reachResult) return reachResult;

  return guardResult(await dispatchNativeTool(name, args, options), { env: options.env });
}

async function dispatchNativeTool(
  name: string,
  args: Record<string, unknown>,
  options: NativeToolOptions,
): Promise<BackendCallResult> {
  switch (name as NativeToolName) {
    case 'web_search':
      return webSearch(args, options);
    case 'semantic_crawl':
      return semanticCrawl(args, options);
    case 'fetch': {
      // Contract-first routing: query-less fetch is read, fetch with a query
      // is crawl. resolveWebActionForTool validates before dispatch.
      const action = resolveWebActionForTool('fetch', args);
      if (action === 'read') return agenticBrowse(args, options);
      return semanticCrawl(args, options);
    }
    case 'agentic_browse':
      return agenticBrowse(args, options);
    case 'browse':
      return agenticBrowse({ action: 'read', ...args }, options);
    case 'research':
      return research(args, options);
    case 'github':
      return github(args, options);
    default:
      throw new Error(`Unsupported native tool: ${name}`);
  }
}




async function agenticBrowse(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'read';
  if (action !== 'read' && action !== 'browse') {
    throw new Error(`Native agentic_browse only supports read and browse actions, got: ${action}`);
  }

  const url = requireString(args.url, 'url');
  // Contract validation before dispatch: maxChars honored with
  // reject-on-out-of-range (same bound as the crawl path).
  const readInput: { action: string; url?: string; maxChars?: number } = { action: 'read', url };
  if (typeof args.maxChars === 'number') readInput.maxChars = args.maxChars;
  const { request } = validateWebRequest(readInput);
  const maxChars = request.maxChars;

  // Try Scrapling bridge if available (auto-detect)
  let bridge: ScraplingBridge | undefined;
  try {
    bridge = new ScraplingBridge({
      fetcher: 'stealthy',
      solveCloudflare: true,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.env?.PI_SEARCH_SCRAPLING_PROXY ? { proxy: options.env.PI_SEARCH_SCRAPLING_PROXY } : {}),
    });
  } catch { /* use fallback */ }

  try {
    const page = await fetchReadablePage(
      url,
      options.signal,
      bridge,
      options.lookup,
      options.fetchPageText ? { fetchPageText: options.fetchPageText } : undefined,
    );
    const content = page.content.slice(0, maxChars);
    const parsed = parseEntity(
      { id: page.url, url: page.url, title: page.title, snippet: content.slice(0, 8000), source: 'web' },
      { source: 'web', kind: 'article' },
    );
    const envelope = buildNorthstarResult({
      request: { tool: 'agentic_browse', channel: 'web', action: 'read' },
      outcomes: [{ source: 'web', backend: 'native-fetch', entities: parsed.ok ? [parsed.entity] : [] }],
      pagination: { supported: false, limit: 1, hasMore: false },
    });
    return northstarTextResult(content, {
      url: page.url,
      title: page.title,
      content,
      wordCount: wordCount(content),
      truncated: page.content.length > maxChars,
    }, envelope);
  } finally {
    if (bridge) await bridge.close();
  }
}

async function research(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  const action = typeof args.action === 'string' ? args.action : 'academic';
  if (action !== 'academic') throw new Error(`Native research only supports academic action, got: ${action}`);

  const query = requireString(args.query, 'query');
  const source = typeof args.source === 'string' ? args.source : 'all';
  // Reject-on-out-of-range: research limit 1-30 rejects via the web contract
  // instead of silently clamping.
  const { request: bound } = validateWebRequest({
    action: 'search',
    query,
    category: 'research',
    limit: args.limit === undefined ? 12 : (args.limit as number),
  });
  const limit = bound.limit;
  // Every advertised source dispatches to its exact native adapter via the
  // research seam; unknown sources return an explicit error envelope, never a
  // DuckDuckGo/web substitution.
  const researchPageRequest: Parameters<typeof searchResearchPage>[0] = { query, source, limit };
  if (typeof args.yearFrom === 'number') researchPageRequest.yearFrom = args.yearFrom;
  if (typeof args.cursor === 'string' && args.cursor) researchPageRequest.cursor = args.cursor;
  if (options.signal) researchPageRequest.signal = options.signal;
  if (options.env) researchPageRequest.env = options.env;
  const envelope = await searchResearchPage(researchPageRequest, { requestedAction: action });

  const entities = envelope.data.kind === 'entities' ? envelope.data.entities : [];
  const results = entities.map((entity) => ({
    title: entity.title || entity.id,
    url: entity.url,
    snippet: entity.snippet ?? '',
    source: entity.source,
  }));
  let text = results.length
    ? results.map((result, index) => `## ${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`).join('\n\n')
    : `No research results for: ${query}`;
  const failedSources = [...new Set(envelope.errors.map((error) => error.source))];
  if (envelope.status === 'error' && envelope.errors[0]) {
    text = `Research error (${envelope.request.source}): ${envelope.errors[0].message}`;
  } else if (failedSources.length > 0 && results.length > 0) {
    text += `\n\nFailed sources: ${failedSources.join(', ')}.`;
  }

  return northstarTextResult(text, { query, source, results }, envelope);
}

async function github(args: Record<string, unknown>, options: NativeToolOptions): Promise<BackendCallResult> {
  // Thin delegation: validation, REST, and normalization live in github-domain.
  return callGithubTool(args, {
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
}
