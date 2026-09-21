import { randomUUID } from 'node:crypto';
import {
  type NorthstarCommandResultV1,
  validateCommandResult,
} from './command-result.js';
import { BrokerUnavailableError, startBrokerHost } from '../runtime/broker-host.js';
import { BrokerLockError } from '../runtime/broker-lock.js';
import { LocalLeafRuntime } from '../runtime/local-leaf-runtime.js';

export const BROKER_SERVE_COMMAND = 'broker.serve';

export interface BrokerServeArgs {
  projectId: string;
  rootDir?: string;
  env?: Record<string, string | undefined>;
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
    commandId: BROKER_SERVE_COMMAND,
    invocationId: randomUUID(),
    outcome: params.outcome,
    retryability: params.retryability,
    data: params.data,
    sources: [{ kind: 'internal', name: 'broker-host' }],
    trust: 'internal',
    requestedSurface: 'cli',
    resolvedSurface: BROKER_SERVE_COMMAND,
    attemptedSurfaces: ['cli', BROKER_SERVE_COMMAND],
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

export async function brokerServeCommand(args: BrokerServeArgs): Promise<CommandResult> {
  let validProjectId: string;
  try {
    validProjectId = validateProjectId(args?.projectId);
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

  const runtimeClient = new LocalLeafRuntime({ env: args.env ?? process.env });
  try {
    // Binary path always resolves via the default path inside startBrokerHost;
    // caller-supplied binary paths are never accepted here (arbitrary exec risk).
    await startBrokerHost({
      projectId: validProjectId,
      mode: 'serve',
      leafClient: runtimeClient,
      ...(args.rootDir !== undefined ? { rootDir: args.rootDir } : {}),
    });

    return buildResult({
      outcome: 'success',
      retryability: 'not_retryable',
      data: {
        projectId: validProjectId,
        ownership: 'foreground',
        status: 'stopped',
      },
    });
  } catch (error) {
    if (error instanceof BrokerUnavailableError) {
      return buildResult({
        outcome: 'failed',
        retryability: 'not_retryable',
        data: null,
        error: {
          code: 'broker_unavailable',
          message: error.message,
          retryable: false,
          category: 'runtime',
        },
      });
    }

    if (error instanceof BrokerLockError && error.code === 'lock_held') {
      return buildResult({
        outcome: 'failed',
        retryability: 'not_retryable',
        data: null,
        error: {
          code: 'broker_already_running',
          message: error.message,
          retryable: false,
          category: 'runtime',
        },
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    return buildResult({
      outcome: 'failed',
      retryability: 'not_retryable',
      data: null,
      error: {
        code: 'internal_error',
        message,
        retryable: false,
        category: 'runtime',
      },
    });
  } finally {
    await runtimeClient.dispose();
  }
}
