#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { SocialError } from "../social/social-contract.js";
import { cliSkillInventory, domainSkill } from "../skills/skill-registry.js";
import { commandSurface } from "../commands/command-registry.js";

interface CliResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    platform?: string;
    backend?: string;
  };
}

const BROKER_SERVE_USAGE =
  "northstar broker serve --project-id ID [--root-dir DIR] [--json|--agent]";

const JOBS_STATUS_USAGE =
  "northstar jobs status --project-id ID --request-id ID [--root-dir DIR] [--json|--agent]";

const SOCIAL_SEARCH_USAGE =
  "northstar social search --platform PLATFORM --query QUERY [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]";
const SOCIAL_READ_USAGE =
  "northstar social read --platform PLATFORM --action get_post|get_thread|get_comments|get_profile|get_community|get_feed|get_followers|get_user_posts|get_trending|get_community_posts [--query QUERY] [--post-id ID] [--comment-id ID] [--user USER] [--community COMMUNITY] [--topic TOPIC] [--url URL] [--feed-variant VARIANT] [--sort SORT] [--time-range RANGE] [--include-replies] [--limit N] [--cursor CURSOR] [--json|--agent]";

const SOCIAL_VALUE_FLAGS: Readonly<Record<string, string>> = {
  "--platform": "platform",
  "--action": "action",
  "--query": "query",
  "--post-id": "postId",
  "--comment-id": "commentId",
  "--user": "user",
  "--community": "community",
  "--topic": "topic",
  "--url": "url",
  "--feed-variant": "feedVariant",
  "--sort": "sort",
  "--time-range": "timeRange",
  "--cursor": "cursor",
};

const MEDIA_SEARCH_USAGE =
  "northstar media search --platform youtube|bilibili --query QUERY [--limit N] [--cursor CURSOR] [--json|--agent]";
const MEDIA_HOT_USAGE =
  "northstar media hot --platform youtube|bilibili [--limit N] [--cursor CURSOR] [--json|--agent]";
const MEDIA_DETAILS_USAGE =
  "northstar media details --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]";
const MEDIA_TRANSCRIPT_USAGE =
  "northstar media transcript --platform youtube|bilibili [--id ID] [--url URL] [--limit N] [--cursor CURSOR] [--json|--agent]";
const MEDIA_FEED_USAGE =
  "northstar media feed --url URL [--platform rss] [--limit N] [--cursor CURSOR] [--json|--agent]";

const MEDIA_VALUE_FLAGS: Readonly<Record<string, string>> = {
  "--platform": "platform",
  "--id": "id",
  "--url": "url",
  "--query": "query",
  "--cursor": "cursor",
};

if (isMainModule()) {
  try {
    const result = await runCommand(
      process.argv.slice(2),
      await cliEnvironment(process.argv.slice(2)),
    );
    writeResult(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    writeResult(
      errorResult(
        "internal_error",
        error instanceof Error ? error.message : String(error),
      ),
    );
    process.exitCode = 1;
  }
}

export async function runCommand(
  args: string[] | string | undefined,
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const argv = Array.isArray(args)
    ? args
    : [args].filter((value): value is string => typeof value === "string");
  const commandName = argv[0];

  if (
    commandName === "--help" ||
    commandName === "-h" ||
    commandName === "help" ||
    commandName === undefined
  )
    return helpResult();
  if (
    commandName === "version" ||
    commandName === "--version" ||
    commandName === "-v"
  )
    return { ok: true, data: { name: "northstar", version: "0.5.0" } };
  if (commandName === "domains") return { ok: true, data: cliDomains() };
  if (commandName === "capabilities")
    return { ok: true, data: commandSurface() };
  if (commandName === "status") return statusResult(env);
  if (commandName === "config") return configResult(env);
  if (commandName !== undefined && cliDomains().includes(commandName)) {
    if (commandName === "research")
      return researchCommandResult(argv.slice(1), env);
    if (commandName === "broker") return brokerCommandResult(argv.slice(1), env);
    if (commandName === "jobs") return jobsCommandResult(argv.slice(1), env);
    if (commandName === "social")
      return socialCommandResult(argv.slice(1), env);
    if (commandName === "media") return mediaCommandResult(argv.slice(1), env);
    if (commandName === "kg") return kgCommandResult(argv.slice(1), env);
    if (commandName === "graph") return graphCommandResult(argv.slice(1), env);
    if (commandName === "fetch") return fetchCommandResult(argv.slice(1), env);
    if (commandName === "search")
      return searchCommandResult(argv.slice(1), env);
    return githubCommandResult(argv.slice(1), env);
  }
  if (commandName === "broker") return brokerCommandResult(argv.slice(1), env);
  if (commandName === "jobs") return jobsCommandResult(argv.slice(1), env);
  if (commandName === "call")
    return errorResult("unsupported_command", "call is private worker transport");

  return errorResult(
    "unknown_command",
    `Usage: northstar <${[...cliDomains(), "domains", "capabilities", "status", "config", "version"].join("|")}>`,
  );
}

/** Map tool failures to the CLI envelope. SocialError codes pass through
 * with platform/backend context; plain Errors collapse to 'tool_error'.
 * Messages are pre-scrubbed at worker level; this path never adds raw
 * URL/body material. */
export function cliToolError(error: unknown): CliResult {
  if (error instanceof SocialError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.platform !== undefined ? { platform: error.platform } : {}),
        ...(error.backend !== undefined ? { backend: error.backend } : {}),
      },
    };
  }
  return errorResult(
    "tool_error",
    error instanceof Error ? error.message : String(error),
  );
}

async function statusResult(
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const { DEFAULT_SEARCH_MCP_COMMAND, buildServerParameters } =
    await import("../process/mcp-client.js");
  const parameters = buildServerParameters(env);

  return {
    ok: true,
    data: {
      backend: env.SEARCH_BACKEND === "mcp" ? "mcp-stdio" : "native-cli",
      command: parameters.command,
      args: parameters.args,
      cwd: parameters.cwd ?? null,
      defaultCommand: DEFAULT_SEARCH_MCP_COMMAND,
    },
  };
}

async function configResult(
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const { DEFAULT_SEARCH_MCP_COMMAND } =
    await import("../process/mcp-client.js");
  const { loadedConfigSummary } = await import("../setup/local-config.js");
  return {
    ok: true,
    data: {
      searchBackend: env.SEARCH_BACKEND ?? "native-cli",
      searchMcpCommand:
        env.SEARCH_MCP_COMMAND?.trim() || DEFAULT_SEARCH_MCP_COMMAND,
      searchMcpArgsJson: env.SEARCH_MCP_ARGS_JSON ?? "[]",
      searchMcpCwd: env.SEARCH_MCP_CWD ?? null,
      localConfig: loadedConfigSummary(env),
    },
  };
}

function errorResult(code: string, message: string): CliResult {
  return { ok: false, error: { code, message } };
}

