import {
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import { probeExistingBroker } from '../runtime/broker-host.js';

export const JOBS_STATUS_COMMAND = 'jobs.status';

export interface JobsStatusArgs {
  projectId: string;
  requestId: string;
  rootDir?: string;
}

export type CommandResult = NorthstarCommandResultV1;

function validateProjectId(projectId: unknown): string {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(projectId)) {
    throw Object.assign(new Error('Invalid projectId: must match ^[A-Za-z0-9._-]{1,96}$'), {
      code: 'invalid_input',
    });
  }
  return projectId;
}

function validateRequestId(requestId: unknown): string {
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw Object.assign(new Error('Invalid requestId: must match ^[A-Za-z0-9_-]{1,128}$'), {
      code: 'invalid_input',
    });
  }
  return requestId;
}

function buildResult(params: {
  outcome: NorthstarCommandResultV1['outcome'];
  retryability: NorthstarCommandResultV1['retryability'];
  data: Record<string, unknown> | null;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    category?: string;
  };
}): CommandResult {
  const result: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1',
    version: 1,
    commandId: JOBS_STATUS_COMMAND,
    invocationId: 'jobs-status',
    outcome: params.outcome,
    retryability: params.retryability,
    data: params.data,
    sources: [{ kind: 'internal', name: 'broker-host' }],
    trust: 'internal',
    requestedSurface: 'cli',
    resolvedSurface: JOBS_STATUS_COMMAND,
    attemptedSurfaces: ['cli', JOBS_STATUS_COMMAND],
    sideEffect: { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [],
    nextActions: [],
    ...(params.error ? { error: params.error } : {}),
  };

  const validation = validateCommandResult(result);
  if (!validation.ok) {
    throw new TypeError(`Invalid command result: ${validation.issues.join('; ')}`);
  }
  return result;
}

export async function jobsStatusCommand(args: {
  projectId: string;
  requestId: string;
  rootDir?: string;
}): Promise<CommandResult> {
  let validProjectId: string;
  let validRequestId: string;

  try {
    validProjectId = validateProjectId(args?.projectId);
    validRequestId = validateRequestId(args?.requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return buildResult({
      outcome: 'failed',
      retryability: 'not_retryable',
      data: null,
      error: {
        code: 'invalid_input',
        message,
        retryable: false,
        category: 'validation',
      },
    });
  }

  const isBrokerLive = await probeExistingBroker(validProjectId, args.rootDir);
  if (!isBrokerLive) {
    return buildResult({
      outcome: 'failed',
      retryability: 'not_retryable',
      data: null,
      error: {
        code: 'broker_unavailable',
        message: `No active broker found for project '${validProjectId}'`,
        retryable: false,
        category: 'runtime',
      },
    });
  }

  return buildResult({
    outcome: 'failed',
    retryability: 'not_retryable',
    data: null,
    error: {
      code: 'broker_query_unimplemented',
      message: `Broker query unimplemented for requestId '${validRequestId}'`,
      retryable: false,
      category: 'runtime',
    },
  });
}
