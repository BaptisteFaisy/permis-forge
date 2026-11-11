/**
 * Plan-first parsing, batch evaluation, and deviation detection (spec §8.4).
 *
 * Agents submit an execution plan (JSON array or markdown bullet list) before
 * acting. Each step is evaluated sequentially so permits and approvals stay
 * deterministic, and runtime actions are checked against the declared plan.
 */
import { targetCovers } from './glob';
import {
  Classification,
  Decision,
  PlanAction,
  PlanEvaluation,
} from './types';

const MARKDOWN_BULLET_RE =
  /^\s*[-*]\s*(?:\[([A-Za-z]+-[0-9]{2}|X-[A-Za-z0-9_-]+)\]\s*)?([^:]+?)(?::\s*(.*))?$/;

function parseJsonPlan(planText: string): PlanAction[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planText);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;

  const actions: PlanAction[] = [];
  parsed.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return;
    const record = entry as Record<string, unknown>;
    if (typeof record.target !== 'string' || record.target.trim() === '') {
      return;
    }
    const action: PlanAction = {
      order: index + 1,
      target: record.target,
    };
    if (typeof record.actionClass === 'string' && record.actionClass.trim()) {
      action.actionClass = record.actionClass.trim();
    }
    if (typeof record.description === 'string' && record.description.trim()) {
      action.description = record.description.trim();
    }
    actions.push(action);
  });
  return actions;
}

function parseMarkdownPlan(planText: string): PlanAction[] {
  const actions: PlanAction[] = [];
  for (const line of planText.split(/\r?\n/)) {
    const match = MARKDOWN_BULLET_RE.exec(line);
    if (!match) continue;
    const target = match[2].trim();
    if (!target) continue;
    const action: PlanAction = {
      order: actions.length + 1,
      target,
    };
    if (match[1]) action.actionClass = match[1];
    const description = match[3]?.trim();
    if (description) action.description = description;
    actions.push(action);
  }
  return actions;
}

/** Parse a JSON or markdown agent plan into ordered PlanAction entries. */
export function parsePlan(planText: string): PlanAction[] {
  if (!planText || planText.trim() === '') return [];
  const jsonActions = parseJsonPlan(planText);
  if (jsonActions !== undefined) return jsonActions;
  return parseMarkdownPlan(planText);
}

/** Evaluate every planned action sequentially in declared order. */
export async function evaluatePlan(
  actions: PlanAction[],
  evaluate: (action: PlanAction) => Promise<Decision>,
): Promise<PlanEvaluation> {
  const decisions: { action: PlanAction; decision: Decision }[] = [];
  const approvalsNeeded: PlanAction[] = [];
  const denied: PlanAction[] = [];

  for (const action of actions) {
    const decision = await evaluate(action);
    decisions.push({ action, decision });
    if (decision.requestId !== undefined) {
      approvalsNeeded.push(action);
    }
    if (
      decision.level === 0 ||
      (decision.decision === 'deny' && !decision.requestId)
    ) {
      denied.push(action);
    }
  }

  return { decisions, approvalsNeeded, denied };
}

/** Return the first plan step covering the given class and target. */
export function findPlanMatch(
  planActions: PlanAction[],
  classification: Classification,
  target: string,
): PlanAction | undefined {
  return planActions.find(
    (action) =>
      (action.actionClass === undefined ||
        action.actionClass === classification.actionClass) &&
      targetCovers(action.target, target),
  );
}

/** True when no declared plan step covers the action (spec §8.4 deviation). */
export function isOutOfPlan(
  planActions: PlanAction[],
  classification: Classification,
  target: string,
): boolean {
  return !findPlanMatch(planActions, classification, target);
}
