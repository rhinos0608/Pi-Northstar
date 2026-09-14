// Stage 2 canonical capability registry. Single source of truth for channel,
// platform, source, action, backend, and provider capability metadata.
// Consumers (reach-tools, index, providers, bootstrap, research adapters)
// derive their public vocabulary from here; no parallel channel/platform lists.
//
// Canonical-only contract: social channels advertise canonical Stage 2 actions
// (src/social-contract.ts SOCIAL_CANONICAL_ACTIONS) with no legacy aliases.
// Unknown action names are rejected with unsupported_action before dispatch.
// Instagram has no post-detail action until a verified read-only adapter
// exists; OpenCLI download is intentionally disabled.

import type { SocialAction as Stage2SocialAction, SocialPlatform as Stage2SocialPlatform } from './social/social-contract.js';
import { SOCIAL_CANONICAL_ACTIONS as STAGE2_CANONICAL_ACTIONS } from './social/social-contract.js';

export type ReachFamily = 'social' | 'media' | 'web' | 'dev' | 'research' | 'browser';

export type PublicToolName =
  | 'web_search'
  | 'fetch'
  | 'github'
  | 'social'
  | 'kg'
  | 'graph'
  | 'browser'
  | 'desktop'
  | 'agent_poll';

/** Registry marker for internal-acquisition channels with no public tool surface. */
export type InternalAcquisitionName = 'internal-acquisition';

/** Public surface budget: at most nine model-facing tools. Future domains
 *  require profiles or retrieval/describe redesign, not silent growth. */
export const MAX_PUBLIC_TOOLS = 9 as const;

/** Fail-closed budget gate: throws when registration exceeds MAX_PUBLIC_TOOLS. */
export function assertPublicToolBudget(toolNames: readonly string[]): void {
  if (toolNames.length > MAX_PUBLIC_TOOLS) {
    throw new Error(
      `Public tool budget exceeded: ${toolNames.length} tools registered (max ${MAX_PUBLIC_TOOLS}): ${toolNames.join(', ')}`,
    );
  }
}

export interface ActionCapability {
  action: string;
  readOnly: true;
}

export type BackendMode = 'native' | 'external' | 'fallback';

export type BackendQuality = 'full' | 'degraded';

export interface BackendAuth {
  required: boolean;
  allOf?: readonly string[];
  anyOf?: readonly string[];
}

export interface BackendCapability {
  id: string;
  mode: BackendMode;
  quality: BackendQuality;
  actions: readonly string[];
  probe?: { command: string; args: readonly string[] };
  auth?: BackendAuth;
  note?: string;
}

export interface ProviderCapability {
  provider: string;
  envKeys: readonly string[];
  cookieDomains: readonly string[];
  loginFlow: 'none' | 'api_key' | 'native_api' | 'env_var' | 'cli_login' | 'browser_cookie' | 'oauth';
  risk: 'none' | 'low' | 'medium' | 'high';
  /** Whether provider sessions are consumed from imported browser cookies. */
  consumesCookie: boolean;
  setup: string;
}

export interface ChannelCapability {
  id: string;
  family: ReachFamily;
  publicTool: PublicToolName | InternalAcquisitionName;
  availability: 'available' | 'planned';
  description: string;
  tier: 0 | 1 | 2;
  domains: readonly string[];
  actions: readonly ActionCapability[];
  backends: readonly BackendCapability[];
  provider?: ProviderCapability;
}

export type ResearchPaginationMode =
  | 'offset'
  | 'cursor'
  | 'page'
  | 'page-offset'
  | 'continuation'
  | 'unsupported';

export interface ResearchSourceCapability {
  id: string;
  backend: string;
  entityKind: 'work' | 'question' | 'organization' | 'article';
  yearFilter: 'supported' | 'unsupported';
  pagination: ResearchPaginationMode;
  description: string;
}

export const REACH_FAMILIES = ['social', 'media', 'web', 'dev', 'research', 'browser'] as const;

