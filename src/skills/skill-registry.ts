/** Progressive CLI-first domain skill metadata. Only migrated commands belong here. */
export interface DomainSkillMetadata {
  readonly commandId: string;
  readonly domain: string;
  readonly description: string;
  readonly cliCommand: string;
  readonly cliHelp: string;
  readonly skillPath: string;
  readonly optionalPiTools: readonly string[];
}

export const DOMAIN_SKILLS: readonly DomainSkillMetadata[] = [
  {
    commandId: "github.file",
    domain: "github",
    description: "Read GitHub file content by repository and path.",
    cliCommand:
      "northstar github file OWNER/REPO PATH [--ref REF] [--json|--agent]",
    cliHelp:
      "northstar github file OWNER/REPO PATH [--ref REF] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.repo",
    domain: "github",
    description: "Read GitHub repository metadata.",
    cliCommand:
      "northstar github repo OWNER/REPO [--no-readme] [--json|--agent]",
    cliHelp: "northstar github repo OWNER/REPO [--no-readme] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.tree",
    domain: "github",
    description: "Read GitHub repository tree entries.",
    cliCommand:
      "northstar github tree OWNER/REPO [--ref REF] [--recursive] [--json|--agent]",
    cliHelp:
      "northstar github tree OWNER/REPO [--ref REF] [--recursive] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.trending",
    domain: "github",
    description: "Read GitHub trending repositories.",
    cliCommand:
      "northstar github trending [--since daily|weekly|monthly] [--limit N] [--json|--agent]",
    cliHelp:
      "northstar github trending [--since daily|weekly|monthly] [--limit N] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.search",
    domain: "github",
    description: "Search GitHub code by query.",
    cliCommand:
      "northstar github search QUERY [--language LANG] [--limit N] [--json|--agent]",
    cliHelp:
      "northstar github search QUERY [--language LANG] [--limit N] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.search_repos",
    domain: "github",
    description: "Search GitHub repositories by query.",
    cliCommand:
      "northstar github search-repos QUERY [--language LANG] [--limit N] [--json|--agent]",
    cliHelp:
      "northstar github search-repos QUERY [--language LANG] [--limit N] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.issues",
    domain: "github",
    description: "Read GitHub issues for a repository, or one issue by number.",
    cliCommand:
      "northstar github issues OWNER/REPO [--number N] [--state open|closed|all] [--labels a,b] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github issues OWNER/REPO [--number N] [--state open|closed|all] [--labels a,b] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.pulls",
    domain: "github",
    description:
      "Read GitHub pull requests for a repository, one pull by number, or changed files.",
    cliCommand:
      "northstar github pulls OWNER/REPO [--number N] [--state open|closed|all] [--files] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github pulls OWNER/REPO [--number N] [--state open|closed|all] [--files] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.releases",
    domain: "github",
    description:
      "Read GitHub releases for a repository, one release by tag, or the latest release.",
    cliCommand:
      "northstar github releases OWNER/REPO [--tag TAG] [--latest] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github releases OWNER/REPO [--tag TAG] [--latest] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.commits",
    domain: "github",
    description: "Read GitHub commits for a repository, or one commit by SHA.",
    cliCommand:
      "northstar github commits OWNER/REPO [--sha SHA] [--path PATH] [--branch BRANCH] [--ref REF] [--author AUTHOR] [--since SINCE] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github commits OWNER/REPO [--sha SHA] [--path PATH] [--branch BRANCH] [--ref REF] [--author AUTHOR] [--since SINCE] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.workflows",
    domain: "github",
    description:
      "Read GitHub Actions workflows for a repository, or one workflow by ID.",
    cliCommand:
      "northstar github workflows OWNER/REPO [--workflow WORKFLOW] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github workflows OWNER/REPO [--workflow WORKFLOW] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "github.runs",
    domain: "github",
    description:
      "Read GitHub Actions workflow runs for a repository, one run by number, or the jobs of one run.",
    cliCommand:
      "northstar github runs OWNER/REPO [--number N] [--jobs] [--workflow WORKFLOW] [--branch BRANCH] [--status STATUS] [--author AUTHOR] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar github runs OWNER/REPO [--number N] [--jobs] [--workflow WORKFLOW] [--branch BRANCH] [--status STATUS] [--author AUTHOR] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/github/SKILL.md",
    optionalPiTools: ["github"],
  },
  {
    commandId: "research.search",
    domain: "research",
    description:
      "Search academic literature and public-data sources across 12 sources.",
    cliCommand:
      "northstar research search QUERY [--source NAME|all] [--limit N] [--year-from YEAR] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar research search QUERY [--source NAME|all] [--limit N] [--year-from YEAR] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/research/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "research.paper",
    domain: "research",
    description: "Read full academic paper metadata by DOI, URL, or source ID.",
    cliCommand:
      "northstar research paper ID_OR_URL [--source NAME] [--json|--agent]",
    cliHelp:
      "northstar research paper ID_OR_URL [--source NAME] [--json|--agent]",
    skillPath: "skills/research/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "research.citations",
    domain: "research",
    description: "Read citations and citing works for one paper by ID or DOI.",
    cliCommand:
      "northstar research citations ID [--source NAME] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar research citations ID [--source NAME] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/research/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "social.search",
    domain: "social",
    description:
      "Search platform discussions by query with read-only selectors.",
    cliCommand:
      "northstar social search --platform PLATFORM --query QUERY [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar social search --platform PLATFORM --query QUERY [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/social/SKILL.md",
    optionalPiTools: ["social"],
  },
  {
    commandId: "social.read",
    domain: "social",
    description:
      "Read one platform post, thread, comments, profile, community, or feed.",
    cliCommand:
      "northstar social read --platform PLATFORM --action get_post|get_thread|get_comments|get_profile|get_community|get_feed|get_followers|get_user_posts|get_trending|get_community_posts [--query QUERY] [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar social read --platform PLATFORM --action get_post|get_thread|get_comments|get_profile|get_community|get_feed|get_followers|get_user_posts|get_trending|get_community_posts [--query QUERY] [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/social/SKILL.md",
    optionalPiTools: ["social"],
  },
  {
    commandId: "media.search",
    domain: "media",
    description: "Search videos by query.",
    cliCommand:
      "northstar media search --platform youtube|bilibili --query QUERY [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar media search --platform youtube|bilibili --query QUERY [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/media/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "media.hot",
    domain: "media",
    description: "Read currently trending videos.",
    cliCommand:
      "northstar media hot --platform youtube|bilibili [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar media hot --platform youtube|bilibili [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/media/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "media.details",
    domain: "media",
    description: "Read video details for one video by id or page address.",
    cliCommand:
      "northstar media details --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar media details --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/media/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "media.transcript",
    domain: "media",
    description:
      "Read the spoken-text transcript of one video by id or page address.",
    cliCommand:
      "northstar media transcript --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar media transcript --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/media/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "media.feed",
    domain: "media",
    description: "Read entries of one RSS or Atom feed by feed address.",
    cliCommand:
      "northstar media feed --url URL [--platform rss] [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar media feed --url URL [--platform rss] [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/media/SKILL.md",
    optionalPiTools: [],
  },
  {
    commandId: "kg.search",
    domain: "kg",
    description:
      "Search the Diffbot knowledge graph with entity-returning DQL.",
    cliCommand: "northstar kg search QUERY [--limit N] [--cursor CURSOR] [--json|--agent]",
    cliHelp: "northstar kg search QUERY [--limit N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/kg/SKILL.md",
    optionalPiTools: ["kg"],
  },
  {
    commandId: "kg.enhance",
    domain: "kg",
    description: "Enrich one Person or Organization from selectors.",
    cliCommand:
      "northstar kg enhance --type Person|Organization [--id ID] [--name NAME] [--url URL] [--email EMAIL] [--phone PHONE] [--location LOCATION] [--description TEXT] [--employer EMPLOYER] [--title TITLE] [--school SCHOOL] [--fields basic|contact|professional|all] [--max-entities N] [--include-relationships] [--include-evidence] [--confidence-threshold F] [--json|--agent]",
    cliHelp:
      "northstar kg enhance --type Person|Organization [--id ID] [--name NAME] [--url URL] [--email EMAIL] [--phone PHONE] [--location LOCATION] [--description TEXT] [--employer EMPLOYER] [--title TITLE] [--school SCHOOL] [--fields basic|contact|professional|all] [--max-entities N] [--include-relationships] [--include-evidence] [--confidence-threshold F] [--json|--agent]",
    skillPath: "skills/kg/SKILL.md",
    optionalPiTools: ["kg"],
  },
  {
    commandId: "graph.query",
    domain: "graph",
    description: "Execute one native DQL or SPARQL graph query.",
    cliCommand:
      "northstar graph query --language dql|sparql --query QUERY [--page-size N] [--cursor CURSOR] [--json|--agent]",
    cliHelp:
      "northstar graph query --language dql|sparql --query QUERY [--page-size N] [--cursor CURSOR] [--json|--agent]",
    skillPath: "skills/graph/SKILL.md",
    optionalPiTools: ["graph"],
  },
  {
    commandId: "graph.probe",
    domain: "graph",
    description: "Check cardinality of countable graph queries.",
    cliCommand:
      "northstar graph probe --language dql|sparql --query QUERY [--query QUERY ...] [--json|--agent]",
    cliHelp:
      "northstar graph probe --language dql|sparql --query QUERY [--query QUERY ...] [--json|--agent]",
    skillPath: "skills/graph/SKILL.md",
    optionalPiTools: ["graph"],
  },
  {
    commandId: "fetch.read",
    domain: "fetch",
    description: "Fetch URL content or retrieve cached web corpus slices.",
    cliCommand:
      "northstar fetch URL [--query QUERY] [--top-k N] [--max-chars N] [--site-map] [--max-pages N] [--response-id ID] [--find-text TEXT] [--offset N] [--limit N] [--claim CLAIM ...] [--json|--agent]",
    cliHelp:
      "northstar fetch URL [--query QUERY] [--top-k N] [--max-chars N] [--site-map] [--max-pages N] [--response-id ID] [--find-text TEXT] [--offset N] [--limit N] [--claim CLAIM ...] [--json|--agent]",
    skillPath: "skills/fetch/SKILL.md",
    optionalPiTools: ["fetch"],
  },
  {
    commandId: "search.web",
    domain: "search",
    description:
      "Search the web across configured backends using reciprocal rank fusion.",
    cliCommand:
      "northstar search QUERY [--limit N] [--include-content] [--recency RECENCY] [--domains D1,D2] [--year-from YEAR] [--json|--agent]",
    cliHelp:
      "northstar search QUERY [--limit N] [--include-content] [--recency RECENCY] [--domains D1,D2] [--year-from YEAR] [--json|--agent]",
    skillPath: "skills/search/SKILL.md",
    optionalPiTools: ["web_search"],
  },
];

export function domainSkill(
  commandId: string,
): DomainSkillMetadata | undefined {
  return DOMAIN_SKILLS.find((skill) => skill.commandId === commandId);
}
export function domainSkillsForDomain(
  domain: string,
): readonly DomainSkillMetadata[] {
  return DOMAIN_SKILLS.filter((skill) => skill.domain === domain);
}
export function cliSkillInventory(): readonly string[] {
  return DOMAIN_SKILLS.map((skill) => skill.cliCommand);
}
export function skillFileInventory(): readonly string[] {
  return [...new Set(DOMAIN_SKILLS.map((skill) => skill.skillPath))];
}
export function optionalPiToolInventory(): readonly string[] {
  return [...new Set(DOMAIN_SKILLS.flatMap((skill) => skill.optionalPiTools))];
}
