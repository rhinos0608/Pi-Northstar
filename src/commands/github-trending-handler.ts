import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_TRENDING_COMMAND = 'github.trending';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_TRENDING_COMMAND,
  action: 'trending',
  failureMessage: 'GitHub trending request failed',
});

export const mapGithubTrendingCommandResult = bundle.mapResult;
export const executeGithubTrending = bundle.execute;
export const githubTrendingHandler = bundle.handler;
