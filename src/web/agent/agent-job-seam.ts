// Agent-job seam (Plan A5): the interface Plan C implements. buildSearchRoute
// routes mode:'agent' here; the jobs registry owns the runtime. No
// agent_jobs_unavailable throw ships on the green gate.

import { createAgentJobEntry, UNSUPPORTED_AGENT_JOB_FIELDS } from './agent-jobs.js';
import type { AgentResearchEvent } from './agent-events.js';

export interface AgentJobPointer {
  jobId: string;
}

// The job runtime takes a bare query string (AgentJobRunnerDeps.search
// accepts query only): search constraints cannot be honored end-to-end, so
// they are rejected fail-closed at admission rather than dropped silently.
export interface CreateAgentJobParams {
  query: string;
  owner?: string;
  deadlineMs?: number;
  signal?: AbortSignal;
  eventSink?: (event: AgentResearchEvent) => void;
}

let creator: (params: CreateAgentJobParams) => AgentJobPointer = (params) => {
  const job = createAgentJobEntry({
    query: params.query,
    ...(params.owner !== undefined ? { owner: params.owner } : {}),
    ...(params.deadlineMs !== undefined ? { deadlineMs: params.deadlineMs } : {}),
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    ...(params.eventSink !== undefined ? { eventSink: params.eventSink } : {}),
  });
  return { jobId: job.jobId };
};

/** Test seam: swap the job creator. Unset restores the registry path. */
export function __setAgentJobCreator(next: ((params: CreateAgentJobParams) => AgentJobPointer) | undefined): void {
  creator =
    next ??
    ((params) => {
      const job = createAgentJobEntry({
        query: params.query,
        ...(params.owner !== undefined ? { owner: params.owner } : {}),
        ...(params.deadlineMs !== undefined ? { deadlineMs: params.deadlineMs } : {}),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
        ...(params.eventSink !== undefined ? { eventSink: params.eventSink } : {}),
      });
      return { jobId: job.jobId };
    });
}

/** Search-constraint fields the job runtime cannot honor: fail closed. */
const UNSUPPORTED_JOB_FIELDS = UNSUPPORTED_AGENT_JOB_FIELDS;

export function createAgentJob(params: CreateAgentJobParams): AgentJobPointer {
  const query = params.query.trim();
  if (query === '') throw new Error('agent job requires a non-empty query');
  const record = params as CreateAgentJobParams & Record<string, unknown>;
  for (const field of UNSUPPORTED_JOB_FIELDS) {
    if (record[field] !== undefined) {
      throw new Error(`agent job rejects search constraint "${field}": unsupported by the job runtime`);
    }
  }
  const pointer = creator(params);
  if (typeof pointer.jobId !== 'string' || pointer.jobId === '') {
    throw new Error('agent job creator returned an invalid job pointer');
  }
  return { jobId: pointer.jobId };
}
