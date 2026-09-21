import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_FILE_COMMAND = 'github.file';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_FILE_COMMAND,
  action: 'file',
  failureMessage: 'GitHub file request failed',
});

export const mapGithubFileCommandResult = bundle.mapResult;
export const executeGithubFile = bundle.execute;
export const githubFileHandler = bundle.handler;
