import type { AgentToolResult, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { resultToText, type SearchBackend } from '../backend.js';
import { guardText } from '../core/tool-output.js';
import { GITHUB_ACTIONS, GITHUB_RUN_STATUSES, GITHUB_ACTION_FIELD_SPECS, GITHUB_LABELS_MAX, GITHUB_LIST_LIMIT_MAX, GITHUB_TRENDING_LIMIT_MAX, type GithubAction, type GithubActionField } from './github-contract.js';

const fields: Record<GithubActionField, TSchema> = {
  owner: Type.String({ description: 'GitHub user or organisation.' }),
  repo: Type.String({ description: 'Repository name.' }),
  repository: Type.String({ description: 'owner/repo or GitHub URL.' }),
  path: Type.String({ description: 'File, directory, or workflow path.' }),
  paths: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: 'File paths (file only, 1-10).' }),
  branch: Type.String({ description: 'Git ref; agrees with ref when both set.' }),
  ref: Type.String({ description: 'Git ref; agrees with branch when both set.' }),
  recursive: Type.Boolean({ description: 'Full recursive tree.' }),
  includeReadme: Type.Boolean({ description: 'Raw README content.' }),
  query: Type.String({ description: 'GitHub search syntax.' }),
  language: Type.String({ description: 'Language.' }),
  limit: Type.Integer({ minimum: 1, maximum: GITHUB_LIST_LIMIT_MAX, description: `Max items (1-${GITHUB_LIST_LIMIT_MAX}).` }),
  perPage: Type.Integer({ minimum: 1, maximum: GITHUB_LIST_LIMIT_MAX, description: `Alias for limit; takes precedence (1-${GITHUB_LIST_LIMIT_MAX}).` }),
  number: Type.Integer({ minimum: 1, description: 'Issue, PR, or run number (positive integer).' }),
  sha: Type.String({ description: 'Commit SHA.' }),
  since: Type.String({ description: 'ISO date or trending window.' }),
  state: StringEnum(['open', 'closed', 'all'], { description: 'Issue/PR state.' }),
  labels: Type.Array(Type.String(), { maxItems: GITHUB_LABELS_MAX, description: 'Issue labels.' }),
  tag: Type.String({ description: 'Release tag.' }),
  latest: Type.Boolean({ description: 'Fetch latest release.' }),
  files: Type.Boolean({ description: 'Changed files for pull.' }),
  author: Type.String({ description: 'Commit author filter.' }),
  workflow: Type.String({ description: 'Workflow ID or file.' }),
  status: StringEnum([...GITHUB_RUN_STATUSES], { description: 'Workflow run status.' }),
  jobs: Type.Boolean({ description: 'Jobs for workflow run.' }),
  cursor: Type.String({ maxLength: 4096, description: 'Opaque continuation cursor.' }),
};

function limitCapForSchema(action: GithubAction): number {
  return action === 'trending' ? GITHUB_TRENDING_LIMIT_MAX : GITHUB_LIST_LIMIT_MAX;
}

function fileBranch(): TSchema {
  // file selector is XOR: exactly one of path / paths. Neither variant
  // names the other field, so additionalProperties:false rejects both-together
  // and neither. Mirrors validateGithubRequest file enforcement.
  const base: Record<string, TSchema> = {
    action: Type.Literal('file'),
    owner: Type.Optional(fields.owner),
    repo: Type.Optional(fields.repo),
    repository: Type.Optional(fields.repository),
    branch: Type.Optional(fields.branch!),
    ref: Type.Optional(fields.ref!),
  };
  const pathBody = Type.Object({ ...base, path: fields.path! }, { description: 'file operation.', additionalProperties: false });
  const pathsBody = Type.Object({ ...base, paths: fields.paths! }, { description: 'file operation.', additionalProperties: false });
  const selector = Type.Union([
    Type.Object({ owner: fields.owner, repo: fields.repo }),
    Type.Object({ repository: fields.repository }),
  ], { description: 'Repository: owner/repo or repository URL.' });
  return Type.Union([
    Type.Intersect([pathBody, selector], { description: 'file operation.' }),
    Type.Intersect([pathsBody, selector], { description: 'file operation.' }),
  ], { description: 'file operation.' });
}

function actionBranch(action: GithubAction): TSchema {
  if (action === 'file') return fileBranch();
  const spec = GITHUB_ACTION_FIELD_SPECS[action];
  const properties: Record<string, TSchema> = { action: Type.Literal(action) };
  const cap = limitCapForSchema(action);
  const limitSchema = Type.Integer({ minimum: 1, maximum: cap, description: `Max items (1-${cap}).` });
  const perPageSchema = Type.Integer({ minimum: 1, maximum: cap, description: `Alias for limit; takes precedence (1-${cap}).` });
  if (spec.repoSelector === true) {
    properties.owner = Type.Optional(fields.owner);
    properties.repo = Type.Optional(fields.repo);
    properties.repository = Type.Optional(fields.repository);
  }
  for (const field of [...spec.required, ...spec.optional]) {
    if (field === 'limit') properties[field] = Type.Optional(limitSchema);
    else if (field === 'perPage') properties[field] = Type.Optional(perPageSchema);
    else properties[field] = Type.Optional(fields[field]!);
  }
  for (const field of spec.required) properties[field] = fields[field]!;
  const body = Type.Object(properties, { description: `${action} operation.`, additionalProperties: false });
  if (!spec.repoSelector) return body;
  if (spec.repoSelector === 'optional') {
    const pairBody = Type.Object({ ...properties, owner: fields.owner, repo: fields.repo }, { description: `${action} operation.`, additionalProperties: false });
    const slugBody = Type.Object({ ...properties, repository: fields.repository }, { description: `${action} operation.`, additionalProperties: false });
    return Type.Union([body, pairBody, slugBody], { description: `${action} operation.` });
  }
  const selector = Type.Union([
    Type.Object({ owner: fields.owner, repo: fields.repo }),
    Type.Object({ repository: fields.repository }),
  ], { description: 'Repository: owner/repo or repository URL.' });
  return Type.Intersect([body, selector], { description: `${action} operation.` });
}

export function buildGithubParameters(): TSchema {
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
