import {
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import { randomUUID } from 'node:crypto';
import { probeExistingBroker } from '../runtime/broker-host.js';
import { BrokerClient, PUBLIC_CLI_BROKER_CLIENT_ID } from '../runtime/broker-client.js';
import { brokerEndpoint } from '../runtime/broker-endpoint.js';
import { BROKER_ERROR_MESSAGES, BrokerError } from '../runtime/broker-errors.js';

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
    invocationId: randomUUID(),
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

  const client = new BrokerClient({
    endpoint: brokerEndpoint(validProjectId, args.rootDir),
    projectId: validProjectId,
    clientId: PUBLIC_CLI_BROKER_CLIENT_ID,
    capabilities: ['status'],
  });
  try {
    await client.connect();
    const receipt = await client.querySubmission(validRequestId);
    if (receipt === undefined) {
      return buildResult({
        outcome: 'empty',
        retryability: 'not_retryable',
        data: {
          projectId: validProjectId,
          requestId: validRequestId,
          status: 'not_found',
        },
      });
    }
    if (receipt.state === 'outcome_unknown') {
      return buildResult({
        outcome: 'outcome_unknown',
        retryability: 'not_retryable',
        data: {
          projectId: validProjectId,
          requestId: validRequestId,
          status: 'outcome_unknown',
          receipt,
        },
        error: {
          code: 'outcome_unknown',
          message: 'The broker cannot prove the job outcome after an interrupted dispatch.',
          retryable: false,
          category: 'runtime',
        },
      });
    }

    if (receipt.state === 'pending') {
      return buildResult({
        outcome: 'success',
        retryability: 'not_retryable',
        data: {
          projectId: validProjectId,
          requestId: validRequestId,
          status: 'pending',
          receipt,
        },
      });
    }

    const runtimeReply = await client.request({
      version: 1,
      requestId: 'status_' + randomUUID().replaceAll('-', '_'),
      method: 'status',
      params: { runId: receipt.jobId },
    });
    if (!runtimeReply.success) {
      const missing = runtimeReply.error.code === 'not_found';
      return buildResult({
        outcome: missing ? 'stale' : 'failed',
        retryability: 'not_retryable',
        data: {
          projectId: validProjectId,
          requestId: validRequestId,
          receipt,
        },
        error: {
          code: runtimeReply.error.code,
          message: runtimeReply.error.message,
          retryable: false,
          category: 'runtime',
        },
      });
    }

    const runtime = runtimeReply.data as Record<string, unknown>;
    const refreshedReceipt = await client.querySubmission(validRequestId) ?? receipt;
    return buildResult({
      outcome: 'success',
      retryability: 'not_retryable',
      data: {
        projectId: validProjectId,
        requestId: validRequestId,
        status: typeof runtime.state === 'string' ? runtime.state : 'unknown',
        receipt: refreshedReceipt,
        runtime,
      },
    });
  } catch (error) {
    const message =
      error instanceof BrokerError
        ? BROKER_ERROR_MESSAGES[error.code]
        : 'Broker status query failed.';
    return buildResult({
      outcome: 'failed',
      retryability: 'not_retryable',
      data: null,
      error: {
        code: 'broker_query_failed',
        message,
        retryable: false,
        category: 'runtime',
      },
    });
  } finally {
    client.close();
  }
}