// Convenience canonical actions (shared vocabulary, never duplicated inline).
function act(action: string): ActionCapability {
  return { action, readOnly: true };
}

/** Canonical action list builder (no aliases; read-only by construction). */
function acts(...actions: string[]): ActionCapability[] {
  return actions.map(act);
}

const OPENCLI_SETUP = 'Install OpenCLI and login in Chrome';

export const CHANNEL_CAPABILITIES: readonly ChannelCapability[] = [
  {
    id: 'web',
    family: 'web',
    publicTool: 'web_search',
    availability: 'available',
    description: 'Public web search and page reading',
    tier: 0,
    domains: [],
    actions: [act('search'), act('read')],
    backends: [{ id: 'native-fetch', mode: 'native', quality: 'full', actions: ['search', 'read'] }],
  },
  {
    id: 'github',
    family: 'dev',
    publicTool: 'github',
    availability: 'available',
    description: 'GitHub repositories, files, trees, search, trending, issues, pulls, releases, commits, workflows, workflow runs',
    tier: 0,
    domains: ['github.com'],
    actions: [
      act('repo'), act('file'), act('tree'),
      act('search'), act('search_repos'), act('trending'), act('issues'),
      act('pulls'), act('releases'), act('commits'), act('workflows'), act('runs'),
    ],
    backends: [{
      id: 'github-api',
      mode: 'native',
      quality: 'full',
      actions: ['repo', 'file', 'tree', 'search', 'search_repos', 'trending', 'issues', 'pulls', 'releases', 'commits', 'workflows', 'runs'],
      auth: { required: false, anyOf: ['GITHUB_TOKEN', 'GH_TOKEN'] },
      note: 'Optional-key backend; token optional for public data. list_dir and code_search legacy spellings are unsupported.',
    }],
    provider: {
      provider: 'github',
      envKeys: ['GITHUB_TOKEN', 'GH_TOKEN'],
      cookieDomains: [],
      loginFlow: 'env_var',
      risk: 'low',
      consumesCookie: false,
      setup: 'Set GITHUB_TOKEN or GH_TOKEN for authenticated API access; optional for public data',
    },
  },
  {
    id: 'rss',
    family: 'media',
    publicTool: 'internal-acquisition',
    availability: 'available',
    description: 'RSS and Atom feed reading',
    tier: 0,
    domains: [],
    actions: [act('feed')],
    backends: [{ id: 'native-rss-atom', mode: 'native', quality: 'full', actions: ['feed'] }],
  },
  {
    id: 'v2ex',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'V2EX topics, nodes, replies, and users',
    tier: 0,
    domains: ['v2ex.com'],
    actions: acts('get_topic', 'get_thread', 'get_comments', 'get_profile', 'get_trending', 'get_community', 'get_community_posts', 'get_notifications'),
    backends: [
      {
        id: 'v2ex-legacy-api',
        mode: 'native',
        quality: 'full',
        actions: ['get_topic', 'get_thread', 'get_comments', 'get_profile', 'get_trending', 'get_community_posts'],
      },
      {
        id: 'v2ex-api-v2',
        mode: 'native',
        quality: 'full',
        actions: ['get_topic', 'get_comments', 'get_community', 'get_community_posts', 'get_notifications'],
        auth: { required: true, anyOf: ['V2EX_PAT'] },
      },
    ],
    provider: {
      provider: 'v2ex',
      envKeys: [],
      cookieDomains: [],
      loginFlow: 'none',
      risk: 'none',
      consumesCookie: false,
      setup: 'No configuration required; set V2EX_PAT for API 2.0 community and notification reads',
    },
  },
  {
    id: 'twitter',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'Twitter/X tweets, search, users, and timelines',
    tier: 1,
    domains: ['twitter.com', 'x.com'],
    actions: acts(
      'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
      'get_profile', 'get_user_posts', 'get_followers', 'get_following',
      'get_feed', 'get_trending', 'get_saved', 'get_notifications',
    ),
    backends: [
      {
        id: 'twitter-cli',
        mode: 'external',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
          'get_profile', 'get_user_posts', 'get_followers', 'get_following',
          'get_feed', 'get_saved',
        ],
        probe: { command: 'twitter', args: ['status'] },
        auth: { required: true },
        note: 'CLI-owned authenticated session in the twitter-cli local store; Pi env keys do not unlock this backend.',
      },
      {
        id: 'opencli-twitter',
        mode: 'external',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
          'get_profile', 'get_user_posts', 'get_followers', 'get_following',
          'get_feed', 'get_trending', 'get_saved', 'get_notifications',
        ],
        probe: { command: 'opencli', args: ['--help'] },
        auth: { required: true },
      },
    ],
    provider: {
      provider: 'twitter',
      envKeys: [],
      cookieDomains: ['twitter.com', 'x.com'],
      loginFlow: 'cli_login',
      risk: 'medium',
      // twitter-cli authenticates through its own local session store and
      // never consumes imported Pi cookie-jar state. Never import unused
      // credentials.
      consumesCookie: false,
      setup: 'Install twitter-cli and login via its own authenticated session',
    },
  },
  {
    id: 'reddit',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'Reddit posts, comments, subreddits, and search',
    tier: 1,
    domains: ['reddit.com', 'redd.it'],
    actions: acts(
      'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
      'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
      'get_trending', 'get_saved', 'get_community', 'get_community_posts',
    ),
    backends: [
      {
        id: 'reddit-cookie',
        mode: 'native',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
          'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
          'get_trending', 'get_saved', 'get_community', 'get_community_posts',
        ],
        auth: { required: true, anyOf: ['REDDIT_COOKIE'] },
        note: 'Scoped session-cookie backend; also accepts stored imported Reddit session cookies matched per request URL.',
      },
      {
        id: 'reddit-oauth',
        mode: 'native',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments', 'get_comment_replies',
          'get_profile', 'get_user_posts', 'get_user_comments',
          'get_trending', 'get_community', 'get_community_posts',
        ],
        auth: { required: true, allOf: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'] },
        note: 'Optional-key backend; public actions only (no feed/saved).',
      },
      {
        id: 'OpenCLI',
        mode: 'external',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments',
          'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
          'get_trending', 'get_saved', 'get_community', 'get_community_posts',
        ],
        probe: { command: 'opencli', args: ['--help'] },
        auth: { required: true },
      },
      {
        id: 'rdt-cli',
        mode: 'external',
        quality: 'full',
        actions: [
          'search', 'get_post', 'get_thread', 'get_comments',
          'get_profile', 'get_user_posts', 'get_user_comments', 'get_feed',
          'get_trending', 'get_saved', 'get_community', 'get_community_posts',
        ],
        probe: { command: 'rdt', args: ['status', '--json'] },
        auth: { required: true },
      },
    ],
    provider: {
      provider: 'reddit',
      envKeys: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USER_AGENT'],
      cookieDomains: ['reddit.com'],
      loginFlow: 'env_var',
      risk: 'medium',
      consumesCookie: true,
      setup: 'Set Reddit API credentials or install OpenCLI/rdt-cli',
    },
  },
  {
    id: 'xiaohongshu',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'XiaoHongShu search, notes, comments, feed, and users',
    tier: 1,
    domains: ['xiaohongshu.com', 'xhslink.com'],
    actions: acts(
      'search', 'get_post', 'get_comments', 'get_profile', 'get_user_posts',
      'get_followers', 'get_following', 'get_feed', 'get_saved', 'get_notifications',
    ),
    backends: [
      {
        id: 'opencli-xiaohongshu',
        mode: 'external',
        quality: 'full',
        actions: ['search', 'get_post', 'get_comments', 'get_user_posts', 'get_feed', 'get_saved', 'get_notifications'],
        probe: { command: 'opencli', args: ['--help'] },
        auth: { required: true },
      },
      {
        id: 'xhs-cli',
        mode: 'external',
        quality: 'full',
        actions: ['search', 'get_post', 'get_comments', 'get_profile', 'get_user_posts', 'get_followers', 'get_following', 'get_feed', 'get_saved'],
        probe: { command: 'xhs', args: ['--help'] },
        auth: { required: true },
        note: 'OpenCLI preferred for new installs.',
      },
    ],
    provider: {
      provider: 'xiaohongshu',
      envKeys: [],
      cookieDomains: ['xiaohongshu.com', 'xhslink.com'],
      loginFlow: 'cli_login',
      risk: 'medium',
      // OpenCLI/xhs-cli authenticate through their own local session stores
      // and never consume imported Pi cookie-jar state. Never import unused
      // credentials.
      consumesCookie: false,
      setup: OPENCLI_SETUP,
    },
  },
  {
    id: 'facebook',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'Facebook search, profiles, feed, and groups',
    tier: 1,
    domains: ['facebook.com', 'fb.com'],
    actions: acts('search', 'get_profile', 'get_feed', 'get_notifications', 'get_community'),
    backends: [{
      id: 'opencli',
      mode: 'external',
      quality: 'full',
      actions: ['search', 'get_profile', 'get_feed', 'get_notifications', 'get_community'],
      probe: { command: 'opencli', args: ['--help'] },
      auth: { required: true },
    }],
    provider: {
      provider: 'facebook',
      envKeys: [],
      cookieDomains: ['facebook.com'],
      loginFlow: 'browser_cookie',
      risk: 'medium',
      // OpenCLI authenticates through its own Chrome session and has no
      // stored-cookie env convention, so imported Facebook cookies would
      // never be consumed. Never import unused credentials.
      consumesCookie: false,
      setup: OPENCLI_SETUP,
    },
  },
  {
    id: 'instagram',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'Instagram profiles, posts, explore, and saved (no verified read-only post-detail adapter; download disabled)',
    tier: 1,
    domains: ['instagram.com'],
    actions: acts('search', 'get_profile', 'get_user_posts', 'get_followers', 'get_following', 'get_trending', 'get_saved'),
    backends: [{
      id: 'opencli',
      mode: 'external',
      quality: 'full',
      actions: ['search', 'get_profile', 'get_user_posts', 'get_followers', 'get_following', 'get_trending', 'get_saved'],
      probe: { command: 'opencli', args: ['--help'] },
      auth: { required: true },
    }],
    provider: {
      provider: 'instagram',
      envKeys: [],
      cookieDomains: ['instagram.com'],
      loginFlow: 'browser_cookie',
      risk: 'medium',
      // OpenCLI authenticates through its own Chrome session and has no
      // stored-cookie env convention, so imported Instagram cookies would
      // never be consumed. Never import unused credentials.
      consumesCookie: false,
      setup: OPENCLI_SETUP,
    },
  },
  {
    id: 'youtube',
    family: 'media',
    publicTool: 'internal-acquisition',
    availability: 'available',
    description: 'YouTube search, details, and hot via the official Data API, with keyless oEmbed fallback for details',
    tier: 1,
    domains: ['youtube.com', 'youtu.be'],
    actions: [act('search'), act('details'), act('hot'), act('transcript')],
    backends: [
      {
        id: 'youtube-data-api',
        mode: 'native',
        quality: 'full',
        actions: ['search', 'details', 'hot'],
        auth: { required: true, allOf: ['YOUTUBE_API_KEY'] },
      },
      {
        id: 'youtube-oembed',
        mode: 'fallback',
        quality: 'degraded',
        actions: ['details'],
        note: 'Keyless oEmbed; limited fields. Never used for search or hot.',
      },
      {
        id: 'youtube-transcript',
        mode: 'native',
        quality: 'degraded',
        actions: ['transcript'],
        note: 'Unofficial keyless watch-page + timedtext adapter; may break without notice. Stored Pi cookie-jar cookies attach to the watch-page fetch when present. Never yt-dlp.',
      },
      {
        id: 'yt-dlp',
        mode: 'external',
        quality: 'degraded',
        actions: [],
        probe: { command: 'yt-dlp', args: ['--version'] },
        note: 'Legacy probe only; automatic calls never route here (no-scraping policy).',
      },
    ],
    provider: {
      provider: 'youtube',
      envKeys: ['YOUTUBE_API_KEY'],
      cookieDomains: ['youtube.com'],
      loginFlow: 'browser_cookie',
      risk: 'low',
      consumesCookie: true,
      setup: 'Set YOUTUBE_API_KEY for the official YouTube Data API; optional browser-cookie import for consent-gated transcripts',
    },
  },
  {
    id: 'bilibili',
    family: 'media',
    publicTool: 'internal-acquisition',
    availability: 'available',
    description: 'Bilibili search, hot videos, details, and subtitles',
    tier: 1,
    domains: ['bilibili.com', 'b23.tv'],
    actions: [act('search'), act('details'), act('transcript'), act('hot')],
    backends: [
      {
        id: 'bili-cli',
        mode: 'external',
        quality: 'full',
        actions: ['search', 'details', 'hot'],
        probe: { command: 'bili', args: ['--help'] },
        auth: { required: false, anyOf: ['BILIBILI_SESSDATA', 'BILIBILI_COOKIE'] },
      },
      {
        id: 'OpenCLI',
        mode: 'external',
        quality: 'full',
        actions: ['transcript'],
        probe: { command: 'opencli', args: ['--help'] },
        auth: { required: true },
        note: 'OpenCLI is the subtitle path for Bilibili.',
      },
    ],
    provider: {
      provider: 'bilibili',
      envKeys: [],
      cookieDomains: ['bilibili.com'],
      loginFlow: 'cli_login',
      risk: 'low',
      consumesCookie: true,
      setup: 'Install bili-cli',
    },
  },
  {
    id: 'research',
    family: 'research',
    publicTool: 'web_search',
    availability: 'available',
    description: 'Academic, public-data, and community sources',
    tier: 0,
    domains: [],
    actions: [act('search')],
    backends: [{ id: 'native-public-apis', mode: 'native', quality: 'full', actions: ['search'] }],
  },
  {
    id: 'browser',
    family: 'browser',
    publicTool: 'browser',
    availability: 'available',
    description: 'Browser automation via CDP: navigate, evaluate, screenshot, click, type, scroll, tabs, cookies',
    tier: 0,
    domains: [],
    // Browser verbs are owned by BROWSER_ACTIONS in browser-policy.ts (which
    // also feeds the browser MCP schema and the adapters). The registry holds
    // no browser-action truth: the read-only action vocabulary does not apply
    // to the automation channel (it has mutations), so actions/backends stay
    // empty and consumers must not treat them as supported/unsupported claims.
    actions: [],
    backends: [{ id: 'cdp', mode: 'native', quality: 'full', actions: [] }],
  },
  {
    id: 'linkedin',
    family: 'social',
    publicTool: 'social',
    availability: 'available',
    description: 'LinkedIn people search, profiles, posts, and feed via OpenCLI Chrome session (verified OpenCLI 1.8.6)',
    tier: 1,
    domains: ['linkedin.com'],
    actions: acts('search', 'get_profile', 'get_user_posts', 'get_feed'),
    backends: [{
      id: 'opencli',
      mode: 'external',
      quality: 'full',
      actions: ['search', 'get_profile', 'get_user_posts', 'get_feed'],
      probe: { command: 'opencli', args: ['--help'] },
      auth: { required: true },
      note: 'Verified OpenCLI 1.8.6 opencli-linkedin operations (people-search, profile-read, posts, timeline) using its own Chrome browser session.',
    }],
    provider: {
      provider: 'linkedin',
      envKeys: [],
      cookieDomains: ['linkedin.com'],
      loginFlow: 'cli_login',
      risk: 'medium',
      // OpenCLI authenticates through its own Chrome session and has no
      // stored-cookie env convention, so imported LinkedIn cookies would
      // never be consumed. Never import unused credentials.
      consumesCookie: false,
      setup: OPENCLI_SETUP,
    },
  },
  {
    id: 'diffbot',
    family: 'research',
    publicTool: 'kg',
    availability: 'available',
    description: 'Diffbot knowledge graph: DQL search, entity enhance, text analysis, and web-search participation',
    tier: 1,
    domains: [],
    actions: [act('search'), act('enhance'), act('analyze_text')],
    backends: [
      {
        id: 'diffbot-dql',
        mode: 'native',
        quality: 'full',
        actions: ['search'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
      {
        id: 'diffbot-enhance',
        mode: 'native',
        quality: 'full',
        actions: ['enhance'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
      {
        id: 'diffbot-analyze-text',
        mode: 'native',
        quality: 'full',
        actions: ['analyze_text'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
      {
        id: 'diffbot-web-search',
        mode: 'native',
        quality: 'full',
        actions: ['search'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
        note: 'Ordinary RRF participant in web_search; no primary exception.',
      },
    ],
    provider: {
      provider: 'diffbot',
      envKeys: ['DIFFBOT_TOKEN'],
      cookieDomains: [],
      loginFlow: 'env_var',
      risk: 'low',
      consumesCookie: false,
      setup: 'Set DIFFBOT_TOKEN to enable Diffbot knowledge search, enhance, text analysis, web-search participation, and graph operations',
    },
  },
  {
    id: 'diffbot-graph',
    family: 'research',
    publicTool: 'graph',
    availability: 'available',
    description: 'Diffbot native graph access: DQL query execution, cardinality probes, and ontology schema discovery',
    tier: 1,
    domains: [],
    actions: [act('query'), act('probe'), act('schema')],
    backends: [
      {
        id: 'diffbot-graph-query',
        mode: 'native',
        quality: 'full',
        actions: ['query'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
      {
        id: 'diffbot-graph-probe',
        mode: 'native',
        quality: 'full',
        actions: ['probe'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
      {
        id: 'diffbot-graph-schema',
        mode: 'native',
        quality: 'full',
        actions: ['schema'],
        auth: { required: true, anyOf: ['DIFFBOT_TOKEN'] },
      },
    ],
    provider: {
      provider: 'diffbot',
      envKeys: ['DIFFBOT_TOKEN'],
      cookieDomains: [],
      loginFlow: 'env_var',
      risk: 'low',
      consumesCookie: false,
      setup: 'Set DIFFBOT_TOKEN to enable Diffbot knowledge search, enhance, text analysis, web-search participation, and graph operations',
    },
  },
  {
    id: 'firecrawl',
    family: 'research',
    publicTool: 'web_search',
    availability: 'available',
    description: 'Firecrawl search API and page scraping with vendor-side external processing',
    tier: 1,
    domains: [],
    actions: [act('search'), act('read')],
    backends: [
      {
        id: 'firecrawl-search',
        mode: 'native',
        quality: 'full',
        actions: ['search'],
        auth: { required: true, anyOf: ['FIRECRAWL_API_KEY'] },
      },
      {
        id: 'firecrawl-scrape',
        mode: 'native',
        quality: 'full',
        actions: ['read'],
        auth: { required: true, anyOf: ['FIRECRAWL_API_KEY'] },
        note: 'Vendor-side external processing; page content passes through Firecrawl.',
      },
    ],
    provider: {
      provider: 'firecrawl',
      envKeys: ['FIRECRAWL_API_KEY'],
      cookieDomains: [],
      loginFlow: 'env_var',
      risk: 'low',
      consumesCookie: false,
      setup: 'Set FIRECRAWL_API_KEY for Firecrawl search and page reads; page content is processed externally by the vendor (external processing)',
    },
  },
  {
    id: 'jina',
    family: 'research',
    publicTool: 'web_search',
    availability: 'available',
    description: 'Jina search API and URL reading with vendor-side external processing',
    tier: 1,
    domains: [],
    actions: [act('search'), act('read')],
    backends: [
      {
        id: 'jina-search',
        mode: 'native',
        quality: 'full',
        actions: ['search'],
        auth: { required: true, anyOf: ['JINA_API_KEY'] },
      },
      {
        id: 'jina-reader',
        mode: 'native',
        quality: 'full',
        actions: ['read'],
        auth: { required: true, anyOf: ['JINA_API_KEY'] },
        note: 'Vendor-side external processing; page content passes through Jina.',
      },
    ],
    provider: {
      provider: 'jina',
      envKeys: ['JINA_API_KEY'],
      cookieDomains: [],
      loginFlow: 'env_var',
      risk: 'low',
      consumesCookie: false,
      setup: 'Set JINA_API_KEY for Jina search and page reads; page content is processed externally by the vendor (external processing)',
    },
  },
];

// Registry order defines deterministic `source: "all"` fanout order.
export const RESEARCH_SOURCE_CAPABILITIES: readonly ResearchSourceCapability[] = [
  { id: 'semantic_scholar', backend: 'semantic-scholar-api', entityKind: 'work', yearFilter: 'supported', pagination: 'offset', description: 'Semantic Scholar Graph API paper search' },
  { id: 'openalex', backend: 'openalex-api', entityKind: 'work', yearFilter: 'supported', pagination: 'cursor', description: 'OpenAlex works search' },
  { id: 'pubmed', backend: 'pubmed-eutils', entityKind: 'work', yearFilter: 'supported', pagination: 'offset', description: 'PubMed E-utilities esearch + esummary' },
  { id: 'stackoverflow', backend: 'stackexchange-api', entityKind: 'question', yearFilter: 'supported', pagination: 'page', description: 'Stack Exchange API excerpts search' },
  { id: 'datacite', backend: 'datacite-api', entityKind: 'work', yearFilter: 'supported', pagination: 'cursor', description: 'DataCite DOI search' },
  { id: 'ror', backend: 'ror-api', entityKind: 'organization', yearFilter: 'unsupported', pagination: 'page-offset', description: 'ROR organizations search' },
  { id: 'gdelt', backend: 'gdelt-api', entityKind: 'article', yearFilter: 'supported', pagination: 'unsupported', description: 'GDELT DOC API article lists' },
  { id: 'wikipedia', backend: 'wikipedia-api', entityKind: 'article', yearFilter: 'unsupported', pagination: 'unsupported', description: 'Wikipedia opensearch' },
  { id: 'wikidata', backend: 'wikidata-api', entityKind: 'article', yearFilter: 'unsupported', pagination: 'continuation', description: 'Wikidata entity search' },
  { id: 'arxiv', backend: 'arxiv-api', entityKind: 'work', yearFilter: 'supported', pagination: 'offset', description: 'arXiv Atom API search' },
  { id: 'crossref', backend: 'crossref-api', entityKind: 'work', yearFilter: 'supported', pagination: 'offset', description: 'Crossref works search' },
  { id: 'hackernews', backend: 'hn-algolia', entityKind: 'article', yearFilter: 'supported', pagination: 'page', description: 'Hacker News Algolia search' },
];

export const AGGREGATE_RESEARCH_SOURCE = 'all';

// ── Derived public vocabularies (consumed by index/providers/bootstrap) ──

export function socialPlatforms(): string[] {
  return CHANNEL_CAPABILITIES
    .filter((channel) => channel.family === 'social' && channel.availability === 'available')
    .map((channel) => channel.id);
}

export function mediaPlatforms(): string[] {
  return CHANNEL_CAPABILITIES
    .filter((channel) => channel.family === 'media' && channel.availability === 'available')
    .map((channel) => channel.id);
}

export function researchSourceIds(): string[] {
  return RESEARCH_SOURCE_CAPABILITIES.map((source) => source.id);
}

export function isResearchSource(id: string): boolean {
  return id === AGGREGATE_RESEARCH_SOURCE
    || RESEARCH_SOURCE_CAPABILITIES.some((source) => source.id === id);
}

export function researchSourceCapability(id: string): ResearchSourceCapability | undefined {
  return RESEARCH_SOURCE_CAPABILITIES.find((source) => source.id === id);
}

export function channelCapability(id: string): ChannelCapability | undefined {
  return CHANNEL_CAPABILITIES.find((channel) => channel.id === id);
}

export function backendCapability(channelId: string, backendId: string): BackendCapability | undefined {
  return channelCapability(channelId)?.backends.find((backend) => backend.id === backendId);
}

export function canonicalActionsFor(platformId: string): readonly string[] {
  return channelCapability(platformId)?.actions.map((capability) => capability.action) ?? [];
}

/**
 * Providers eligible for cookie import: operational cookie-consuming providers
 * with declared cookie domains. Planned providers never import cookies.
 */
export function cookieImportProviders(): string[] {
  return CHANNEL_CAPABILITIES
    .filter((channel) =>
      channel.availability === 'available'
      && channel.provider?.consumesCookie === true
      && channel.provider.cookieDomains.length > 0)
    .map((channel) => channel.provider!.provider);
}

/** Channel names accepted by /reach-setup install_channels (legacy superset). */
export function setupChannelNames(): string[] {
  return CHANNEL_CAPABILITIES.map((channel) => channel.id);
}

// ── Canonical action vocabulary (canonical-only; no aliases) ──
// Social channels advertise canonical Stage 2 actions only. Unknown spellings
// are rejected with unsupported_action before any backend dispatch.

/** Canonical Stage 2 actions advertised for a platform (registry source). */
export function socialCanonicalActions(platform: Stage2SocialPlatform): readonly Stage2SocialAction[] {
  return STAGE2_CANONICAL_ACTIONS[platform];
}

/**
 * Exact worker backend names per platform, in Stage 2 tie-break preference
 * order. Ordering rule: capability/completeness and pagination suitability
 * precede auth preference; when completeness is equal, scoped cookie-jar/session
 * backends first, otherwise anonymous/keyless before optional keys.
 * (reddit-cookie covers every advertised reddit action, so it leads; the
 * optional-key reddit-oauth backend trails; keyless v2ex-legacy-api leads
 * the optional-key v2ex-api-v2.)
 */
export const SOCIAL_BACKEND_PREFERENCE: Readonly<Record<Stage2SocialPlatform, readonly string[]>> = {
  twitter: ['twitter-cli', 'opencli-twitter'],
  reddit: ['reddit-cookie', 'rdt-cli', 'OpenCLI', 'reddit-oauth'],
  xiaohongshu: ['opencli-xiaohongshu', 'xhs-cli'],
  facebook: ['opencli'],
  instagram: ['opencli'],
  linkedin: ['opencli'],
  v2ex: ['v2ex-legacy-api', 'v2ex-api-v2'],
};

/**
 * Infer the platform from a URL host using exact or subdomain registry
 * matches only. Lookalike hosts (evil-twitter.com, twitter.com.evil.com)
 * never infer a platform.
 */
export function inferPlatformFromUrl(url: string, allowedPlatforms: readonly string[]): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  for (const platform of allowedPlatforms) {
    const channel = channelCapability(platform);
    if (!channel) continue;
    for (const domain of channel.domains) {
      if (host === domain || host.endsWith(`.${domain}`)) return platform;
    }
  }
  return undefined;
}
