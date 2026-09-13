import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { resultToText, type SearchBackend } from '../backend.js';
import { guardText } from '../core/tool-output.js';
import { GITHUB_ACTIONS, GITHUB_RUN_STATUSES, GITHUB_ACTION_FIELD_SPECS, type GithubAction, type GithubActionField } from './github-contract.js';

const fields: Record<GithubActionField, TSchema> = {
  owner: Type.String({ description: 'GitHub user or organisation.' }),
  repo: Type.String({ description: 'Repository name.' }),
  repository: Type.String({ description: 'owner/repo or GitHub URL.' }),
  path: Type.String({ description: 'File, directory, or workflow path.' }),
  paths: Type.Array(Type.String(), { description: 'File paths (file only, max 10).' }),
  branch: Type.String({ description: 'Git ref; agrees with ref when both set.' }),
  ref: Type.String({ description: 'Git ref; agrees with branch when both set.' }),
  recursive: Type.Boolean({ description: 'Full recursive tree.' }),
  includeReadme: Type.Boolean({ description: 'Raw README content.' }),
  query: Type.String({ description: 'GitHub search syntax.' }),
  language: Type.String({ description: 'Language.' }),
  limit: Type.Number({ description: 'Max items.' }),
  perPage: Type.Number({ description: 'Alias for limit; takes precedence.' }),
  number: Type.Number({ description: 'Issue, PR, or run number.' }),
  sha: Type.String({ description: 'Commit SHA.' }),
  since: Type.String({ description: 'ISO date or trending window.' }),
  state: StringEnum(['open', 'closed', 'all'], { description: 'Issue/PR state.' }),
  labels: Type.Array(Type.String(), { description: 'Issue labels.' }),
  tag: Type.String({ description: 'Release tag.' }),
  latest: Type.Boolean({ description: 'Fetch latest release.' }),
  files: Type.Boolean({ description: 'Changed files for pull.' }),
  author: Type.String({ description: 'Commit author filter.' }),
  workflow: Type.String({ description: 'Workflow ID or file.' }),
  status: StringEnum([...GITHUB_RUN_STATUSES], { description: 'Workflow run status.' }),
  jobs: Type.Boolean({ description: 'Jobs for workflow run.' }),
  cursor: Type.String({ maxLength: 4096, description: 'Opaque continuation cursor.' }),
};

function actionBranch(action: GithubAction): TSchema {
  const spec = GITHUB_ACTION_FIELD_SPECS[action];
  const properties: Record<string, TSchema> = { action: Type.Literal(action) };
  if (spec.repoSelector) {
    properties.owner = Type.Optional(fields.owner);
    properties.repo = Type.Optional(fields.repo);
    properties.repository = Type.Optional(fields.repository);
  }
  for (const field of [...spec.required, ...spec.optional]) properties[field] = Type.Optional(fields[field]!);
  for (const field of spec.required) properties[field] = fields[field]!;
  const body = Type.Object(properties, { description: `${action} operation.`, additionalProperties: false });
  if (!spec.repoSelector) return body;
  const selector = Type.Union([
    Type.Object({ owner: fields.owner, repo: fields.repo }),
    Type.Object({ repository: fields.repository }),
  ], { description: 'Repository: owner/repo or repository URL.' });
  return Type.Intersect([body, selector], { description: `${action} operation.` });
}

function buildGithubParameters(): TSchema {
  return Type.Object({
    request: Type.Union(GITHUB_ACTIONS.map(actionBranch), { description: 'One canonical action request.' }),
  });
}

export function registerGitHubTool(pi: ExtensionAPI, client: SearchBackend, env?: Record<string, string | undefined>): void {
  pi.registerTool({
    name: 'github',
    label: 'GitHub',
    description: 'GitHub REST v3 read-only facts (no GraphQL). Legacy list_dir/code_search spellings rejected. GITHUB_TOKEN/GH_TOKEN optional for public reads.',
    promptSnippet: 'Read GitHub repositories, files, trees, searches, issues, pulls, releases, commits, workflows, and runs. Read-only.',
    parameters: buildGithubParameters(),
    async execute(_toolCallId, params, signal): Promise<AgentToolResult<unknown>> {
      const { request } = params as { request: Record<string, unknown> };
      const { action, ...rest } = request;
      const args: Record<string, unknown> = { action };
      for (const [key, value] of Object.entries(rest)) if (value !== undefined) args[key] = value;
      const result = await client.callTool('github', args, { ...(signal ? { signal } : {}), timeout: 300_000 });
      return { content: [{ type: 'text', text: guardText(resultToText(result), { env }) }], details: result };
    },
  });
}
