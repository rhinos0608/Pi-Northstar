import { createGithubCommandHandler } from './github-handler-factory.js';

export const GITHUB_RELEASES_COMMAND = 'github.releases';

const bundle = createGithubCommandHandler({
  commandId: GITHUB_RELEASES_COMMAND,
  action: 'releases',
  failureMessage: 'GitHub releases request failed',
});

export const mapGithubReleasesCommandResult = bundle.mapResult;
export const executeGithubReleases = bundle.execute;
export const githubReleasesHandler = bundle.handler;
