/**
 * Plan evaluation and batch actions.
 *
 * Models a multi-step action plan submitted by an agent for evaluation,
 * grouping approvals into single requests where possible.
 */

import type { Decision } from './decision';

export interface PlanAction {
  order: number;
  actionClass?: string;
  target: string;
  description?: string;
}

export interface PlanEvaluation {
  decisions: { action: PlanAction; decision: Decision }[];
  /** Actions needing approval, grouped into ONE request (spec §8.4). */
  approvalsNeeded: PlanAction[];
  denied: PlanAction[];
}
