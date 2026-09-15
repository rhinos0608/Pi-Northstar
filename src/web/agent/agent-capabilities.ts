// Effective-capability resolver (Phase 8, R5).
//
// Build-time registry (CHANNEL_CAPABILITIES in src/capabilities.ts) answers
// "what exists". This module answers "what is usable on this job, right now"
// from env/auth/CLI state. All decisions deterministic from inputs; no network.
//
// CLI-presence inference without a probe (documented, deterministic):
//   bili CLI    <- BILI_CLI_PRESENT=1 | BILIBILI_CLI_AVAILABLE=1
//   opencli     <- OPENCLI_TOKEN | OPENCLI_HOST | OPENCLI_PRESENT=1
//   twitter CLI <- TWITTER_CLI_PRESENT=1 | opencli-present
//   rdt CLI     <- RDT_PRESENT=1 | opencli-present
//   xhs CLI     <- XHS_PRESENT=1 | opencli-present
// With opts.probe, each distinct CLI command is probed once
// (bili --help, opencli --help, twitter status, rdt status --json, xhs --help);
// probe throw/reject counts as absent. Env-hint inference never runs when a
// probe is provided.

export type CapabilityVertical =
  | 'web'
  | 'research'
  | 'video'
  | 'social'
  | 'kg'
  | 'graph'
  | 'github';

export type CapabilityQuality = 'full' | 'degraded' | 'unavailable';

export interface EffectiveCapability {
  action: string;
  vertical: CapabilityVertical;
  usable: boolean;
  quality: CapabilityQuality;
  reason?: string;
  backend?: string;
}

export interface VideoCapabilities {
  youtube: EffectiveCapability;
  bilibili: EffectiveCapability;
}

export interface EffectiveCapabilitiesSnapshot {
  web: EffectiveCapability;
  research: EffectiveCapability;
  video: VideoCapabilities;
  social: EffectiveCapability[];
  kg: EffectiveCapability;
  graph: EffectiveCapability;
  github: EffectiveCapability;
}

/** Injected CLI probe: true = installed and responding. Throw = absent. */
export type CliProbe = (cmd: string, args: string[]) => Promise<boolean>;

export interface ResolveOptions {
  probe?: CliProbe;
}

/** Prompt-format ceiling: UTF-8 bytes, not chars. */
export const MAX_CAPABILITIES_PROMPT_BYTES = 2048;

