/**
 * Pipeline decision output and caller identity.
 *
 * Represents the final enforcement decision returned to the agent/hook,
 * along with the identity of the calling agent and pilot.
 */

import type { AutonomyLevel, HookDecision } from './levels';
import type { Classification } from './actions';
import type { PolicyResolution } from './policy';

export interface ActorIdentity {
  accountId: string;
  roles: string[];
  displayName?: string;
}

/** Who is calling: never taken from tool inputs (spec §16 step 1). */
export interface AgentCallContext {
  projectId: string;
  issueKey?: string;
  profileId: string;
  pilot: ActorIdentity;
  via: 'mcp' | 'hook' | 'console' | 'ci';
}

/** Final answer of the pipeline: decision + why + what to do next. */
export interface Decision {
  level: AutonomyLevel;
  decision: HookDecision;
  /** N4 and observe-mode decisions are journaled and notified. */
  log: boolean;
  classification: Classification;
  resolution: PolicyResolution;
  /** Permit id whose use was consumed by this decision. */
  permitConsumed?: string;
  /** Approval request created because no permit covered the action. */
  requestId?: string;
  /** Always set: cited rule + reason (spec §19 Explicabilité). */
  reason: string;
  /** What the agent or pilot should do next. */
  guidance: string;
  ledgerSeq?: number;
  at: string;
}
