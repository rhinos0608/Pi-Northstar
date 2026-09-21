import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_COMMITS_COMMAND = 'github.commits';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_COMMITS_COMMAND,
  action: 'commits',
  failureMessage: 'GitHub commits request failed',
});

export const mapGithubCommitsCommandResult = bundle.mapResult;
export const executeGithubCommits = bundle.execute;
export const githubCommitsHandler = bundle.handler;