function helpResult(): CliResult {
  return {
    ok: true,
    data: {
      usage: "northstar <command>",
      commands: [
        ...cliSkillInventory(),
        "northstar broker serve --project-id ID [--root-dir DIR] [--json|--agent]",
        "northstar jobs status --project-id ID --request-id ID [--root-dir DIR] [--json|--agent]",
        "domains",
        "capabilities",
        "status",
        "version",
      ],
    },
  };
}

function cliDomains(): string[] {
  return [
    ...new Set(
      commandSurface().flatMap((commandId) => {
        const skill = domainSkill(commandId);
        return skill === undefined ? [] : [skill.domain];
      }),
    ),
  ];
}

async function githubCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0] === "search-repos" ? "search_repos" : args[0];
  const skill =
    (subcommand ? domainSkill(`github.${subcommand}`) : undefined) ??
    domainSkill("github.file");
  if (skill === undefined)
    return errorResult("unknown_command", "No CLI domain is registered");
  const commandId = skill.commandId;
  const usage = skill.cliHelp;
  if (
    args[0] === "--help" ||
    args[0] === "-h" ||
    args[0] === undefined ||
    ((args[0] === "file" ||
      args[0] === "repo" ||
      args[0] === "tree" ||
      args[0] === "trending" ||
      args[0] === "search" ||
      args[0] === "search-repos" ||
      args[0] === "search_repos" ||
      args[0] === "issues" ||
      args[0] === "pulls" ||
      args[0] === "releases" ||
      args[0] === "commits" ||
      args[0] === "workflows" ||
      args[0] === "runs") &&
      (args[1] === "--help" || args[1] === "-h"))
  )
    return { ok: true, data: { usage, commandId, skill: skill.skillPath } };
  if (args[0] === "trending") return githubTrendingCommand(args.slice(1), env);
  if (args[0] === "search")
    return githubSearchCommand("search", args.slice(1), env);
  if (args[0] === "search-repos" || args[0] === "search_repos")
    return githubSearchCommand("search_repos", args.slice(1), env);
  if (args[0] === "issues")
    return githubIssuesCommand("issues", args.slice(1), env);
  if (args[0] === "pulls")
    return githubIssuesCommand("pulls", args.slice(1), env);
  if (args[0] === "releases") return githubReleasesCommand(args.slice(1), env);
  if (args[0] === "commits") return githubCommitsCommand(args.slice(1), env);
  if (args[0] === "workflows")
    return githubWorkflowsCommand(args.slice(1), env);
  if (args[0] === "runs") return githubRunsCommand(args.slice(1), env);
  if (args[0] !== "file" && args[0] !== "repo" && args[0] !== "tree")
    return errorResult("unknown_command", `Usage: ${usage}`);
  const action = args[0];
  const positional: string[] = [];
  let ref: string | undefined;
  let includeReadme: boolean | undefined;
  let recursive = false;
  let mode: "human" | "json" | "agent" = "human";
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") mode = "json";
    else if (arg === "--agent") mode = "agent";
    else if (arg === "--no-readme" && action === "repo") includeReadme = false;
    else if (arg === "--recursive" && action === "tree") recursive = true;
    else if (arg === "--ref") {
      ref = args[++i];
      if (!ref) return errorResult("invalid_usage", "--ref requires a value");
    } else if (arg?.startsWith("--"))
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    else if (arg !== undefined) positional.push(arg);
  }
  if (positional.length !== (action === "repo" || action === "tree" ? 1 : 2))
    return errorResult("invalid_usage", `Usage: ${usage}`);
  const [identity, path] = positional;
  const match = identity?.match(/^([^/]+)\/([^/]+)$/);
  if (!match || (action === "file" && !path))
    return errorResult(
      "invalid_usage",
      action === "file"
        ? "OWNER/REPO and PATH required"
        : "OWNER/REPO required",
    );
  return runCommandResult(async () => {
    const { executeGithubFile } = await import("../commands/github-file-handler.js");
    const { executeGithubRepo } = await import("../commands/github-repo-handler.js");
    const { executeGithubTree } = await import("../commands/github-tree-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    const context = createCommandContext({ surface: "cli", env });
    if (action === "repo") {
      return executeGithubRepo({
        owner: match[1],
        repo: match[2],
        ...(includeReadme !== undefined ? { includeReadme } : {}),
      }, context);
    }
    if (action === "tree") {
      return executeGithubTree({
        owner: match[1],
        repo: match[2],
        ...(ref ? { ref } : {}),
        ...(recursive ? { recursive: true } : {}),
      }, context);
    }
    return executeGithubFile({
      owner: match[1],
      repo: match[2],
      path,
      ...(ref ? { ref } : {}),
    }, context);
  }, mode);
}

async function researchPaperCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar research paper ID_OR_URL [--source NAME] [--json|--agent]";
  let source: string | undefined;
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--source") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      source = value;
    } else if (arg?.startsWith("--")) {
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length !== 1)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  return runCommandResult(async () => {
    const { executeResearchPaper } = await import("../commands/research-paper-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeResearchPaper(
      { idOrUrl: positional[0], ...(source !== undefined ? { source } : {}) },
      createCommandContext({ surface: "cli", env }),
    );
  }, mode);
}

async function researchCitationsCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar research citations ID [--source NAME] [--limit N] [--cursor CURSOR] [--json|--agent]";
  let source: string | undefined;
  let limit: number | undefined;
  let cursor: string | undefined;
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--source" || arg === "--limit" || arg === "--cursor") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      if (arg === "--source") source = value;
      else if (arg === "--cursor") cursor = value;
      else if (arg === "--limit") {
        if (!/^\d+$/.test(value))
          return errorResult("invalid_usage", "--limit requires an integer");
        limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
          return errorResult(
            "invalid_usage",
            "--limit requires an integer 1..30",
          );
      }
    } else if (arg?.startsWith("--")) {
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length !== 1)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  return runCommandResult(async () => {
    const { executeResearchCitations } = await import("../commands/research-citations-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeResearchCitations({
      id: positional[0],
      ...(source !== undefined ? { source } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    }, createCommandContext({ surface: "cli", env }));
  }, mode);
}

