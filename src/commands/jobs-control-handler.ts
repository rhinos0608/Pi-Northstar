import { randomUUID } from 'node:crypto';
import {
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import { BrokerClient, PUBLIC_CLI_BROKER_CLIENT_ID } from '../runtime/broker-client.js';
import { brokerEndpoint } from '../runtime/broker-endpoint.js';
import { BROKER_ERROR_MESSAGES, BrokerError, BrokerOutcomeError } from '../runtime/broker-errors.js';
import { probeExistingBroker } from '../runtime/broker-host.js';
import { RUNTIME_RPC_BOUNDS, validateRequest } from '../runtime/runtime-rpc-protocol.js';

export const JOBS_START_COMMAND = 'jobs.start';
export const JOBS_RESULT_COMMAND = 'jobs.result';
export const JOBS_CANCEL_COMMAND = 'jobs.cancel';

type CommandResult = NorthstarCommandResultV1;

interface BaseArgs {
  projectId: string;
  rootDir?: string;
}

export interface JobsStartArgs extends BaseArgs {
  modelId: string;
  prompt: string;
  requestId?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface JobsLookupArgs extends BaseArgs {
  requestId: string;
}

export interface JobsCancelArgs extends JobsLookupArgs {
  settlementWindowMs?: number;
}

function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(value)) {
    throw new TypeError('projectId must match ^[A-Za-z0-9._-]{1,96}$');
  }
  return value;
}

function validateRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError('requestId must match ^[A-Za-z0-9_-]{1,128}$');
  }
  return value;
}

function buildResult(
  commandId: string,
  params: {
    outcome: NorthstarCommandResultV1['outcome'];
    retryability: NorthstarCommandResultV1['retryability'];
    data: Record<string, unknown> | null;
    sideEffect?: NorthstarCommandResultV1['sideEffect'];
    error?: { code: string; message: string; retryable: boolean; category?: string };
  },
): CommandResult {
  const result: NorthstarCommandResultV1 = {
    schema: 'northstar.command-result.v1', version: 1, commandId,
    invocationId: randomUUID(), outcome: params.outcome,
    retryability: params.retryability, data: params.data,
    sources: [{ kind: 'internal', name: 'broker-host' }], trust: 'internal',
    requestedSurface: 'cli', resolvedSurface: commandId,
    attemptedSurfaces: ['cli', commandId],
    sideEffect: params.sideEffect ?? { started: false, settled: true, outcome: 'not_started' },
    verifiedArtifacts: [], nextActions: [],
    ...(params.error ? { error: params.error } : {}),
  };
  const validation = validateCommandResult(result);
  if (!validation.ok) throw new TypeError(`Invalid command result: ${validation.issues.join('; ')}`);
  return result;
}

function validationFailure(commandId: string, error: unknown): CommandResult {
  return buildResult(commandId, {
    outcome: 'failed', retryability: 'not_retryable', data: null,
    error: {
      code: 'invalid_input',
      message: error instanceof Error ? error.message : 'Invalid job arguments.',
      retryable: false, category: 'validation',
    },
  });
}

function unavailable(commandId: string, projectId: string): CommandResult {
  return buildResult(commandId, {
    outcome: 'failed', retryability: 'not_retryable', data: null,
    error: {
      code: 'broker_unavailable',
      message: `No active broker found for project '${projectId}'`,
      retryable: false, category: 'runtime',
    },
  });
}

function brokerFailure(commandId: string, error: unknown): CommandResult {
  if (error instanceof BrokerOutcomeError) {
    return buildResult(commandId, {
      outcome: 'outcome_unknown', retryability: 'not_retryable', data: null,
      sideEffect: { started: true, settled: false, outcome: 'unknown' },
      error: {
        code: 'outcome_unknown',
        message: 'The broker connection closed after a mutation may have been dispatched.',
        retryable: false,
        category: 'runtime',
      },
    });
  }
  const message = error instanceof BrokerError
    ? BROKER_ERROR_MESSAGES[error.code]
    : 'Broker job request failed.';
  return buildResult(commandId, {
    outcome: 'failed', retryability: 'not_retryable', data: null,
    error: { code: 'broker_request_failed', message, retryable: false, category: 'runtime' },
  });
}

function runtimeFailure(
  commandId: string,
  error: { code: string; message: string },
  data: Record<string, unknown> | null = null,
  sideEffect?: NorthstarCommandResultV1['sideEffect'],
): CommandResult {
  const unknown = error.code === 'timeout';
  return buildResult(commandId, {
    outcome: unknown ? 'outcome_unknown' : 'failed',
    retryability: 'not_retryable',
    data,
    ...(sideEffect !== undefined ? { sideEffect } : {}),
    error: { code: error.code, message: error.message, retryable: false, category: 'runtime' },
  });
}

