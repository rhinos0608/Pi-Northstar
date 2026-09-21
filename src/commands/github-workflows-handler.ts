import { createGithubCommandHandler } from './github-commits-handler.js';

export const GITHUB_WORKFLOWS_COMMAND = 'github.workflows';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_WORKFLOWS_COMMAND,
  action: 'workflows',
  failureMessage: 'GitHub workflows request failed',
});

export const mapGithubWorkflowsCommandResult = bundle.mapResult;
export const executeGithubWorkflows = bundle.execute;
export const githubWorkflowsHandler = bundle.handler;
