import { createGithubCommandHandler } from './github-commits-handler.js';

export const GITHUB_SEARCH_COMMAND = 'github.search';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_SEARCH_COMMAND,
  action: 'search',
  failureMessage: 'GitHub code search request failed',
});

export const mapGithubSearchCommandResult = bundle.mapResult;
export const executeGithubSearch = bundle.execute;
export const githubSearchHandler = bundle.handler;
