export interface ClickVerificationResult {
  dispatched: boolean;
  reason?: 'no-event' | 'probe-error';
}

export type EvalRunner = (expression: string) => Promise<{ success: boolean; data?: unknown; error?: string }>;

const ELIGIBLE_PATTERN = /^(role=|xpath=|@e\d+)/;

/** True for selector syntaxes worth the extra two eval round-trips. */
export function isEligibleForVerification(selector: string): boolean {
  return ELIGIBLE_PATTERN.test(selector);
}

/**
 * Arms a one-shot capture-phase listener via eval, expected to be called
 * immediately before the click command, and read back immediately after.
 */
export async function armClickProbe(runEval: EvalRunner, _selector: string): Promise<void> {
  const script = `window.__pi_click_probe__ = { fired: false }; document.addEventListener('click', () => { window.__pi_click_probe__ = { fired: true }; }, { capture: true, once: true });`;
  await runEval(script);
}

export async function readClickProbe(runEval: EvalRunner): Promise<ClickVerificationResult> {
  const script = `(() => { const probe = window.__pi_click_probe__; delete window.__pi_click_probe__; return probe ?? null; })()`;
  const result = await runEval(script);
  if (!result.success) {
    return { dispatched: false, reason: 'probe-error' };
  }
  const data = result.data as { fired?: boolean } | null | undefined;
  if (!data || data.fired !== true) {
    return { dispatched: false, reason: 'no-event' };
  }
  return { dispatched: true };
}