async function researchCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar research search QUERY [--source NAME|all] [--limit N] [--year-from YEAR] [--cursor CURSOR] [--json|--agent]";
  const commandId = "research.search";
  const skill = domainSkill(commandId);
  if (
    args[0] === "--help" ||
    args[0] === "-h" ||
    args[0] === undefined ||
    (args[0] === "search" && (args[1] === "--help" || args[1] === "-h"))
  ) {
    return {
      ok: true,
      data: {
        usage: skill?.cliHelp ?? usage,
        commandId,
        skill: skill?.skillPath,
      },
    };
  }
  if (args[0] === "paper" && (args[1] === "--help" || args[1] === "-h")) {
    const paperSkill = domainSkill("research.paper");
    return {
      ok: true,
      data: {
        usage:
          paperSkill?.cliHelp ??
          "northstar research paper ID_OR_URL [--source NAME] [--json|--agent]",
        commandId: "research.paper",
        skill: paperSkill?.skillPath,
      },
    };
  }
  if (args[0] === "citations" && (args[1] === "--help" || args[1] === "-h")) {
    const citationsSkill = domainSkill("research.citations");
    return {
      ok: true,
      data: {
        usage:
          citationsSkill?.cliHelp ??
          "northstar research citations ID [--source NAME] [--limit N] [--cursor CURSOR] [--json|--agent]",
        commandId: "research.citations",
        skill: citationsSkill?.skillPath,
      },
    };
  }
  if (args[0] === "paper") return researchPaperCommand(args.slice(1), env);
  if (args[0] === "citations")
    return researchCitationsCommand(args.slice(1), env);
  if (args[0] !== "search")
    return errorResult("unknown_command", `Usage: ${usage}`);
  let source: string | undefined;
  let limit: number | undefined;
  let yearFrom: number | undefined;
  let cursor: string | undefined;
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (
      arg === "--source" ||
      arg === "--limit" ||
      arg === "--year-from" ||
      arg === "--cursor"
    ) {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      if (arg === "--source") source = value;
      else if (arg === "--cursor") cursor = value;
      else if (arg === "--limit") {
        if (!/^\d+$/.test(value))
          return errorResult("invalid_usage", "--limit requires an integer");
        limit = Number(value);
        if (!Number.isSafeInteger(limit) || limit < 1)
          return errorResult(
            "invalid_usage",
            "--limit requires an integer >= 1",
          );
      } else {
        if (!/^\d+$/.test(value))
          return errorResult("invalid_usage", "--year-from requires a year");
        yearFrom = Number(value);
        if (
          !Number.isSafeInteger(yearFrom) ||
          yearFrom < 1000 ||
          yearFrom > 2200
        )
          return errorResult(
            "invalid_usage",
            "--year-from requires a four-digit year",
          );
      }
    } else if (arg?.startsWith("--"))
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    else if (arg !== undefined) positional.push(arg);
  }
  if (positional.length !== 1)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  return runCommandResult(async () => {
    const { executeResearchSearch } = await import("../commands/research-search-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeResearchSearch({
      query: positional[0],
      ...(source !== undefined ? { source } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(yearFrom !== undefined ? { yearFrom } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
    }, createCommandContext({ surface: "cli", env }));
  }, mode);
}

interface CommandFlagSpec {
  usage: string;
  values?: readonly string[];
  booleans?: readonly string[];
  integers?: readonly string[];
  minPositional?: number;
  maxPositional?: number;
  validate?: (context: {
    seen: Set<string>;
    mode: "human" | "json" | "agent";
    values: Map<string, string>;
    booleans: Set<string>;
    integers: Map<string, number>;
    positional: string[];
  }) => CliResult | undefined;
}

function parseCommandFlags(
  args: string[],
  spec: CommandFlagSpec,
):
  | {
      ok: true;
      mode: "human" | "json" | "agent";
      values: Map<string, string>;
      booleans: Set<string>;
      integers: Map<string, number>;
      positional: string[];
    }
  | { ok: false; error: CliResult } {
  const seen = new Set<string>();
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  const integers = new Map<string, number>();
  let mode: "human" | "json" | "agent" = "human";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return { ok: false, error: errorResult("invalid_usage", `Duplicate flag: ${arg}`) };
      seen.add(arg);
      if (mode !== "human")
        return { ok: false, error: errorResult("invalid_usage", "Only one output mode may be selected") };
      mode = arg === "--json" ? "json" : "agent";
    } else if (spec.booleans?.includes(arg)) {
      if (seen.has(arg))
        return { ok: false, error: errorResult("invalid_usage", `Duplicate flag: ${arg}`) };
      seen.add(arg);
      booleans.add(arg);
    } else if (spec.values?.includes(arg)) {
      if (seen.has(arg))
        return { ok: false, error: errorResult("invalid_usage", `Duplicate flag: ${arg}`) };
      seen.add(arg);
      const val = args[++i];
      if (val === undefined || val.startsWith("--"))
        return { ok: false, error: errorResult("invalid_usage", `${arg} requires a value`) };
      values.set(arg, val);
    } else if (spec.integers?.includes(arg)) {
      if (seen.has(arg))
        return { ok: false, error: errorResult("invalid_usage", `Duplicate flag: ${arg}`) };
      seen.add(arg);
      const val = args[++i];
      if (val === undefined || val.startsWith("--"))
        return { ok: false, error: errorResult("invalid_usage", `${arg} requires a value`) };
      if (!/^\d+$/.test(val))
        return { ok: false, error: errorResult("invalid_usage", `${arg} requires an integer`) };
      const parsed = Number(val);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        return { ok: false, error: errorResult("invalid_usage", `${arg} requires an integer >= 1`) };
      integers.set(arg, parsed);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: errorResult("unknown_flag", `Unknown flag: ${arg}`) };
    } else {
      if (spec.maxPositional === 0) {
        return { ok: false, error: errorResult("invalid_usage", `Unexpected argument: ${arg}`) };
      }
      positional.push(arg);
    }
  }

  const minPos = spec.minPositional ?? (spec.maxPositional ?? 1);
  const maxPos = spec.maxPositional ?? 1;
  if (positional.length < minPos || positional.length > maxPos) {
    return { ok: false, error: errorResult("invalid_usage", `Usage: ${spec.usage}`) };
  }

  const customError = spec.validate?.({ seen, mode, values, booleans, integers, positional });
  if (customError !== undefined) return { ok: false, error: customError };

  return { ok: true, mode, values, booleans, integers, positional };
}

function parseOwnerRepo(arg: string | undefined): { ok: true; owner: string; repo: string } | { ok: false; error: CliResult } {
  const match = arg?.match(/^([^/]+)\/([^/]+)$/);
  if (!match) return { ok: false, error: errorResult("invalid_usage", "OWNER/REPO required") };
  return { ok: true, owner: match[1]!, repo: match[2]! };
}

async function runCommandResult(
  execute: () => Promise<{ details?: unknown }>,
  mode: "human" | "json" | "agent",
): Promise<CliResult> {
  try {
    const { renderCommandResult } = await import("../commands/command-render.js");
    const result = await execute();
    const commandResult = (result.details as Record<string, unknown> | undefined)
      ?.northstarCommand as { outcome?: string } | undefined;
    const rendered = renderCommandResult(commandResult as never, mode);
    if (
      commandResult?.outcome === "failed" ||
      commandResult?.outcome === "cancelled"
    ) {
      return { ok: false, data: rendered };
    }
    return { ok: true, data: rendered };
  } catch (error) {
    const commandResult = (error as { commandResult?: unknown })?.commandResult;
    if (commandResult !== undefined) {
      const { renderCommandResult } = await import("../commands/command-render.js");
      return {
        ok: false,
        data: renderCommandResult(commandResult as never, mode),
      };
    }
    return cliToolError(error);
  }
}

