import { createGithubCommandHandler } from './github-commits-handler.js';

export const GITHUB_PULLS_COMMAND = 'github.pulls';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_PULLS_COMMAND,
  action: 'pulls',
  failureMessage: 'GitHub pulls request failed',
});

export const mapGithubPullsCommandResult = bundle.mapResult;
export const executeGithubPulls = bundle.execute;
export const githubPullsHandler = bundle.handler;
