import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_RUNS_COMMAND = 'github.runs';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_RUNS_COMMAND,
  action: 'runs',
  failureMessage: 'GitHub runs request failed',
});

export const mapGithubRunsCommandResult = bundle.mapResult;
export const executeGithubRuns = bundle.execute;
export const githubRunsHandler = bundle.handler;