async function githubSearchCommand(
  action: "search" | "search_repos",
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const canonical = action === "search" ? "search" : "search-repos";
  const usage = `northstar github ${canonical} QUERY [--language LANG] [--limit N] [--json|--agent]`;
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--language"],
    integers: ["--limit"],
  });
  if (!parsed.ok) return parsed.error;

  const requestArgs: Record<string, unknown> = { query: parsed.positional[0] };
  const language = parsed.values.get("--language");
  if (language !== undefined) requestArgs.language = language;
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  return runCommandResult(async () => {
    const { createCommandContext } = await import("../commands/command-context.js");
    const ctx = createCommandContext({ surface: "cli", env });
    if (action === "search") {
      const { executeGithubSearch } = await import("../commands/github-search-handler.js");
      return executeGithubSearch(requestArgs, ctx);
    }
    const { executeGithubSearchRepos } = await import("../commands/github-search-repos-handler.js");
    return executeGithubSearchRepos(requestArgs, ctx);
  }, parsed.mode);
}

async function githubIssuesCommand(
  action: "issues" | "pulls",
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    action === "issues"
      ? "northstar github issues OWNER/REPO [--number N] [--state open|closed|all] [--labels a,b] [--limit N] [--cursor CURSOR] [--json|--agent]"
      : "northstar github pulls OWNER/REPO [--number N] [--state open|closed|all] [--files] [--limit N] [--cursor CURSOR] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--state", "--cursor", "--labels"],
    integers: ["--number", "--limit"],
    booleans: ["--files"],
    validate: ({ values, booleans }) => {
      if (booleans.has("--files") && action !== "pulls") {
        return errorResult(
          "invalid_usage",
          "--files is only supported for github pulls",
        );
      }
      if (values.has("--labels")) {
        if (action !== "issues") {
          return errorResult(
            "invalid_usage",
            "--labels is only supported for github issues",
          );
        }
        const raw = values.get("--labels")!;
        const parts = raw
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        if (parts.length === 0) {
          return errorResult("invalid_usage", "--labels requires a value");
        }
      }
      return undefined;
    },
  });
  if (!parsed.ok) return parsed.error;

  const ownerRepo = parseOwnerRepo(parsed.positional[0]);
  if (!ownerRepo.ok) return ownerRepo.error;

  const requestArgs: Record<string, unknown> = {
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
  const number = parsed.integers.get("--number");
  if (number !== undefined) requestArgs.number = number;
  const state = parsed.values.get("--state");
  if (state !== undefined) requestArgs.state = state;
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  const cursor = parsed.values.get("--cursor");
  if (cursor !== undefined) requestArgs.cursor = cursor;
  if (parsed.booleans.has("--files")) requestArgs.files = true;
  const rawLabels = parsed.values.get("--labels");
  if (rawLabels !== undefined) {
    requestArgs.labels = rawLabels
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return runCommandResult(async () => {
    const ctx = (await import("../commands/command-context.js")).createCommandContext({ surface: "cli", env });
    if (action === "issues") {
      const { executeGithubIssues } = await import("../commands/github-issues-handler.js");
      return executeGithubIssues(requestArgs, ctx);
    }
    const { executeGithubPulls } = await import("../commands/github-pulls-handler.js");
    return executeGithubPulls(requestArgs, ctx);
  }, parsed.mode);
}

async function githubReleasesCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar github releases OWNER/REPO [--tag TAG] [--latest] [--limit N] [--cursor CURSOR] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--tag", "--cursor"],
    integers: ["--limit"],
    booleans: ["--latest"],
  });
  if (!parsed.ok) return parsed.error;

  const ownerRepo = parseOwnerRepo(parsed.positional[0]);
  if (!ownerRepo.ok) return ownerRepo.error;

  const requestArgs: Record<string, unknown> = {
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
  const tag = parsed.values.get("--tag");
  if (tag !== undefined) requestArgs.tag = tag;
  if (parsed.booleans.has("--latest")) requestArgs.latest = true;
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  const cursor = parsed.values.get("--cursor");
  if (cursor !== undefined) requestArgs.cursor = cursor;
  return runCommandResult(async () => {
    const { executeGithubReleases } = await import("../commands/github-releases-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeGithubReleases(
      requestArgs,
      createCommandContext({ surface: "cli", env }),
    );
  }, parsed.mode);
}

async function githubCommitsCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar github commits OWNER/REPO [--sha SHA] [--path PATH] [--branch BRANCH] [--ref REF] [--author AUTHOR] [--since SINCE] [--limit N] [--cursor CURSOR] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: [
      "--sha",
      "--path",
      "--branch",
      "--ref",
      "--author",
      "--since",
      "--cursor",
    ],
    integers: ["--limit"],
  });
  if (!parsed.ok) return parsed.error;

  const ownerRepo = parseOwnerRepo(parsed.positional[0]);
  if (!ownerRepo.ok) return ownerRepo.error;

  const requestArgs: Record<string, unknown> = {
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
  for (const flag of [
    "--sha",
    "--path",
    "--branch",
    "--ref",
    "--author",
    "--since",
    "--cursor",
  ]) {
    const val = parsed.values.get(flag);
    if (val !== undefined) requestArgs[flag.slice(2)] = val;
  }
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  return runCommandResult(async () => {
    const { executeGithubCommits } = await import("../commands/github-commits-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeGithubCommits(
      requestArgs,
      createCommandContext({ surface: "cli", env }),
    );
  }, parsed.mode);
}

async function githubWorkflowsCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar github workflows OWNER/REPO [--workflow WORKFLOW] [--limit N] [--cursor CURSOR] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--workflow", "--cursor"],
    integers: ["--limit"],
  });
  if (!parsed.ok) return parsed.error;

  const ownerRepo = parseOwnerRepo(parsed.positional[0]);
  if (!ownerRepo.ok) return ownerRepo.error;

  const requestArgs: Record<string, unknown> = {
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
  const workflow = parsed.values.get("--workflow");
  if (workflow !== undefined) requestArgs.workflow = workflow;
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  const cursor = parsed.values.get("--cursor");
  if (cursor !== undefined) requestArgs.cursor = cursor;
  return runCommandResult(async () => {
    const { executeGithubWorkflows } = await import("../commands/github-workflows-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeGithubWorkflows(
      requestArgs,
      createCommandContext({ surface: "cli", env }),
    );
  }, parsed.mode);
}

