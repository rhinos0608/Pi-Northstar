// Companion selection: OS-default Chromium routing + explicit family choice.
//
// Rules (final contract):
// - Chromium OS default selects the SOLE family match; missing or ambiguous
//   (0 or 2+) fails closed.
// - Non-Chromium/unknown OS default never auto-selects: requires an explicit
//   interactive or slash-command family argument; headless fails with guidance.
// - Multiple live instances of the same family always fail closed.
// - Explicit family argument follows the same sole-match rule.
// - No profile identity claims anywhere; errors carry family counts only.

import { isChromiumFamily, type ChromiumFamily, type OsDefaultFamily } from './chrome-os-default.js';
import type { CompanionEntry } from './chrome-companion-registry.js';
import { CHROME_BRIDGE_INSTANCE_STALE_MS, type ChromeBridgeInstanceInfo } from './chrome-profile-contract.js';

export type SelectionFailureKind =
  | 'missing'
  | 'ambiguous'
  | 'explicit-required'
  | 'explicit-missing'
  | 'explicit-ambiguous';

export interface SelectionSuccess {
  ok: true;
  selected: CompanionEntry;
}

export interface SelectionFailure {
  ok: false;
  kind: SelectionFailureKind;
  message: string;
}

export type SelectionResult = SelectionSuccess | SelectionFailure;

export interface SelectCompanionInput {
  osDefault: { family: OsDefaultFamily; isChromium: boolean } | null;
  companions: CompanionEntry[];
  /** User slash-command family argument or interactive choice. Never model input. */
  explicitFamily?: ChromiumFamily | null | undefined;
  /** True when no interactive user choice is possible. */
  headless?: boolean | undefined;
}

export const HEADLESS_GUIDANCE =
  'headless session: pass the family explicitly (slash command family argument) or connect exactly one matching Chromium companion';

function sameFamilyCount(companions: CompanionEntry[], family: ChromiumFamily): CompanionEntry[] {
  return companions.filter((c) => c.family === family);
}

export function selectCompanion(input: SelectCompanionInput): SelectionResult {
  const companions = input.companions;
  const explicit = input.explicitFamily ?? null;

  if (explicit !== null) {
    if (!isChromiumFamily(explicit)) {
      return {
        ok: false,
        kind: 'explicit-missing',
        message: `explicit family '${explicit}' is not a Chromium family; no companion selected`,
      };
    }
    const matches = sameFamilyCount(companions, explicit);
    if (matches.length === 0) {
      return {
        ok: false,
        kind: 'explicit-missing',
        message: `no connected ${explicit} companion; no companion selected`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        kind: 'explicit-ambiguous',
        message: `multiple connected ${explicit} companions (${matches.length}); disconnect extras, no companion selected`,
      };
    }
    return { ok: true, selected: { ...matches[0]! } };
  }

  const osDefault = input.osDefault;
  if (osDefault === null || !osDefault.isChromium) {
    if (input.headless === true) {
      return {
        ok: false,
        kind: 'explicit-required',
        message: `OS default is ${osDefault === null ? 'unknown' : osDefault.family}; ${HEADLESS_GUIDANCE}`,
      };
    }
    return {
      ok: false,
      kind: 'explicit-required',
      message: `OS default is ${osDefault === null ? 'unknown' : osDefault.family} (non-Chromium); explicit interactive user choice among connected Chromium families required, no companion selected`,
    };
  }

  const family = osDefault.family as ChromiumFamily;
  const matches = sameFamilyCount(companions, family);
  if (matches.length === 0) {
    return {
      ok: false,
      kind: 'missing',
      message: `OS default is ${family} but no connected ${family} companion; no companion selected`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      kind: 'ambiguous',
      message: `multiple connected ${family} companions (${matches.length}); disconnect extras, no companion selected`,
    };
  }
  return { ok: true, selected: { ...matches[0]! } };
}

export interface SelectBridgeCompanionInput {
  /** Raw bridge-server instance claims (ephemeral instanceId + family + caps + heartbeat). */
  instances: ChromeBridgeInstanceInfo[];
  osDefault: { family: OsDefaultFamily; isChromium: boolean } | null;
  /** User slash-command family argument or interactive choice. Never model input. */
  explicitFamily?: ChromiumFamily | null | undefined;
  /** True when no interactive user choice is possible. */
  headless?: boolean | undefined;
  now?: number | undefined;
}

/**
 * Registry selection over live bridge instances: drops stale heartbeats,
 * drops non-Chromium family claims (unselectable), maps caps to evidence,
 * then applies the same sole-match contract as selectCompanion.
 */
export function selectBridgeCompanion(input: SelectBridgeCompanionInput): SelectionResult {
  const at = input.now ?? Date.now();
  const companions: CompanionEntry[] = [];
  for (const info of input.instances) {
    if (at - info.lastSeen > CHROME_BRIDGE_INSTANCE_STALE_MS) continue;
    if (!isChromiumFamily(info.family as OsDefaultFamily)) continue;
    companions.push({
      family: info.family as ChromiumFamily,
      version: info.version,
      evidence: info.caps,
      instanceId: info.instanceId,
      lastSeen: info.lastSeen,
    });
  }
  return selectCompanion({
    osDefault: input.osDefault,
    companions,
    ...(input.explicitFamily !== undefined ? { explicitFamily: input.explicitFamily } : {}),
    ...(input.headless !== undefined ? { headless: input.headless } : {}),
  });
}