export const SOCIAL_PLATFORMS = [
  'twitter',
  'reddit',
  'xiaohongshu',
  'facebook',
  'instagram',
  'linkedin',
  'v2ex',
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/** Planner-proposed gather action subset validated against a snapshot. */
export type GatherActionLike =
  | { kind: 'web_search' }
  | { kind: 'fetch' }
  | { kind: 'research_search' }
  | { kind: 'media_video'; platform: 'youtube' | 'bilibili' }
  | { kind: 'social'; platform?: string }
  | { kind: 'github' }
  | { kind: 'kg' }
  | { kind: 'graph' };

export interface GatherAdmissibility {
  allowed: boolean;
  degradeTo?: 'web';
  reason?: string;
}

function hasEnv(env: Record<string, string | undefined>, key: string): boolean {
  return typeof env[key] === 'string' && (env[key] as string).trim().length > 0;
}

function hint(env: Record<string, string | undefined>, key: string): boolean {
  return (env[key] ?? '').trim() === '1';
}

type CliName = 'bili' | 'opencli' | 'twitter' | 'rdt' | 'xhs';

type CliMap = Record<CliName, boolean>;

function opencliFromHints(env: Record<string, string | undefined>): boolean {
  return hasEnv(env, 'OPENCLI_TOKEN') || hasEnv(env, 'OPENCLI_HOST') || hint(env, 'OPENCLI_PRESENT');
}

function cliFromHints(env: Record<string, string | undefined>): CliMap {
  const opencli = opencliFromHints(env);
  return {
    bili: hint(env, 'BILI_CLI_PRESENT') || hint(env, 'BILIBILI_CLI_AVAILABLE'),
    opencli,
    twitter: hint(env, 'TWITTER_CLI_PRESENT') || opencli,
    rdt: hint(env, 'RDT_PRESENT') || opencli,
    xhs: hint(env, 'XHS_PRESENT') || opencli,
  };
}

const PROBE_ARGV: Record<CliName, { cmd: string; args: string[] }> = {
  bili: { cmd: 'bili', args: ['--help'] },
  opencli: { cmd: 'opencli', args: ['--help'] },
  twitter: { cmd: 'twitter', args: ['status'] },
  rdt: { cmd: 'rdt', args: ['status', '--json'] },
  xhs: { cmd: 'xhs', args: ['--help'] },
};

async function cliFromProbe(probe: CliProbe): Promise<CliMap> {
  const out = {} as CliMap;
  for (const name of Object.keys(PROBE_ARGV) as CliName[]) {
    const { cmd, args } = PROBE_ARGV[name];
    try {
      out[name] = await probe(cmd, args);
    } catch {
      out[name] = false;
    }
  }
  return out;
}

function cap(
  action: string,
  vertical: CapabilityVertical,
  usable: boolean,
  quality: CapabilityQuality,
  reason: string,
  backend: string,
): EffectiveCapability {
  return { action, vertical, usable, quality, reason, backend };
}

function resolveYoutube(env: Record<string, string | undefined>): EffectiveCapability {
  if (hasEnv(env, 'YOUTUBE_API_KEY')) {
    return cap(
      'media.video',
      'video',
      true,
      'full',
      'YOUTUBE_API_KEY present; search/details/hot via youtube-data-api',
      'youtube-data-api',
    );
  }
  if (hasEnv(env, 'YOUTUBE_COOKIE')) {
    return cap(
      'media.video',
      'video',
      true,
      'degraded',
      'no YOUTUBE_API_KEY; cookie-gated transcript path only via youtube-transcript',
      'youtube-transcript',
    );
  }
  return cap(
    'media.video',
    'video',
    false,
    'unavailable',
    'no YOUTUBE_API_KEY and no YOUTUBE_COOKIE; keyless oEmbed covers details-only (degraded) but search/hot unavailable',
    'youtube-oembed',
  );
}

function resolveBilibili(env: Record<string, string | undefined>, cli: CliMap): EffectiveCapability {
  if (!cli.bili) {
    return cap(
      'media.video',
      'video',
      false,
      'unavailable',
      'bili CLI absent; install bili-cli',
      'bili-cli',
    );
  }
  if (hasEnv(env, 'BILIBILI_SESSDATA') || hasEnv(env, 'BILIBILI_COOKIE')) {
    return cap(
      'media.video',
      'video',
      true,
      'full',
      'bili CLI present with session cookie; search/details/hot/subtitles via bili-cli',
      'bili-cli',
    );
  }
  return cap(
    'media.video',
    'video',
    true,
    'degraded',
    'bili CLI present without session cookie; search/details ok, subtitles degraded',
    'bili-cli',
  );
}

function redditCapability(env: Record<string, string | undefined>, cli: CliMap): EffectiveCapability {
  if (hasEnv(env, 'REDDIT_COOKIE')) {
    return cap('social.search', 'social', true, 'full', 'REDDIT_COOKIE present', 'reddit-cookie');
  }
  if (hasEnv(env, 'REDDIT_CLIENT_ID') && hasEnv(env, 'REDDIT_CLIENT_SECRET') && hasEnv(env, 'REDDIT_USER_AGENT')) {
    return cap(
      'social.search',
      'social',
      true,
      'full',
      'Reddit OAuth trio present (public actions only, no feed/saved)',
      'reddit-oauth',
    );
  }
  if (cli.opencli || cli.rdt) {
    return cap(
      'social.search',
      'social',
      true,
      'degraded',
      'CLI session only (opencli/rdt), no cookie or OAuth credentials',
      cli.rdt && !cli.opencli ? 'rdt-cli' : 'OpenCLI',
    );
  }
  return cap('social.search', 'social', false, 'unavailable', 'no REDDIT_COOKIE, no OAuth trio, no opencli/rdt CLI', 'reddit-cookie');
}

function cliOnlyPlatform(
  cliPresent: boolean,
  backend: string,
  setup: string,
): EffectiveCapability {
  if (cliPresent) {
    return cap('social.search', 'social', true, 'full', `${backend} CLI session present`, backend);
  }
  return cap('social.search', 'social', false, 'unavailable', `${setup}; no ${backend} CLI session`, backend);
}

function resolveSocial(env: Record<string, string | undefined>, cli: CliMap): EffectiveCapability[] {
  const twitterCookie = hasEnv(env, 'TWITTER_COOKIE') || hasEnv(env, 'TWITTER_AUTH_TOKEN') || hasEnv(env, 'TWITTER_CT0');
  const xhsCookie = hasEnv(env, 'XHS_COOKIE') || hasEnv(env, 'XIAOHONGSHU_COOKIE');
  const twitter = cli.twitter || cli.opencli
    ? cap('social.search', 'social', true, 'full', 'twitter CLI session present', cli.twitter && !cli.opencli ? 'twitter-cli' : 'opencli-twitter')
    : twitterCookie
      ? cap('social.search', 'social', false, 'unavailable', 'twitter cookie present but no CLI session; twitter-cli owns its own session store', 'twitter-cli')
      : cap('social.search', 'social', false, 'unavailable', 'no twitter CLI session; install twitter-cli or OpenCLI', 'twitter-cli');
  const xiaohongshu = cli.opencli || cli.xhs
    ? cap('social.search', 'social', true, 'full', 'xiaohongshu CLI session present', 'opencli-xiaohongshu')
    : xhsCookie
      ? cap('social.search', 'social', false, 'unavailable', 'xiaohongshu cookie present but no CLI session; OpenCLI/xhs-cli own their own session stores', 'opencli-xiaohongshu')
      : cap('social.search', 'social', false, 'unavailable', 'no xiaohongshu CLI session; install OpenCLI', 'opencli-xiaohongshu');
  return [
    { ...twitter, action: 'social.search:twitter' },
    { ...redditCapability(env, cli), action: 'social.search:reddit' },
    { ...xiaohongshu, action: 'social.search:xiaohongshu' },
    { ...cliOnlyPlatform(cli.opencli, 'opencli', 'install OpenCLI and login in Chrome'), action: 'social.search:facebook' },
    { ...cliOnlyPlatform(cli.opencli, 'opencli', 'install OpenCLI and login in Chrome'), action: 'social.search:instagram' },
    { ...cliOnlyPlatform(cli.opencli, 'opencli', 'install OpenCLI and login in Chrome'), action: 'social.search:linkedin' },
    cap('social.search:v2ex', 'social', true, 'full', 'keyless native v2ex API; V2EX_PAT optional for API 2.0 reads', 'v2ex-legacy-api'),
  ];
}

function buildCapabilities(env: Record<string, string | undefined>, cli: CliMap): EffectiveCapabilitiesSnapshot {
  const kg = hasEnv(env, 'DIFFBOT_TOKEN')
    ? cap('kg.search', 'kg', true, 'full', 'DIFFBOT_TOKEN present; DQL search/enhance via diffbot-dql', 'diffbot-dql')
    : cap('kg.search', 'kg', false, 'unavailable', 'DIFFBOT_TOKEN unset; kg channel conditionally registered only', 'diffbot-dql');
  const graph = hasEnv(env, 'DIFFBOT_TOKEN')
    ? cap('graph.query', 'graph', true, 'full', 'DIFFBOT_TOKEN present; DQL query/probe/schema via diffbot-graph', 'diffbot-graph-query')
    : hasEnv(env, 'GRAPH_SPARQL_ENDPOINT')
      ? cap(
          'graph.query',
          'graph',
          true,
          'degraded',
          'GRAPH_SPARQL_ENDPOINT set; SPARQL SELECT/ASK only, no DQL/probe/schema',
          'sparql',
        )
      : cap(
          'graph.query',
          'graph',
          false,
          'unavailable',
          'no DIFFBOT_TOKEN and no GRAPH_SPARQL_ENDPOINT; set GRAPH_SPARQL_ENDPOINT',
          'sparql',
        );
  return {
    web: cap('web.search', 'web', true, 'full', 'always available; native search+fetch under SSRF policy', 'native-fetch'),
    research: cap(
      'research.search',
      'research',
      true,
      'full',
      'always available; 12 academic/public-data sources via native public APIs',
      'native-public-apis',
    ),
    video: {
      youtube: resolveYoutube(env),
      bilibili: resolveBilibili(env, cli),
    },
    social: resolveSocial(env, cli),
    kg,
    graph,
    github: cap(
      'github.repo',
      'github',
      true,
      'full',
      'always available; hardened clone stack, token optional for public data',
      'github-api',
    ),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    if (Array.isArray(value)) {
      for (const entry of value) deepFreeze(entry);
    } else {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
    Object.freeze(value);
  }
  return value;
}

/** Job-time availability from env + optional CLI probe. Frozen. No network. */
export async function resolveEffectiveCapabilities(
  env: Record<string, string | undefined>,
  opts?: ResolveOptions,
): Promise<EffectiveCapabilitiesSnapshot> {
  const cli = opts?.probe ? await cliFromProbe(opts.probe) : cliFromHints(env);
  return deepFreeze(buildCapabilities(env, cli));
}

/** Sync per-job snapshot from env-hint CLI inference only. Frozen. */
export function snapshotForJob(env: Record<string, string | undefined>): EffectiveCapabilitiesSnapshot {
  return deepFreeze(buildCapabilities(env, cliFromHints(env)));
}

function socialLine(social: EffectiveCapability[]): string {
  const usable = social.filter((entry) => entry.usable);
  const missing = social.filter((entry) => !entry.usable);
  const missingNames = missing.map((entry) => entry.action.split(':')[1] ?? entry.action);
  const detail = usable.map((entry) => `${entry.action.split(':')[1]}: ${entry.quality}`).join(', ');
  const suffix = missingNames.length > 0 ? `; missing ${missingNames.length}: ${missingNames.join(', ')}` : '; all platforms usable';
  return `social: ${usable.length}/${social.length} usable${detail ? ` (${detail})` : ''}${suffix}`;
}

function capLine(name: string, entry: EffectiveCapability): string {
  return `${name}: ${entry.quality} (${entry.reason})`;
}

/** Deterministic one-line-per-vertical prompt context. Byte-capped. */
export function formatCapabilitiesForPrompt(snapshot: EffectiveCapabilitiesSnapshot): string {
  const lines = [
    capLine('web', snapshot.web),
    capLine('research', snapshot.research),
    capLine('video.youtube', snapshot.video.youtube),
    capLine('video.bilibili', snapshot.video.bilibili),
    socialLine(snapshot.social),
    capLine('kg', snapshot.kg),
    capLine('graph', snapshot.graph),
    capLine('github', snapshot.github),
  ];
  const full = lines.join('\n');
  if (Buffer.byteLength(full, 'utf8') <= MAX_CAPABILITIES_PROMPT_BYTES) return full;
  const marker = '\n…[truncated]';
  let cut = full;
  while (Buffer.byteLength(cut + marker, 'utf8') > MAX_CAPABILITIES_PROMPT_BYTES) {
    cut = cut.slice(0, -1);
  }
  return cut + marker;
}

function deny(entry: EffectiveCapability, what: string): GatherAdmissibility {
  return {
    allowed: false,
    degradeTo: 'web',
    reason: `specialist route unavailable: ${what} ${entry.quality} (${entry.reason})`,
  };
}

function allowDegraded(entry: EffectiveCapability, what: string): GatherAdmissibility {
  if (entry.quality === 'degraded') {
    return { allowed: true, reason: `specialist route degraded: ${what} (${entry.reason})` };
  }
  return { allowed: true };
}

/** Validate planner-proposed GatherAction against snapshot. Unavailable route
 *  degrades to web explicitly, never silent equivalence. */
export function gatherActionAdmissibility(
  action: GatherActionLike,
  snapshot: EffectiveCapabilitiesSnapshot,
): GatherAdmissibility {
  switch (action.kind) {
    case 'web_search':
    case 'fetch':
    case 'research_search':
    case 'github':
      return { allowed: true };
    case 'media_video': {
      const entry = action.platform === 'youtube' ? snapshot.video.youtube : snapshot.video.bilibili;
      if (!entry.usable) return deny(entry, `video.${action.platform}`);
      return allowDegraded(entry, `video.${action.platform}`);
    }
    case 'kg':
      if (!snapshot.kg.usable) return deny(snapshot.kg, 'kg');
      return allowDegraded(snapshot.kg, 'kg');
    case 'graph':
      if (!snapshot.graph.usable) return deny(snapshot.graph, 'graph');
      return allowDegraded(snapshot.graph, 'graph');
    case 'social': {
      if (action.platform === undefined) {
        const anyUsable = snapshot.social.some((entry) => entry.usable);
        if (!anyUsable) {
          return {
            allowed: false,
            degradeTo: 'web',
            reason: 'specialist route unavailable: social all 7 platforms unavailable',
          };
        }
        return { allowed: true };
      }
      const entry = snapshot.social.find((item) => item.action === `social.search:${action.platform}`);
      if (!entry) {
        return {
          allowed: false,
          degradeTo: 'web',
          reason: `specialist route unavailable: social unknown platform "${action.platform}"`,
        };
      }
      if (!entry.usable) return deny(entry, `social:${action.platform}`);
      return allowDegraded(entry, `social:${action.platform}`);
    }
  }
}
