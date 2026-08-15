import { codexConfigured } from './codex-search.js';

export interface ProviderDescriptor {
  provider: string;
  channel: string;
  family: string;
  envKeys: string[];
  cookieDomains: string[];
  loginFlow: 'none' | 'api_key' | 'native_api' | 'env_var' | 'cli_login' | 'browser_cookie' | 'oauth';
  risk: 'none' | 'low' | 'medium' | 'high';
  setup: string;
  description: string;
  /** CDP login URL for automated browser login flow (optional) */
  loginUrl?: string;
}

export const AUTH_DIR = '~/.pi-extension-search';

/**
 * Provider descriptors: what env keys each provider needs, cookie domains,
 * auth flow type, and risk.  No values stored here — key names only.
 */
export const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  // ── Zero-config (no auth needed) ──────────────────────────
  { provider: 'web', channel: 'web', family: 'web', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required', description: 'Public web search and page reading' },
  { provider: 'rss', channel: 'rss', family: 'media', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required', description: 'RSS and Atom feed reading' },
  { provider: 'v2ex', channel: 'v2ex', family: 'social', envKeys: [], cookieDomains: [], loginFlow: 'none', risk: 'none', setup: 'No configuration required', description: 'V2EX topics, nodes, replies, and users' },

  // ── API key only ──────────────────────────────────────────
  { provider: 'youtube', channel: 'youtube', family: 'media', envKeys: ['YOUTUBE_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set YOUTUBE_API_KEY env var or install yt-dlp', description: 'YouTube search, metadata, and subtitles' },
  { provider: 'brave', channel: 'search', family: 'research', envKeys: ['BRAVE_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set BRAVE_API_KEY for enhanced search', description: 'Brave Search API' },
  { provider: 'exa', channel: 'search', family: 'research', envKeys: ['EXA_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set EXA_API_KEY for semantic search', description: 'Exa (formerly Metaphor) semantic search API' },
  { provider: 'tavily', channel: 'search', family: 'research', envKeys: ['TAVILY_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Optional: set TAVILY_API_KEY for AI-native search', description: 'Tavily AI search API' },
  { provider: 'xiaoyuzhou', channel: 'xiaoyuzhou', family: 'research', envKeys: ['GROQ_API_KEY', 'OPENAI_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set GROQ_API_KEY or OPENAI_API_KEY for transcription', description: 'Xiaoyuzhou podcast transcription' },
  { provider: 'deepResearch', channel: 'research', family: 'research', envKeys: ['DEEP_RESEARCH_API_TOKEN'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set DEEP_RESEARCH_API_TOKEN for deep research', description: 'Deep research API' },
  { provider: 'codex', channel: 'search', family: 'research', envKeys: ['CODEX_ACCESS_TOKEN', 'CODEX_ACCOUNT_ID'], cookieDomains: [], loginFlow: 'cli_login', risk: 'medium', setup: 'Run codex login (writes ~/.codex/auth.json) or set CODEX_ACCESS_TOKEN (+ optional CODEX_ACCOUNT_ID; CODEX_HOME overrides the auth file location)', description: 'Codex/ChatGPT web search via undocumented endpoint (best-effort, unofficial, may change or stop working)' },

  // ── Environment variable token/secret ─────────────────────
  { provider: 'github', channel: 'github', family: 'dev', envKeys: ['GITHUB_TOKEN', 'GH_TOKEN'], cookieDomains: ['github.com'], loginFlow: 'env_var', risk: 'low', setup: 'Set GITHUB_TOKEN for authenticated API access', description: 'GitHub repositories, files, trees, search', loginUrl: 'https://github.com/login' },
  { provider: 'twitter', channel: 'twitter', family: 'social', envKeys: ['TWITTER_AUTH_TOKEN', 'TWITTER_CT0'], cookieDomains: ['twitter.com', 'x.com'], loginFlow: 'env_var', risk: 'medium', setup: 'Set TWITTER_AUTH_TOKEN+TWITTER_CT0 or install twitter-cli', description: 'Twitter/X tweets, search, users, and timelines', loginUrl: 'https://x.com/login' },
  { provider: 'reddit', channel: 'reddit', family: 'social', envKeys: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'], cookieDomains: ['reddit.com'], loginFlow: 'env_var', risk: 'medium', setup: 'Set Reddit API credentials or install OpenCLI/rdt-cli', description: 'Reddit posts, comments, subreddits, and search', loginUrl: 'https://www.reddit.com/login' },

  // ── CLI login ─────────────────────────────────────────────
  { provider: 'bilibili', channel: 'bilibili', family: 'media', envKeys: [], cookieDomains: ['bilibili.com'], loginFlow: 'cli_login', risk: 'low', setup: 'Install bili-cli', description: 'Bilibili search, hot videos, details, and subtitles', loginUrl: 'https://www.bilibili.com/' },

  // ── Browser cookie login (OpenCLI or similar) ─────────────
  { provider: 'facebook', channel: 'facebook', family: 'social', envKeys: [], cookieDomains: ['facebook.com'], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'Facebook search, profiles, feed, and groups', loginUrl: 'https://www.facebook.com/login' },
  { provider: 'instagram', channel: 'instagram', family: 'social', envKeys: [], cookieDomains: ['instagram.com'], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'Instagram user search, profiles, posts, explore', loginUrl: 'https://www.instagram.com/accounts/login/' },
  { provider: 'xiaohongshu', channel: 'xiaohongshu', family: 'social', envKeys: [], cookieDomains: ['xiaohongshu.com', 'xhslink.com'], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install OpenCLI and login in Chrome', description: 'XiaoHongShu search, notes, comments, feed', loginUrl: 'https://www.xiaohongshu.com/login' },
  { provider: 'linkedin', channel: 'linkedin', family: 'social', envKeys: [], cookieDomains: ['linkedin.com'], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Install linkedin-scraper-mcp with browser login', description: 'LinkedIn profiles, companies, jobs', loginUrl: 'https://www.linkedin.com/login' },
  { provider: 'xueqiu', channel: 'xueqiu', family: 'social', envKeys: [], cookieDomains: ['xueqiu.com'], loginFlow: 'browser_cookie', risk: 'medium', setup: 'Configure Xueqiu cookies from browser', description: 'Stock quotes, search, hot lists', loginUrl: 'https://xueqiu.com/' },

  // ── Infrastructure providers (not user-facing channels) ──
  { provider: 'opencli', channel: '', family: '', envKeys: ['OPENCLI_HOST', 'OPENCLI_PORT', 'OPENCLI_TOKEN'], cookieDomains: [], loginFlow: 'env_var', risk: 'low', setup: 'Set OPENCLI_HOST/PORT/TOKEN for remote instance', description: 'OpenCLI backend connector' },
  { provider: 'openai', channel: '', family: '', envKeys: ['OPENAI_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set OPENAI_API_KEY for LLM features', description: 'OpenAI API key for LLM and transcription' },
  { provider: 'groq', channel: '', family: '', envKeys: ['GROQ_API_KEY'], cookieDomains: [], loginFlow: 'api_key', risk: 'low', setup: 'Set GROQ_API_KEY for fast LLM inference', description: 'Groq API key for LLM inference' },
];

export function liveAuthSnapshot(env: Record<string, string | undefined>): Record<string, { configured: boolean; keyNames: string[] }> {
  const result: Record<string, { configured: boolean; keyNames: string[] }> = {};
  for (const desc of PROVIDER_DESCRIPTORS) {
    const present = desc.envKeys.filter(k => typeof env[k] === 'string' && env[k]!.length > 0);
    let configured = present.length > 0 || desc.loginFlow === 'none';
    if (desc.provider === 'codex' && !configured) configured = codexConfigured(env);
    result[desc.provider] = { configured, keyNames: present };
  }
  return result;
}

export function findProvider(providerKey: string): ProviderDescriptor | undefined {
  return PROVIDER_DESCRIPTORS.find(d => d.provider === providerKey);
}

export function authForChannel(channelName: string, env: Record<string, string | undefined>): { configured: boolean; keyNames: string[]; loginFlow: string; cookieDomains: string[]; risk: string } | undefined {
  const desc = PROVIDER_DESCRIPTORS.find(d => d.channel === channelName);
  if (!desc) return undefined;
  const present = desc.envKeys.filter(k => typeof env[k] === 'string' && env[k]!.length > 0);
  let configured = present.length > 0 || desc.loginFlow === 'none';
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
    configured: snapshot[d.provider]?.configured ?? false,
    keyNames: snapshot[d.provider]?.keyNames ?? [],
    loginFlow: d.loginFlow,
    cookieDomains: d.cookieDomains,
    risk: d.risk,
    setup: d.setup,
  }));
}
