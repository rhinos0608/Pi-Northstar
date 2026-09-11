import { codexConfigured } from './codex-search.js';
import { channelCapability } from './capabilities.js';

export interface ProviderDescriptor {
  provider: string;
  channel: string;
  /** Additive multi-channel surfaces; legacy singular `channel` stays first and
   *  remains the availability/routing source of truth. Descriptors without
   *  `channels` behave exactly as before (singular channel only). */
  channels?: readonly string[];
  family: string;
  envKeys: string[];
  cookieDomains: string[];
  loginFlow: 'none' | 'api_key' | 'native_api' | 'env_var' | 'cli_login' | 'browser_cookie' | 'oauth';
  risk: 'none' | 'low' | 'medium' | 'high';
  /** Canonical availability from the capability registry; providers without a
   *  registry channel default to available. */
  availability: 'available' | 'planned';
  setup: string;
  description: string;
  /** CDP login URL for automated browser login flow (optional) */
  loginUrl?: string;
}

export const AUTH_DIR = '~/.pi-northstar';

/**
 * Provider descriptors: what env keys each provider needs, cookie domains,
 * auth flow type, and risk.  No values stored here — key names only.
 */
export const PROVIDER_DESCRIPTOR_SOURCE: Array<Omit<ProviderDescriptor, 'availability'>> = [
  // ── Zero-config (no auth needed) ──────────────────────────
  { provider: 'web', channel: 'web', family: 'web', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required', description: 'Public web search and page reading' },
  { provider: 'rss', channel: 'rss', family: 'media', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required', description: 'RSS and Atom feed reading' },
  { provider: 'v2ex', channel: 'v2ex', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required; set V2EX_PAT for API 2.0 community and notification reads', description: 'V2EX topics, nodes, replies, and users' },

  // ── API key only ──────────────────────────────────────────
  { provider: 'youtube', channel: 'youtube', family: 'media', envKeys: ['YOUTUBE_API_KEY'], cookieDomains: ['youtube.com'], loginFlow: 'browser_cookie', risk: 'low', setup: 'Set YOUTUBE_API_KEY for the official YouTube Data API; optional browser-cookie import for consent-gated transcripts', description: 'YouTube search, details, and hot via the official Data API; keyless unofficial transcript', loginUrl: 'https://www.youtube.com/' },
  { provider: 'brave', channel: 'search', family: 'research', envKeys: ['BRAVE_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set BRAVE_API_KEY for enhanced search', description: 'Brave Search API' },
  { provider: 'exa', channel: 'search', family: 'research', envKeys: ['EXA_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set EXA_API_KEY for semantic search', description: 'Exa (formerly Metaphor) semantic search API' },
  { provider: 'tavily', channel: 'search', family: 'research', envKeys: ['TAVILY_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set TAVILY_API_KEY for AI-native search', description: 'Tavily AI search API' },
  { provider: 'deepResearch', channel: 'research', family: 'research', envKeys: ['DEEP_RESEARCH_API_TOKEN'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set DEEP_RESEARCH_API_TOKEN for deep research', description: 'Deep research API' },
  { provider: 'codex', channel: 'search', family: 'research', envKeys: ['CODEX_ACCESS_TOKEN', 'CODEX_ACCOUNT_ID'], cookieDomains: [], loginFlow: 'cli_login', risk: 'medium', setup: 'Run codex login (writes ~/.codex/auth.json) or set CODEX_ACCESS_TOKEN (+ optional CODEX_ACCOUNT_ID; CODEX_HOME overrides the auth file location)', description: 'Codex/ChatGPT web search via undocumented endpoint (best-effort, unofficial, may change or stop working)' },

  // ── Environment variable token/secret ─────────────────────
  { provider: 'github', channel: 'github', family: 'dev', envKeys: ['GITHUB_TOKEN', 'GH_TOKEN'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set GITHUB_TOKEN or GH_TOKEN for authenticated API access; optional for public data', description: 'GitHub repositories, files, trees, search, search_repos, trending, issues, pulls, releases, commits', loginUrl: 'https://github.com/login' },
  { provider: 'diffbot', channel: 'diffbot', channels: ['diffbot', 'web', 'research'], family: 'research', envKeys: ['DIFFBOT_TOKEN'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set DIFFBOT_TOKEN to enable Diffbot knowledge search, enhance, text analysis, and web-search participation', description: 'Diffbot knowledge graph: DQL search, entity enhance, and text analysis (kg tool) plus web_search participation' },
  { provider: 'firecrawl', channel: 'firecrawl', channels: ['firecrawl', 'web'], family: 'research', envKeys: ['FIRECRAWL_API_KEY'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set FIRECRAWL_API_KEY for Firecrawl search and page reads; page content is processed externally by the vendor (external processing)', description: 'Firecrawl search API and page scraping with vendor-side external processing' },
  { provider: 'jina', channel: 'jina', channels: ['jina', 'web'], family: 'research', envKeys: ['JINA_API_KEY'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set JINA_API_KEY for Jina search and page reads; page content is processed externally by the vendor (external processing)', description: 'Jina search API and URL reading with vendor-side external processing' },
  { provider: 'twitter', channel: 'twitter', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'cli_login', risk: 'medium', setup: 'Install twitter-cli and login via its own authenticated session', description: 'Twitter/X tweets, search, users, and timelines', loginUrl: 'https://x.com/login' },
  { provider: 'reddit', channel: 'reddit', family: 'social', envKeys: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'], cookieDomains: ['reddit.com'], loginFlow: 'env_var', risk: 'medium', setup: 'Set Reddit API credentials or install OpenCLI/rdt-cli', description: 'Reddit posts, comments, subreddits, and search', loginUrl: 'https://www.reddit.com/login' },

  // ── CLI login ─────────────────────────────────────────────
  { provider: 'bilibili', channel: 'bilibili', family: 'media', envKeys: [], cookieDomains: ['bilibili.com'], loginFlow: 'cli_login', risk: 'low', setup: 'Install bili-cli', description: 'Bilibili search, hot videos, details, and subtitles', loginUrl: 'https://www.bilibili.com/' },

  // ── Browser cookie login (OpenCLI or similar) ─────────────
  { provider: 'facebook', channel: 'facebook', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'Facebook search, profiles, feed, and groups', loginUrl: 'https://www.facebook.com/login' },
  { provider: 'instagram', channel: 'instagram', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'Instagram search, profiles, followers, trending, saved (no post-detail; download disabled)', loginUrl: 'https://www.instagram.com/accounts/login/' },
  { provider: 'xiaohongshu', channel: 'xiaohongshu', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'cli_login', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'XiaoHongShu search, notes, comments, feed', loginUrl: 'https://www.xiaohongshu.com/login' },
  { provider: 'linkedin', channel: 'linkedin', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'cli_login', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'LinkedIn search, profiles, user posts, feed via OpenCLI Chrome session', loginUrl: 'https://www.linkedin.com/login' },

  // ── Infrastructure providers (not user-facing channels) ──
  { provider: 'opencli', channel: '', family: '', envKeys: ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set OPENCLI_HOST/PORT/TOKEN for remote instance', description: 'OpenCLI backend connector' },
  { provider: 'openai', channel: '', family: '', envKeys: ['OPENAI_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set OPENAI_API_KEY for LLM features', description: 'OpenAI API key for LLM and transcription' },
  { provider: 'groq', channel: '', family: '', envKeys: ['GROQ_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set GROQ_API_KEY for fast LLM inference', description: 'Groq API key for LLM inference' },
];

/** Availability derives from the canonical registry; providers without a registry channel are operational. */
export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = PROVIDER_DESCRIPTOR_SOURCE.map((descriptor) => ({
  ...descriptor,
  availability: channelCapability(descriptor.channel)?.availability ?? 'available',
}));

function redditOAuthConfigured(env: Record<string, string | undefined>): boolean {
  return Boolean(env.REDDIT_CLIENT_ID?.trim() && env.REDDIT_CLIENT_SECRET?.trim() && env.REDDIT_USER_AGENT?.trim());
}

export function liveAuthSnapshot(env: Record<string, string | undefined>): Record<string, { configured: boolean; keyNames: string[] }> {
  const result: Record<string, { configured: boolean; keyNames: string[] }> = {};
  for (const desc of PROVIDER_DESCRIPTORS) {
    const present = desc.envKeys.filter(k => typeof env[k] === 'string' && env[k]!.trim().length > 0);
    let configured = present.length > 0 || desc.loginFlow === 'none';
    if (desc.provider === 'reddit') configured = redditOAuthConfigured(env);
    if (desc.provider === 'codex' && !configured) configured = codexConfigured(env);
    result[desc.provider] = { configured, keyNames: present };
  }
  return result;
}

/** All registry channels a provider serves. Legacy singular `channel` first;
 *  descriptors without `channels` return exactly `[channel]`. */
export function providerChannels(descriptor: ProviderDescriptor): readonly string[] {
  return descriptor.channels ?? [descriptor.channel];
}

export function findProvider(providerKey: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find(d => d.provider === providerKey);
}

export function authForChannel(channelName: string, env: Record<string, string | undefined>): { configured: boolean; keyNames: string[]; loginFlow: string; cookieDomains: string[]; risk: string } | undefined {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.channel === channelName)
    ?? PROVIDER_DESCRIPTORS.find(d => d.channels?.includes(channelName));
  if (!desc) return undefined;
  const present = desc.envKeys.filter(k => typeof env[k] === 'string' && env[k]!.trim().length > 0);
  let configured = present.length > 0 || desc.loginFlow === 'none';
  if (desc.provider === 'reddit') configured = redditOAuthConfigured(env);
  if (desc.provider === 'codex' && !configured) configured = codexConfigured(env);
  return {
    configured,
    keyNames: present,
    loginFlow: desc.loginFlow,
    cookieDomains: desc.cookieDomains,
    risk: desc.risk,
  };
}

export function providerSummary(env: Record<string, string | undefined>): Array<{
  provider: string;
  channel: string;
  family: string;
  availability: 'available' | 'planned';
  configured: boolean;
  keyNames: string[];
  loginFlow: string;
  cookieDomains: string[];
  risk: string;
  setup: string;
}> {
  const snapshot = liveAuthSnapshot(env);
  return PROVIDER_DESCRIPTORS.map(d => ({
    provider: d.provider,
    channel: d.channel,
    family: d.family,
    availability: d.availability,
    configured: snapshot[d.provider]?.configured ?? false,
    keyNames: snapshot[d.provider]?.keyNames ?? [],
    loginFlow: d.loginFlow,
    cookieDomains: d.cookieDomains,
    risk: d.risk,
    setup: d.setup,
  }));
}