async function openClient(
  commandId: string,
  projectId: string,
  rootDir: string | undefined,
  capabilities: Array<'start' | 'status' | 'result' | 'cancelAndSettle'>,
): Promise<BrokerClient | CommandResult> {
  if (!(await probeExistingBroker(projectId, rootDir))) return unavailable(commandId, projectId);
  const client = new BrokerClient({
    endpoint: brokerEndpoint(projectId, rootDir), projectId,
    clientId: PUBLIC_CLI_BROKER_CLIENT_ID, capabilities,
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    client.close();
    return brokerFailure(commandId, error);
  }
}

function isCommandResult(value: BrokerClient | CommandResult): value is CommandResult {
  return 'schema' in value;
}

export async function jobsStartCommand(args: JobsStartArgs): Promise<CommandResult> {
  let projectId: string;
  let requestId: string;
  let request;
  try {
    projectId = validateProjectId(args.projectId);
    requestId = validateRequestId(args.requestId ?? ('job_' + randomUUID().replaceAll('-', '_')));
    if (typeof args.modelId !== 'string' || !args.modelId.includes('/') || /\s/.test(args.modelId)) {
      throw new TypeError('modelId must be an exact provider/model ID.');
    }
    if (typeof args.prompt !== 'string' || args.prompt.length === 0 || Buffer.byteLength(args.prompt, 'utf8') > RUNTIME_RPC_BOUNDS.maxPromptBytes) {
      throw new TypeError('prompt must be non-empty and within the runtime prompt bound.');
    }
    const maxOutputTokens = args.maxOutputTokens ?? 1024;
    const timeoutMs = args.timeoutMs ?? 120_000;
    request = {
      version: 1 as const,
      requestId,
      method: 'start' as const,
      params: {
        modelId: args.modelId,
        prompt: args.prompt,
        maxOutputTokens,
        timeoutMs,
        correlation: {
          owner: 'northstar', correlationId: requestId,
          queryIndex: 0, role: 'researcher', stage: 'jobs-start', attempt: 0,
        },
      },
    };
    const checked = validateRequest(request);
    if (!checked.ok) throw new TypeError('Job start parameters are outside runtime protocol bounds.');
    request = checked.value;
  } catch (error) {
    return validationFailure(JOBS_START_COMMAND, error);
  }

  const opened = await openClient(JOBS_START_COMMAND, projectId, args.rootDir, ['start']);
  if (isCommandResult(opened)) return opened;
  const client = opened;
  try {
    const reply = await client.request(request);
    if (!reply.success) {
      return runtimeFailure(
        JOBS_START_COMMAND,
        reply.error,
        { projectId, requestId },
        { started: true, settled: reply.error.code !== 'timeout', outcome: reply.error.code === 'timeout' ? 'unknown' : 'rolled_back' },
      );
    }
    const runtime = reply.data as Record<string, unknown>;
    return buildResult(JOBS_START_COMMAND, {
      outcome: 'success', retryability: 'not_retryable',
      data: { projectId, requestId, jobId: runtime.runId, status: runtime.state ?? 'running', runtime },
      sideEffect: { started: true, settled: true, outcome: 'committed' },
    });
  } catch (error) {
    return brokerFailure(JOBS_START_COMMAND, error);
  } finally {
    client.close();
  }
}

export async function jobsResultCommand(args: JobsLookupArgs): Promise<CommandResult> {
  let projectId: string;
  let requestId: string;
  try {
    projectId = validateProjectId(args.projectId);
    requestId = validateRequestId(args.requestId);
  } catch (error) {
    return validationFailure(JOBS_RESULT_COMMAND, error);
  }

  const opened = await openClient(JOBS_RESULT_COMMAND, projectId, args.rootDir, ['status', 'result']);
  if (isCommandResult(opened)) return opened;
  const client = opened;
  try {
    const receipt = await client.querySubmission(requestId);
    if (receipt === undefined) {
      return buildResult(JOBS_RESULT_COMMAND, {
        outcome: 'empty', retryability: 'not_retryable',
        data: { projectId, requestId, status: 'not_found' },
      });
    }
    if (receipt.state === 'outcome_unknown') {
      return buildResult(JOBS_RESULT_COMMAND, {
        outcome: 'outcome_unknown', retryability: 'not_retryable',
        data: { projectId, requestId, receipt },
        error: {
          code: 'outcome_unknown',
          message: 'The broker cannot prove which runtime job, if any, was created.',
          retryable: false, category: 'runtime',
        },
      });
    }
    if (receipt.state === 'pending') {
      return buildResult(JOBS_RESULT_COMMAND, {
        outcome: 'failed', retryability: 'retryable',
        data: { projectId, requestId, receipt },
        error: { code: 'invalid_state', message: 'The job has not been dispatched yet.', retryable: true, category: 'runtime' },
      });
    }

    const reply = await client.request({
      version: 1,
      requestId: 'result_' + randomUUID().replaceAll('-', '_'),
      method: 'result',
      params: { runId: receipt.jobId },
    });
    if (!reply.success) {
      return buildResult(JOBS_RESULT_COMMAND, {
        outcome: reply.error.code === 'not_found' ? 'stale' : 'failed',
        retryability: reply.error.code === 'timeout' ? 'retryable' : 'not_retryable',
        data: { projectId, requestId, receipt },
        error: { code: reply.error.code, message: reply.error.message, retryable: reply.error.code === 'timeout', category: 'runtime' },
      });
    }
    const refreshedReceipt = await client.querySubmission(requestId) ?? receipt;
    return buildResult(JOBS_RESULT_COMMAND, {
      outcome: 'success', retryability: 'not_retryable',
      data: { projectId, requestId, receipt: refreshedReceipt, runtime: reply.data },
    });
  } catch (error) {
    return brokerFailure(JOBS_RESULT_COMMAND, error);
  } finally {
    client.close();
  }
}

export async function jobsCancelCommand(args: JobsCancelArgs): Promise<CommandResult> {
  let projectId: string;
  let requestId: string;
  let settlementWindowMs: number;
  try {
    projectId = validateProjectId(args.projectId);
    requestId = validateRequestId(args.requestId);
    settlementWindowMs = args.settlementWindowMs ?? 2_000;
    if (!Number.isSafeInteger(settlementWindowMs) || settlementWindowMs < 1 || settlementWindowMs > 10_000) {
      throw new TypeError('settlementWindowMs must be an integer between 1 and 10000.');
    }
  } catch (error) {
    return validationFailure(JOBS_CANCEL_COMMAND, error);
  }

  const opened = await openClient(JOBS_CANCEL_COMMAND, projectId, args.rootDir, ['status', 'cancelAndSettle']);
  if (isCommandResult(opened)) return opened;
  const client = opened;
  try {
    const receipt = await client.querySubmission(requestId);
    if (receipt === undefined) {
      return buildResult(JOBS_CANCEL_COMMAND, {
        outcome: 'empty', retryability: 'not_retryable',
        data: { projectId, requestId, status: 'not_found' },
      });
    }
    if (receipt.state === 'outcome_unknown') {
      return buildResult(JOBS_CANCEL_COMMAND, {
        outcome: 'outcome_unknown', retryability: 'not_retryable',
        data: { projectId, requestId, receipt },
        error: {
          code: 'outcome_unknown',
          message: 'Cancellation is unsafe because the original start outcome is unknown.',
          retryable: false, category: 'runtime',
        },
      });
    }
    if (receipt.state === 'pending') {
      return buildResult(JOBS_CANCEL_COMMAND, {
        outcome: 'failed', retryability: 'retryable',
        data: { projectId, requestId, receipt },
        error: { code: 'invalid_state', message: 'The job has not been dispatched yet.', retryable: true, category: 'runtime' },
      });
    }

    const cancelRequest = {
      version: 1 as const,
      requestId: 'cancel_' + randomUUID().replaceAll('-', '_'),
      method: 'cancelAndSettle' as const,
      params: { runIds: [receipt.jobId], settlementWindowMs },
    };
    const checked = validateRequest(cancelRequest);
    if (!checked.ok) return validationFailure(JOBS_CANCEL_COMMAND, new TypeError('Invalid cancellation request.'));
    const reply = await client.request(checked.value);
    if (!reply.success) {
      return runtimeFailure(
        JOBS_CANCEL_COMMAND,
        reply.error,
        { projectId, requestId, receipt },
        { started: true, settled: reply.error.code !== 'timeout', outcome: reply.error.code === 'timeout' ? 'unknown' : 'rolled_back' },
      );
    }
    const refreshedReceipt = await client.querySubmission(requestId) ?? receipt;
    return buildResult(JOBS_CANCEL_COMMAND, {
      outcome: 'success', retryability: 'not_retryable',
      data: { projectId, requestId, receipt: refreshedReceipt, runtime: reply.data },
      sideEffect: { started: true, settled: true, outcome: 'committed' },
    });
  } catch (error) {
    return brokerFailure(JOBS_CANCEL_COMMAND, error);
  } finally {
    client.close();
  }
}