async function githubRunsCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar github runs OWNER/REPO [--number N] [--jobs] [--workflow WORKFLOW] [--branch BRANCH] [--status STATUS] [--author AUTHOR] [--limit N] [--cursor CURSOR] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--workflow", "--branch", "--status", "--author", "--cursor"],
    integers: ["--number", "--limit"],
    booleans: ["--jobs"],
  });
  if (!parsed.ok) return parsed.error;

  const ownerRepo = parseOwnerRepo(parsed.positional[0]);
  if (!ownerRepo.ok) return ownerRepo.error;

  const requestArgs: Record<string, unknown> = {
    owner: ownerRepo.owner,
    repo: ownerRepo.repo,
  };
  const number = parsed.integers.get("--number");
  if (number !== undefined) requestArgs.number = number;
  if (parsed.booleans.has("--jobs")) requestArgs.jobs = true;
  for (const flag of [
    "--workflow",
    "--branch",
    "--status",
    "--author",
    "--cursor",
  ]) {
    const val = parsed.values.get(flag);
    if (val !== undefined) requestArgs[flag.slice(2)] = val;
  }
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  return runCommandResult(async () => {
    const { executeGithubRuns } = await import("../commands/github-runs-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeGithubRuns(
      requestArgs,
      createCommandContext({ surface: "cli", env }),
    );
  }, parsed.mode);
}

async function githubTrendingCommand(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const usage =
    "northstar github trending [--since SINCE] [--limit N] [--json|--agent]";
  const parsed = parseCommandFlags(args, {
    usage,
    values: ["--since"],
    integers: ["--limit"],
    maxPositional: 0,
    minPositional: 0,
  });
  if (!parsed.ok) return parsed.error;

  const requestArgs: Record<string, unknown> = {};
  const since = parsed.values.get("--since");
  if (since !== undefined) requestArgs.since = since;
  const limit = parsed.integers.get("--limit");
  if (limit !== undefined) requestArgs.limit = limit;
  return runCommandResult(async () => {
    const { executeGithubTrending } = await import("../commands/github-trending-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeGithubTrending(
      requestArgs,
      createCommandContext({ surface: "cli", env }),
    );
  }, parsed.mode);
}

async function socialCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === undefined
  ) {
    return {
      ok: true,
      data: {
        usage: SOCIAL_SEARCH_USAGE + "\n" + SOCIAL_READ_USAGE,
        commandId: "social.search",
        skill: domainSkill("social.search")?.skillPath,
      },
    };
  }
  if (subcommand !== "search" && subcommand !== "read")
    return errorResult(
      "unknown_command",
      "Usage: northstar social <search|read>",
    );
  const commandId = subcommand === "search" ? "social.search" : "social.read";
  const usage =
    subcommand === "search" ? SOCIAL_SEARCH_USAGE : SOCIAL_READ_USAGE;
  const skill = domainSkill(commandId);
  if (args[1] === "--help" || args[1] === "-h")
    return { ok: true, data: { usage, commandId, skill: skill?.skillPath } };
  const requestArgs: Record<string, unknown> = {};
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--include-replies") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      requestArgs.includeReplies = true;
    } else if (arg === "--limit") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", "--limit requires a value");
      if (!/^\d+$/.test(value))
        return errorResult("invalid_usage", "--limit requires an integer");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        return errorResult("invalid_usage", "--limit requires an integer >= 1");
      requestArgs.limit = parsed;
    } else if (arg !== undefined && arg in SOCIAL_VALUE_FLAGS) {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      requestArgs[SOCIAL_VALUE_FLAGS[arg] as string] = value;
    } else if (arg?.startsWith("--"))
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    else if (arg !== undefined) positional.push(arg);
  }
  if (positional.length > 0)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  if (subcommand === "read" && !seen.has("--action"))
    return errorResult("invalid_usage", "--action is required for social read");
  if (requestArgs.platform === undefined)
    return errorResult("invalid_usage", "--platform is required");
  if (subcommand === "search" && requestArgs.query === undefined)
    return errorResult(
      "invalid_usage",
      "--query is required for social search",
    );
  if (subcommand === "search" && seen.has("--action"))
    return errorResult(
      "invalid_usage",
      "--action is only supported for social read",
    );
  if (subcommand === "search") requestArgs.action = "search";
  return runCommandResult(async () => {
    const { executeSocialSearch } = await import("../commands/social-search-handler.js");
    const { executeSocialRead } = await import("../commands/social-read-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    const context = createCommandContext({ surface: "cli", env });
    return subcommand === "search"
      ? executeSocialSearch(requestArgs, context)
      : executeSocialRead(requestArgs, context);
  }, mode);
}

async function mediaCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === undefined
  ) {
    return {
      ok: true,
      data: {
        usage:
          MEDIA_SEARCH_USAGE +
          "\n" +
          MEDIA_HOT_USAGE +
          "\n" +
          MEDIA_DETAILS_USAGE +
          "\n" +
          MEDIA_TRANSCRIPT_USAGE +
          "\n" +
          MEDIA_FEED_USAGE,
        commandId: "media.details",
        skill: domainSkill("media.details")?.skillPath,
      },
    };
  }
  if (
    !["search", "hot", "details", "transcript", "feed"].includes(
      subcommand ?? "",
    )
  )
    return errorResult(
      "unknown_command",
      "Usage: northstar media <search|hot|details|transcript|feed>",
    );
  const commandId =
    subcommand === "search"
      ? "media.search"
      : subcommand === "hot"
        ? "media.hot"
        : subcommand === "details"
          ? "media.details"
          : subcommand === "transcript"
            ? "media.transcript"
            : "media.feed";
  const usage =
    subcommand === "search"
      ? MEDIA_SEARCH_USAGE
      : subcommand === "hot"
        ? MEDIA_HOT_USAGE
        : subcommand === "details"
          ? MEDIA_DETAILS_USAGE
          : subcommand === "transcript"
            ? MEDIA_TRANSCRIPT_USAGE
            : MEDIA_FEED_USAGE;
  const skill = domainSkill(commandId);
  if (args[1] === "--help" || args[1] === "-h")
    return { ok: true, data: { usage, commandId, skill: skill?.skillPath } };
  const requestArgs: Record<string, unknown> = { action: subcommand };
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--limit") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", "--limit requires a value");
      if (!/^\d+$/.test(value))
        return errorResult("invalid_usage", "--limit requires an integer");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1)
        return errorResult("invalid_usage", "--limit requires an integer >= 1");
      requestArgs.limit = parsed;
    } else if (arg !== undefined && arg in MEDIA_VALUE_FLAGS) {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      requestArgs[MEDIA_VALUE_FLAGS[arg] as string] = value;
    } else if (arg?.startsWith("--"))
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    else if (arg !== undefined) positional.push(arg);
  }
  if (positional.length > 0)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  // Range checks stay in the contract: the CLI accepts any integer >= 1 and
  // the handler rejects out-of-range limits instead of clamping.
  if (subcommand === "search" && requestArgs.query === undefined)
    return errorResult("invalid_usage", "--query is required for media search");
  if (subcommand === "feed") {
    if (requestArgs.url === undefined)
      return errorResult("invalid_usage", "--url is required for media feed");
  } else {
    if (requestArgs.platform === undefined)
      return errorResult("invalid_usage", "--platform is required");
    if (
      subcommand !== "hot" &&
      subcommand !== "search" &&
      requestArgs.id === undefined &&
      requestArgs.url === undefined
    )
      return errorResult("invalid_usage", "one of --id or --url is required");
  }
  return runCommandResult(async () => {
    const { executeMediaSearch } = await import("../commands/media-search-handler.js");
    const { executeMediaHot } = await import("../commands/media-hot-handler.js");
    const { executeMediaDetails } = await import("../commands/media-details-handler.js");
    const { executeMediaTranscript } = await import("../commands/media-transcript-handler.js");
    const { executeMediaFeed } = await import("../commands/media-feed-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    const context = createCommandContext({ surface: "cli", env });
    if (subcommand === "search") return executeMediaSearch(requestArgs, context);
    if (subcommand === "hot") return executeMediaHot(requestArgs, context);
    if (subcommand === "details") return executeMediaDetails(requestArgs, context);
    if (subcommand === "transcript") return executeMediaTranscript(requestArgs, context);
    return executeMediaFeed(requestArgs, context);
  }, mode);
}

