import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { resultToText, type SearchBackend } from '../backend.js';
import { guardText } from '../core/tool-output.js';
import { GITHUB_ACTIONS, GITHUB_RUN_STATUSES } from './github-contract.js';

// Canonical actions only: repo, file, tree, search, trending, issues, pulls,
// releases, commits, search_repos, workflows, runs. Legacy 'list_dir'/'code_search'
// are rejected as unsupported_action at runtime and never advertised here.

export function registerGitHubTool(pi: ExtensionAPI, client: SearchBackend, env?: Record<string, string | undefined>): void {
  pi.registerTool({
    name: 'github',
    label: 'GitHub',
    description:
      'Code facts via REST v3 only (no GraphQL): repo/file/tree/search/search_repos/trending/issues/pulls/releases/commits/workflows/runs. Use for repo metadata, file reads, trees, code search, trending, issues/pulls/releases/commits, GitHub Actions workflows and workflow runs (read-only, no dispatch/trigger); use web_search for non-GitHub discovery. GITHUB_TOKEN/GH_TOKEN optional for public reads (harder limits keyless). list_dir/code_search legacy spellings rejected; normalized entities; out-of-range rejected, never clamped.',
    promptSnippet:
      'Query GitHub repos, files, trees, code search, trending, issues, pulls, releases, commits, workflows, and workflow runs with normalized results. Prefer repository "owner/repo" or owner+repo; path xor paths (max 10, file only); branch must agree with ref.',
    parameters: Type.Object({
      action: StringEnum([...GITHUB_ACTIONS], {
        description:
          'Pick repo (metadata), file (reads), tree (listing), search/search_repos (code/repos), trending, issues, pulls, releases, commits, workflows, runs (GitHub Actions, read-only). Canonical only.',
      }),

      // -- repo / file / tree / issues / pulls / releases / commits selectors --
      owner: Type.Optional(Type.String({
        description: 'GitHub username or organisation.',
      })),
      repo: Type.Optional(Type.String({
        description: 'Repository name.',
      })),
      repository: Type.Optional(Type.String({
        description:
          'Repository as "owner/repo" string or GitHub URL. Alternative to owner+repo fields.',
      })),

      // -- file --
      path: Type.Optional(Type.String({
        description: 'File or directory path within the repo. Mutually exclusive with `paths`.',
      })),
      paths: Type.Optional(Type.Array(Type.String(), {
        description: 'Multiple file paths to read (file action only, max 10). Mutually exclusive with `path`.',
      })),

      // -- file / tree / commits ref selector --
      branch: Type.Optional(Type.String({
        description: 'Git ref (branch or tag). Must agree with `ref` when both are set.',
      })),
      ref: Type.Optional(Type.String({
        description: 'Git ref (branch, tag, or commit SHA). Must agree with `branch` when both are set.',
      })),

      // -- tree --
      recursive: Type.Optional(Type.Boolean({
        description: 'Return the full recursive tree (tree action only, default false).',
      })),

      // -- repo --
      includeReadme: Type.Optional(Type.Boolean({
        description: 'Fetch and include the raw README content (repo action only, default true).',
      })),

      // -- search / search_repos --
      query: Type.Optional(Type.String({
        description: 'Search term (GitHub search syntax). Required for search and search_repos.',
      })),
      language: Type.Optional(Type.String({
        description: 'Filter by language (e.g. "typescript", "python").',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Max items (lists max 50; trending max 25). Out-of-range rejected.',
      })),
      perPage: Type.Optional(Type.Number({
        description: 'Alias for limit (max 50). Wins when both set.',
      })),

      // -- issues / pulls --
      number: Type.Optional(Type.Number({
        description: 'Issue or pull request number. Set to fetch a single issue/pull (or its files with files=true).',
      })),
      state: Type.Optional(StringEnum(['open', 'closed', 'all'], {
        description: 'State filter for issues/pulls lists (default open).',
      })),
      labels: Type.Optional(Type.Array(Type.String(), {
        description: 'Label filter for issues lists (max 10).',
      })),

      // -- pulls --
      files: Type.Optional(Type.Boolean({
        description: 'List changed files for a single pull (pulls action with number only).',
      })),

      // -- workflows / runs --
      workflow: Type.Optional(Type.String({
        description: 'Workflow ID (numeric) or file name, e.g. "ci.yml" (workflows/runs actions).',
      })),
      status: Type.Optional(StringEnum([...GITHUB_RUN_STATUSES], {
        description: 'Filter workflow runs by status/conclusion (runs action).',
      })),
      jobs: Type.Optional(Type.Boolean({
        description: 'List jobs for a workflow run (runs action, requires `number`).',
      })),

      // -- releases --
      tag: Type.Optional(Type.String({
        description: 'Release tag. Set to fetch a single release by tag.',
      })),
      latest: Type.Optional(Type.Boolean({
        description: 'Fetch the latest release (releases action only).',
      })),

      // -- commits --
      sha: Type.Optional(Type.String({
        description: 'Commit SHA (7-40 hex). Set to fetch a single commit.',
      })),
      since: Type.Optional(Type.String({
        description: 'ISO date filter for commits lists; daily|weekly|monthly window for trending.',
      })),
      author: Type.Optional(Type.String({
        description: 'Author filter for commits lists (commits action only).',
      })),

      // -- pagination --
      cursor: Type.Optional(Type.String({
        maxLength: 4096,
        description: 'Opaque prior-list cursor. Pins action+owner/repo+limit; changing them invalidates.',
      })),
    }),

    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const { action, ...rest } = params;

      const args: Record<string, unknown> = { action };
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) {
          args[key] = value;
        }
      }

      const result = await client.callTool('github', args, {
        ...(signal ? { signal } : {}),
        timeout: 300_000,
      });

      return {
        content: [{ type: 'text', text: guardText(resultToText(result), { env }) }],
        details: result,
      };
    },
  });
}
