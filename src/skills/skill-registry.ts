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

function defineSkill(
  commandId: string,
  domain: string,
  description: string,
  cliCommand: string,
  optionalPiTools: readonly string[] = [],
): DomainSkillMetadata {
  return {
    commandId,
    domain,
    description,
    cliCommand,
    cliHelp: cliCommand,
    skillPath: `skills/${domain}/SKILL.md`,
    optionalPiTools,
  };
}

export const DOMAIN_SKILLS: readonly DomainSkillMetadata[] = [
  defineSkill("github.file", "github", "Read GitHub file content by repository and path.", "northstar github file OWNER/REPO PATH [--ref REF] [--json|--agent]", ["github"]),
  defineSkill("github.repo", "github", "Read GitHub repository metadata.", "northstar github repo OWNER/REPO [--no-readme] [--json|--agent]", ["github"]),
  defineSkill("github.tree", "github", "Read GitHub repository tree entries.", "northstar github tree OWNER/REPO [--ref REF] [--recursive] [--json|--agent]", ["github"]),
  defineSkill("github.trending", "github", "Read GitHub trending repositories.", "northstar github trending [--since daily|weekly|monthly] [--limit N] [--json|--agent]", ["github"]),
  defineSkill("github.search", "github", "Search GitHub code by query.", "northstar github search QUERY [--language LANG] [--limit N] [--json|--agent]", ["github"]),
  defineSkill("github.search_repos", "github", "Search GitHub repositories by query.", "northstar github search-repos QUERY [--language LANG] [--limit N] [--json|--agent]", ["github"]),
  defineSkill("github.issues", "github", "Read GitHub issues for a repository, or one issue by number.", "northstar github issues OWNER/REPO [--number N] [--state open|closed|all] [--labels a,b] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("github.pulls", "github", "Read GitHub pull requests for a repository, one pull by number, or changed files.", "northstar github pulls OWNER/REPO [--number N] [--state open|closed|all] [--files] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("github.releases", "github", "Read GitHub releases for a repository, one release by tag, or the latest release.", "northstar github releases OWNER/REPO [--tag TAG] [--latest] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("github.commits", "github", "Read GitHub commits for a repository, or one commit by SHA.", "northstar github commits OWNER/REPO [--sha SHA] [--path PATH] [--branch BRANCH] [--ref REF] [--author AUTHOR] [--since SINCE] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("github.workflows", "github", "Read GitHub Actions workflows for a repository, or one workflow by ID.", "northstar github workflows OWNER/REPO [--workflow WORKFLOW] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("github.runs", "github", "Read GitHub Actions workflow runs for a repository, one run by number, or the jobs of one run.", "northstar github runs OWNER/REPO [--number N] [--jobs] [--workflow WORKFLOW] [--branch BRANCH] [--status STATUS] [--author AUTHOR] [--limit N] [--cursor CURSOR] [--json|--agent]", ["github"]),
  defineSkill("research.search", "research", "Search academic literature and public-data sources across 12 sources.", "northstar research search QUERY [--source NAME|all] [--limit N] [--year-from YEAR] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("research.paper", "research", "Read full academic paper metadata by DOI, URL, or source ID.", "northstar research paper ID_OR_URL [--source NAME] [--json|--agent]"),
  defineSkill("research.citations", "research", "Read citations and citing works for one paper by ID or DOI.", "northstar research citations ID [--source NAME] [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("social.search", "social", "Search platform discussions by query with read-only selectors.", "northstar social search --platform PLATFORM --query QUERY [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]", ["social"]),
  defineSkill("social.read", "social", "Read one platform post, thread, comments, profile, community, or feed.", "northstar social read --platform PLATFORM --action get_post|get_thread|get_comments|get_profile|get_community|get_feed|get_followers|get_user_posts|get_trending|get_community_posts [--query QUERY] [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]", ["social"]),
  defineSkill("media.search", "media", "Search videos by query.", "northstar media search --platform youtube|bilibili --query QUERY [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("media.hot", "media", "Read currently trending videos.", "northstar media hot --platform youtube|bilibili [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("media.details", "media", "Read video details for one video by id or page address.", "northstar media details --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("media.transcript", "media", "Read the spoken-text transcript of one video by id or page address.", "northstar media transcript --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("media.feed", "media", "Read entries of one RSS or Atom feed by feed address.", "northstar media feed --url URL [--platform rss] [--limit N] [--cursor CURSOR] [--json|--agent]"),
  defineSkill("kg.search", "kg", "Search the Diffbot knowledge graph with entity-returning DQL.", "northstar kg search QUERY [--limit N] [--cursor CURSOR] [--json|--agent]", ["kg"]),
  defineSkill("kg.enhance", "kg", "Enrich one Person or Organization from selectors.", "northstar kg enhance --type Person|Organization [--id ID] [--name NAME] [--url URL] [--email EMAIL] [--phone PHONE] [--location LOCATION] [--description TEXT] [--employer EMPLOYER] [--title TITLE] [--school SCHOOL] [--fields basic|contact|professional|all] [--max-entities N] [--include-relationships] [--include-evidence] [--confidence-threshold F] [--json|--agent]", ["kg"]),
  defineSkill("graph.query", "graph", "Execute one native DQL or SPARQL graph query.", "northstar graph query --language dql|sparql --query QUERY [--page-size N] [--cursor CURSOR] [--json|--agent]", ["graph"]),
  defineSkill("graph.probe", "graph", "Check cardinality of countable graph queries.", "northstar graph probe --language dql|sparql --query QUERY [--query QUERY ...] [--json|--agent]", ["graph"]),
  defineSkill("fetch.read", "fetch", "Fetch URL content or retrieve cached web corpus slices.", "northstar fetch URL [--query QUERY] [--top-k N] [--max-chars N] [--site-map] [--max-pages N] [--response-id ID] [--find-text TEXT] [--offset N] [--limit N] [--claim CLAIM ...] [--json|--agent]", ["fetch"]),
  defineSkill("search.web", "search", "Search the web across configured backends using reciprocal rank fusion.", "northstar search QUERY [--limit N] [--include-content] [--recency RECENCY] [--domains D1,D2] [--year-from YEAR] [--json|--agent]", ["web_search"]),
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