const KG_SEARCH_USAGE =
  "northstar kg search QUERY [--limit N] [--cursor CURSOR] [--json|--agent]";
const KG_ENHANCE_USAGE =
  "northstar kg enhance --type Person|Organization [--id ID] [--name NAME] [--url URL] [--email EMAIL] [--phone PHONE] [--location LOCATION] [--description TEXT] [--employer EMPLOYER] [--title TITLE] [--school SCHOOL] [--fields basic|contact|professional|all] [--max-entities N] [--include-relationships] [--include-evidence] [--confidence-threshold F] [--json|--agent]";

const KG_ENHANCE_VALUE_FLAGS: Readonly<Record<string, string>> = {
  "--type": "type",
  "--id": "id",
  "--name": "name",
  "--url": "url",
  "--email": "email",
  "--phone": "phone",
  "--location": "location",
  "--description": "description",
  "--employer": "employer",
  "--title": "title",
  "--school": "school",
  "--fields": "fields",
  "--max-entities": "maxEntities",
  "--confidence-threshold": "confidenceThreshold",
};

async function kgCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === undefined
  ) {
    return {
      ok: true,
      data: {
        usage: KG_SEARCH_USAGE + "\n" + KG_ENHANCE_USAGE,
        commandId: "kg.search",
        skill: domainSkill("kg.search")?.skillPath,
      },
    };
  }
  if (subcommand !== "search" && subcommand !== "enhance")
    return errorResult(
      "unknown_command",
      "Usage: northstar kg <search|enhance>",
    );
  const commandId = subcommand === "search" ? "kg.search" : "kg.enhance";
  const usage = subcommand === "search" ? KG_SEARCH_USAGE : KG_ENHANCE_USAGE;
  const skill = domainSkill(commandId);
  if (args[1] === "--help" || args[1] === "-h")
    return { ok: true, data: { usage, commandId, skill: skill?.skillPath } };
  // Narrow single-provider slice only: providers/cursor/maxProviders fanout has
  // no CLI flags and rejects in the handler instead of clamping. Range checks
  // stay in the contract: the CLI accepts integers and the handler rejects
  // out-of-range values.
  const requestArgs: Record<string, unknown> = { action: subcommand };
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  const parseValue = (arg: string, i: number): string | CliResult => {
    const value = args[i + 1];
    if (value === undefined || value.startsWith("--"))
      return errorResult("invalid_usage", `${arg} requires a value`);
    return value;
  };
  if (subcommand === "search") {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json" || arg === "--agent") {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        if (mode !== "human")
          return errorResult(
            "invalid_usage",
            "Only one output mode may be selected",
          );
        mode = arg === "--json" ? "json" : "agent";
      } else if (arg === "--cursor") {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        const value = parseValue(arg, i);
        if (typeof value !== "string") return value;
        i++;
        requestArgs.cursor = value;
      } else if (arg === "--limit") {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        const value = parseValue(arg, i);
        if (typeof value !== "string") return value;
        i++;
        if (!/^\d+$/.test(value))
          return errorResult("invalid_usage", "--limit requires an integer");
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1)
          return errorResult(
            "invalid_usage",
            "--limit requires an integer >= 1",
          );
        requestArgs.limit = parsed;
      } else if (arg?.startsWith("--"))
        return errorResult("unknown_flag", `Unknown flag: ${arg}`);
      else if (arg !== undefined) positional.push(arg);
    }
    if (positional.length !== 1)
      return errorResult("invalid_usage", `Usage: ${usage}`);
    requestArgs.query = positional[0];
  } else {
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--json" || arg === "--agent") {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        if (mode !== "human")
          return errorResult(
            "invalid_usage",
            "Only one output mode may be selected",
          );
        mode = arg === "--json" ? "json" : "agent";
      } else if (
        arg === "--include-relationships" ||
        arg === "--include-evidence"
      ) {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        requestArgs[
          arg === "--include-relationships"
            ? "includeRelationships"
            : "includeEvidence"
        ] = true;
      } else if (arg === "--max-entities") {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        const value = parseValue(arg, i);
        if (typeof value !== "string") return value;
        i++;
        if (!/^\d+$/.test(value))
          return errorResult(
            "invalid_usage",
            "--max-entities requires an integer",
          );
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1)
          return errorResult(
            "invalid_usage",
            "--max-entities requires an integer >= 1",
          );
        requestArgs.maxEntities = parsed;
      } else if (arg !== undefined && arg in KG_ENHANCE_VALUE_FLAGS) {
        if (seen.has(arg))
          return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
        seen.add(arg);
        const value = parseValue(arg, i);
        if (typeof value !== "string") return value;
        i++;
        if (arg === "--confidence-threshold") {
          const parsed = Number(value);
          if (!Number.isFinite(parsed))
            return errorResult(
              "invalid_usage",
              "--confidence-threshold requires a number",
            );
          requestArgs.confidenceThreshold = parsed;
        } else {
          requestArgs[KG_ENHANCE_VALUE_FLAGS[arg] as string] = value;
        }
      } else if (arg?.startsWith("--"))
        return errorResult("unknown_flag", `Unknown flag: ${arg}`);
      else if (arg !== undefined) positional.push(arg);
    }
    if (positional.length > 0)
      return errorResult("invalid_usage", `Usage: ${usage}`);
    if (requestArgs.type === undefined)
      return errorResult(
        "invalid_usage",
        "--type Person|Organization is required for kg enhance",
      );
  }
  return runCommandResult(async () => {
    const { executeKgSearch } = await import("../commands/kg-search-handler.js");
    const { executeKgEnhance } = await import("../commands/kg-enhance-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    const context = createCommandContext({ surface: "cli", env });
    return subcommand === "search"
      ? executeKgSearch(requestArgs, context)
      : executeKgEnhance(requestArgs, context);
  }, mode);
}

const GRAPH_QUERY_USAGE =
  "northstar graph query --language dql|sparql --query QUERY [--page-size N] [--cursor CURSOR] [--json|--agent]";
