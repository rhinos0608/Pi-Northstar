import { createGithubCommandHandler } from './github-commits-handler.js';

export const GITHUB_SEARCH_REPOS_COMMAND = 'github.search_repos';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_SEARCH_REPOS_COMMAND,
  action: 'search_repos',
  failureMessage: 'GitHub repository search request failed',
});

export const mapGithubSearchReposCommandResult = bundle.mapResult;
export const executeGithubSearchRepos = bundle.execute;
export const githubSearchReposHandler = bundle.handler;
