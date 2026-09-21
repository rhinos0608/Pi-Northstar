import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_REPO_COMMAND = 'github.repo';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_REPO_COMMAND,
  action: 'repo',
  failureMessage: 'GitHub repository request failed',
});

export const mapGithubRepoCommandResult = bundle.mapResult;
export const executeGithubRepo = bundle.execute;
export const githubRepoHandler = bundle.handler;