const GRAPH_PROBE_USAGE =
  "northstar graph probe --language dql|sparql --query QUERY [--query QUERY ...] [--json|--agent]";

async function graphCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (
    subcommand === "--help" ||
    subcommand === "-h" ||
    subcommand === undefined
  ) {
    return {
      ok: true,
      data: {
        usage: GRAPH_QUERY_USAGE + "\n" + GRAPH_PROBE_USAGE,
        commandId: "graph.query",
        skill: domainSkill("graph.query")?.skillPath,
      },
    };
  }
  if (subcommand !== "query" && subcommand !== "probe")
    return errorResult(
      "unknown_command",
      "Usage: northstar graph <query|probe>",
    );
  const commandId = subcommand === "query" ? "graph.query" : "graph.probe";
  const usage = subcommand === "query" ? GRAPH_QUERY_USAGE : GRAPH_PROBE_USAGE;
  const skill = domainSkill(commandId);
  if (args[1] === "--help" || args[1] === "-h")
    return { ok: true, data: { usage, commandId, skill: skill?.skillPath } };
  const requestArgs: Record<string, unknown> = { action: subcommand };
  const queries: string[] = [];
  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (
      arg === "--language" ||
      arg === "--query" ||
      arg === "--page-size" ||
      arg === "--cursor"
    ) {
      if (arg !== "--query" && seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      if (arg !== "--query") seen.add(arg);
      if (
        subcommand === "probe" &&
        (arg === "--page-size" || arg === "--cursor")
      ) {
        return errorResult(
          "invalid_usage",
          `${arg} is only supported for graph query`,
        );
      }
      const value = args[++i];
      if (value === undefined || value.startsWith("--"))
        return errorResult("invalid_usage", `${arg} requires a value`);
      if (arg === "--language") requestArgs.language = value;
      else if (arg === "--query") queries.push(value);
      else if (arg === "--cursor") requestArgs.cursor = value;
      else {
        if (!/^\d+$/.test(value))
          return errorResult(
            "invalid_usage",
            "--page-size requires an integer",
          );
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1)
          return errorResult(
            "invalid_usage",
            "--page-size requires an integer >= 1",
          );
        requestArgs.pageSize = parsed;
      }
    } else if (arg?.startsWith("--"))
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    else if (arg !== undefined) positional.push(arg);
  }
  if (positional.length > 0)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  if (requestArgs.language === undefined)
    return errorResult("invalid_usage", "--language dql|sparql is required");
  if (queries.length === 0)
    return errorResult("invalid_usage", "--query is required");
  if (subcommand === "query") {
    if (queries.length > 1)
      return errorResult(
        "invalid_usage",
        "graph query accepts exactly one --query",
      );
    requestArgs.query = queries[0];
  } else {
    requestArgs.queries = queries;
  }
  return runCommandResult(async () => {
    const { executeGraphQuery } = await import("../commands/graph-query-handler.js");
    const { executeGraphProbe } = await import("../commands/graph-probe-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    const context = createCommandContext({ surface: "cli", env });
    return subcommand === "query"
      ? executeGraphQuery(requestArgs, context)
      : executeGraphProbe(requestArgs, context);
  }, mode);
}

async function fetchCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const skill = domainSkill("fetch.read");
  const usage =
    skill?.cliHelp ??
    "northstar fetch URL [--query QUERY] [--top-k N] [--max-chars N] [--site-map] [--max-pages N] [--response-id ID] [--find-text TEXT] [--offset N] [--limit N] [--claim CLAIM ...] [--json|--agent]";
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    return {
      ok: true,
      data: { usage, commandId: "fetch.read", skill: skill?.skillPath },
    };
  }
  if (args[0] === "read" && (args[1] === "--help" || args[1] === "-h")) {
    return {
      ok: true,
      data: { usage, commandId: "fetch.read", skill: skill?.skillPath },
    };
  }
  const effectiveArgs = args[0] === "read" ? args.slice(1) : args;
  if (effectiveArgs.length === 0) {
    return {
      ok: true,
      data: { usage, commandId: "fetch.read", skill: skill?.skillPath },
    };
  }

  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  const claims: string[] = [];
  const requestArgs: Record<string, unknown> = {};

  const parseValue = (arg: string, i: number): string | CliResult => {
    const value = effectiveArgs[i + 1];
    if (value === undefined || value.startsWith("--"))
      return errorResult("invalid_usage", `${arg} requires a value`);
    return value;
  };

  for (let i = 0; i < effectiveArgs.length; i++) {
    const arg = effectiveArgs[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--site-map") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      requestArgs.siteMap = true;
    } else if (arg === "--claim") {
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      claims.push(val);
    } else if (
      arg === "--query" ||
      arg === "--response-id" ||
      arg === "--find-text" ||
      arg === "--source-ids"
    ) {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      if (arg === "--query") requestArgs.query = val;
      else if (arg === "--response-id") requestArgs.responseId = val;
      else if (arg === "--find-text") requestArgs.findText = val;
      else if (arg === "--source-ids")
        requestArgs.sourceIds = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
    } else if (
      arg === "--top-k" ||
      arg === "--max-chars" ||
      arg === "--max-pages" ||
      arg === "--offset" ||
      arg === "--limit"
    ) {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      if (!/^\d+$/.test(val))
        return errorResult("invalid_usage", `${arg} requires an integer`);
      const parsed = Number(val);
      if (!Number.isSafeInteger(parsed))
        return errorResult("invalid_usage", `${arg} requires a safe integer`);
      if (arg === "--top-k") requestArgs.topK = parsed;
      else if (arg === "--max-chars") requestArgs.maxChars = parsed;
      else if (arg === "--max-pages") requestArgs.maxPages = parsed;
      else if (arg === "--offset") requestArgs.offset = parsed;
      else if (arg === "--limit") requestArgs.limit = parsed;
    } else if (arg?.startsWith("--")) {
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  if (claims.length > 0) requestArgs.claims = claims;

  if (positional.length > 1)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  if (positional.length === 1) requestArgs.url = positional[0];
  if (positional.length === 0 && requestArgs.responseId === undefined) {
    return errorResult("invalid_usage", "URL or --response-id is required");
  }

  return runCommandResult(async () => {
    const { executeFetchRead } = await import("../commands/fetch-read-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeFetchRead(requestArgs, createCommandContext({ surface: "cli", env }));
  }, mode);
}

async function searchCommandResult(
  args: string[],
  env: Record<string, string | undefined>,
): Promise<CliResult> {
  const skill = domainSkill("search.web");
  const usage =
    skill?.cliHelp ??
    "northstar search QUERY [--limit N] [--include-content] [--recency RECENCY] [--domains D1,D2] [--year-from YEAR] [--json|--agent]";
  if (args[0] === "--help" || args[0] === "-h" || args.length === 0) {
    return {
      ok: true,
      data: { usage, commandId: "search.web", skill: skill?.skillPath },
    };
  }
  if (args[0] === "web" && (args[1] === "--help" || args[1] === "-h")) {
    return {
      ok: true,
      data: { usage, commandId: "search.web", skill: skill?.skillPath },
    };
  }
  const effectiveArgs = args[0] === "web" ? args.slice(1) : args;
  if (effectiveArgs.length === 0) {
    return {
      ok: true,
      data: { usage, commandId: "search.web", skill: skill?.skillPath },
    };
  }

  let mode: "human" | "json" | "agent" = "human";
  const seen = new Set<string>();
  const positional: string[] = [];
  const requestArgs: Record<string, unknown> = { action: "search" };

  const parseValue = (arg: string, i: number): string | CliResult => {
    const value = effectiveArgs[i + 1];
    if (value === undefined || value.startsWith("--"))
      return errorResult("invalid_usage", `${arg} requires a value`);
    return value;
  };

  for (let i = 0; i < effectiveArgs.length; i++) {
    const arg = effectiveArgs[i];
    if (arg === "--json" || arg === "--agent") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      if (mode !== "human")
        return errorResult(
          "invalid_usage",
          "Only one output mode may be selected",
        );
      mode = arg === "--json" ? "json" : "agent";
    } else if (arg === "--include-content") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      requestArgs.includeContent = true;
    } else if (arg === "--recency" || arg === "--category") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      if (arg === "--recency") requestArgs.recency = val;
      else if (arg === "--category") requestArgs.category = val;
    } else if (arg === "--domains") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      requestArgs.domains = val
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
    } else if (arg === "--limit" || arg === "--year-from") {
      if (seen.has(arg))
        return errorResult("invalid_usage", `Duplicate flag: ${arg}`);
      seen.add(arg);
      const val = parseValue(arg, i);
      if (typeof val !== "string") return val;
      i++;
      if (!/^\d+$/.test(val))
        return errorResult("invalid_usage", `${arg} requires an integer`);
      const parsed = Number(val);
      if (!Number.isSafeInteger(parsed))
        return errorResult("invalid_usage", `${arg} requires a safe integer`);
      if (arg === "--limit") requestArgs.limit = parsed;
      else if (arg === "--year-from") requestArgs.yearFrom = parsed;
    } else if (arg?.startsWith("--")) {
      return errorResult("unknown_flag", `Unknown flag: ${arg}`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }

  if (positional.length !== 1)
    return errorResult("invalid_usage", `Usage: ${usage}`);
  requestArgs.query = positional[0];

  return runCommandResult(async () => {
    const { executeSearchWeb } = await import("../commands/search-web-handler.js");
    const { createCommandContext } = await import("../commands/command-context.js");
    return executeSearchWeb(requestArgs, createCommandContext({ surface: "cli", env }));
  }, mode);
}

