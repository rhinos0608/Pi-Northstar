import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_ISSUES_COMMAND = 'github.issues';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_ISSUES_COMMAND,
  action: 'issues',
  failureMessage: 'GitHub issues request failed',
});

export const mapGithubIssuesCommandResult = bundle.mapResult;
export const executeGithubIssues = bundle.execute;
export const githubIssuesHandler = bundle.handler;
