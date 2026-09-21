import type { CommandContext } from './command-context.js';
import { githubFileHandler } from './github-file-handler.js';
import { githubRepoHandler } from './github-repo-handler.js';
import { githubSearchHandler } from './github-search-handler.js';
import { githubSearchReposHandler } from './github-search-repos-handler.js';
import { githubIssuesHandler } from './github-issues-handler.js';
import { githubPullsHandler } from './github-pulls-handler.js';
import { githubReleasesHandler } from './github-releases-handler.js';
import { githubCommitsHandler } from './github-commits-handler.js';
import { githubTreeHandler } from './github-tree-handler.js';
import { githubTrendingHandler } from './github-trending-handler.js';
import { githubWorkflowsHandler } from './github-workflows-handler.js';
import { githubRunsHandler } from './github-runs-handler.js';
import { researchSearchHandler } from './research-search-handler.js';
import { researchPaperHandler } from './research-paper-handler.js';
import { researchCitationsHandler } from './research-citations-handler.js';
import { socialSearchHandler } from './social-search-handler.js';
import { socialReadHandler } from './social-read-handler.js';
import { mediaDetailsHandler } from './media-details-handler.js';
import { mediaTranscriptHandler } from './media-transcript-handler.js';
import { mediaFeedHandler } from './media-feed-handler.js';
import { mediaSearchHandler } from './media-search-handler.js';
import { mediaHotHandler } from './media-hot-handler.js';
import { kgSearchHandler } from './kg-search-handler.js';
import { kgEnhanceHandler } from './kg-enhance-handler.js';
import { graphQueryHandler } from './graph-query-handler.js';
import { graphProbeHandler } from './graph-probe-handler.js';
import { fetchReadHandler } from './fetch-read-handler.js';
import { searchWebHandler } from './search-web-handler.js';

export interface CommandHandler<T = unknown, R = unknown> {
  readonly commandId: string;
  execute(input: T, context: CommandContext): Promise<R>;
}

const BUILTIN_HANDLERS: readonly (readonly [string, CommandHandler])[] = [
  [githubFileHandler.commandId, githubFileHandler],
  [githubRepoHandler.commandId, githubRepoHandler],
  [githubSearchHandler.commandId, githubSearchHandler],
  [githubSearchReposHandler.commandId, githubSearchReposHandler],
  [githubIssuesHandler.commandId, githubIssuesHandler],
  [githubPullsHandler.commandId, githubPullsHandler],
  [githubReleasesHandler.commandId, githubReleasesHandler],
  [githubCommitsHandler.commandId, githubCommitsHandler],
  [githubTreeHandler.commandId, githubTreeHandler],
  [githubTrendingHandler.commandId, githubTrendingHandler],
  [githubWorkflowsHandler.commandId, githubWorkflowsHandler],
  [githubRunsHandler.commandId, githubRunsHandler],
  [researchSearchHandler.commandId, researchSearchHandler],
  [researchPaperHandler.commandId, researchPaperHandler],
  [researchCitationsHandler.commandId, researchCitationsHandler],
  [socialSearchHandler.commandId, socialSearchHandler],
  [socialReadHandler.commandId, socialReadHandler],
  [mediaDetailsHandler.commandId, mediaDetailsHandler],
  [mediaTranscriptHandler.commandId, mediaTranscriptHandler],
  [mediaFeedHandler.commandId, mediaFeedHandler],
  [mediaSearchHandler.commandId, mediaSearchHandler],
  [mediaHotHandler.commandId, mediaHotHandler],
  [kgSearchHandler.commandId, kgSearchHandler],
  [kgEnhanceHandler.commandId, kgEnhanceHandler],
  [graphQueryHandler.commandId, graphQueryHandler],
  [graphProbeHandler.commandId, graphProbeHandler],
  [fetchReadHandler.commandId, fetchReadHandler],
  [searchWebHandler.commandId, searchWebHandler],
];

const handlers = new Map<string, CommandHandler>(BUILTIN_HANDLERS as Iterable<readonly [string, CommandHandler]>);

export function registerCommand(handler: CommandHandler): void {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(handler.commandId)) throw new TypeError('invalid command id');
  if (handlers.has(handler.commandId)) throw new Error(`command already registered: ${handler.commandId}`);
  handlers.set(handler.commandId, handler);
}

export function commandHandler<T = unknown, R = unknown>(commandId: string): CommandHandler<T, R> {
  const handler = handlers.get(commandId);
  if (handler === undefined) throw new Error(`unknown command: ${commandId}`);
  return handler as CommandHandler<T, R>;
}

export function commandSurface(): readonly string[] { return [...handlers.keys()]; }
export function clearCommandRegistryForTests(): void {
  handlers.clear();
  for (const [id, handler] of BUILTIN_HANDLERS) {
    handlers.set(id, handler);
  }
}
