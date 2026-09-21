import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_TREE_COMMAND = 'github.tree';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_TREE_COMMAND,
  action: 'tree',
  failureMessage: 'GitHub tree request failed',
});

export const mapGithubTreeCommandResult = bundle.mapResult;
export const executeGithubTree = bundle.execute;
export const githubTreeHandler = bundle.handler;