async function brokerCommandResult(
  args: string[],
  _env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (subcommand === "--help" || subcommand === "-h" || subcommand === undefined) {
    return {
      ok: true,
      data: {
        usage: BROKER_SERVE_USAGE,
        commandId: "broker.serve",
      },
    };
  }
  if (subcommand !== "serve") {
    return errorResult("unknown_command", "Usage: northstar broker <serve>");
  }
  if (args[1] === "--help" || args[1] === "-h") {
    return {
      ok: true,
      data: {
        usage: BROKER_SERVE_USAGE,
        commandId: "broker.serve",
      },
    };
  }

  const parsed = parseCommandFlags(args.slice(1), {
    usage: BROKER_SERVE_USAGE,
    values: ["--project-id", "--root-dir"],
    maxPositional: 0,
    minPositional: 0,
  });
  if (!parsed.ok) return parsed.error;

  const projectId = parsed.values.get("--project-id");
  if (projectId === undefined) {
    return errorResult("invalid_usage", "--project-id is required");
  }
  const rootDir = parsed.values.get("--root-dir");

  try {
    const { brokerServeCommand } = await import("../commands/broker-serve-handler.js");
    const { renderCommandResult } = await import("../commands/command-render.js");
    const result = await brokerServeCommand({
      projectId,
      ...(rootDir !== undefined ? { rootDir } : {}),
    });
    const rendered = renderCommandResult(result as never, parsed.mode);
    if (result.outcome === "failed" || result.outcome === "cancelled") {
      return { ok: false, data: rendered };
    }
    return { ok: true, data: rendered };
  } catch (error) {
    return cliToolError(error);
  }
}

async function jobsCommandResult(
  args: string[],
  _env: Record<string, string | undefined>,
): Promise<CliResult> {
  const subcommand = args[0];
  if (subcommand === "--help" || subcommand === "-h" || subcommand === undefined) {
    return {
      ok: true,
      data: {
        usage: JOBS_STATUS_USAGE,
        commandId: "jobs.status",
      },
    };
  }
  if (subcommand !== "status") {
    return errorResult("unknown_command", "Usage: northstar jobs <status>");
  }
  if (args[1] === "--help" || args[1] === "-h") {
    return {
      ok: true,
      data: {
        usage: JOBS_STATUS_USAGE,
        commandId: "jobs.status",
      },
    };
  }

  const parsed = parseCommandFlags(args.slice(1), {
    usage: JOBS_STATUS_USAGE,
    values: ["--project-id", "--request-id", "--root-dir"],
    maxPositional: 0,
    minPositional: 0,
  });
  if (!parsed.ok) return parsed.error;

  const projectId = parsed.values.get("--project-id");
  if (projectId === undefined) {
    return errorResult("invalid_usage", "--project-id is required");
  }
  const requestId = parsed.values.get("--request-id");
  if (requestId === undefined) {
    return errorResult("invalid_usage", "--request-id is required");
  }
  const rootDir = parsed.values.get("--root-dir");

  try {
    const { jobsStatusCommand } = await import("../commands/jobs-status-handler.js");
    const { renderCommandResult } = await import("../commands/command-render.js");
    const result = await jobsStatusCommand({
      projectId,
      requestId,
      ...(rootDir !== undefined ? { rootDir } : {}),
    });
    const rendered = renderCommandResult(result as never, parsed.mode);
    if (result.outcome === "failed" || result.outcome === "cancelled") {
      return { ok: false, data: rendered };
    }
    return { ok: true, data: rendered };
  } catch (error) {
    return cliToolError(error);
  }
}

function writeResult(result: CliResult): void {
  if (typeof result.data === "string") console.log(result.data);
  else console.log(JSON.stringify(result, null, 2));
}

async function cliEnvironment(
  args: string[],
): Promise<Record<string, string | undefined>> {
  const command = args[0];
  if (
    command === "help" ||
    command === "--help" ||
    command === "-h" ||
    command === "version" ||
    command === "--version" ||
    command === "-v" ||
    command === "domains" ||
    command === "capabilities" ||
    command === undefined
  )
    return process.env;
  const { loadSearchMcpEnvironment } = await import("../setup/local-config.js");
  return loadSearchMcpEnvironment(process.env, {
    allowLoginShellFallback: true,
  });
}

function isMainModule(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}
