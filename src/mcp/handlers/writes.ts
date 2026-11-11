/**
 * Write-side MCP handlers: request-approval, declare-action, submit-plan.
 *
 * All three go through the same decision engine as check-permission: the
 * engine is the single place where a level is resolved, a permit is consumed
 * and a ledger entry is written (spec §16).
 */
import { defaultLevelFor } from '../../core/catalog';
import { makeEntry } from '../../core/ledger';
import { maskSecrets } from '../../core/mask';
import { parsePlan } from '../../core/plan';
import { ActionRequest, ApprovalRequest } from '../../core/types';
import {
  buildCaller,
  getRuntime,
  resolveAccountId,
  resolveIssueKey,
  resolveProfileId,
  resolveProjectId,
  toJson,
} from '../runtime';
import { HandlerArgs } from './reads';

/** request-approval — create the request and tell the agent what to do next. */
export async function requestApproval({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const target = typeof payload?.target === 'string' ? payload.target : '';
  const action: ActionRequest = {
    issueKey,
    declaredClass: typeof payload?.actionClass === 'string' ? payload.actionClass : undefined,
    target,
    description: typeof payload?.justification === 'string' ? payload.justification : undefined,
    projectId,
    at: runtime.now(),
  };
  const caller = buildCaller({
    projectId,
    issueKey,
    profileId: resolveProfileId(payload),
    accountId: resolveAccountId(context),
    via: 'mcp',
  });
  const decision = await runtime.engine.evaluateAction(action, caller);
  if (!decision.requestId) {
    return toJson({
      requestId: undefined,
      decision: decision.decision,
      level: decision.level,
      reason: decision.reason,
      guidance: decision.guidance,
    });
  }
  const request = await runtime.repos.requests.get(decision.requestId);
  if (request) {
    request.justification = payload?.justification;
    request.plan = payload?.plan;
    request.approverRoles = await approverRolesFor(runtime.repos, projectId, decision.classification.actionClass);
    await runtime.repos.requests.update(request);
  }
  return toJson({
    requestId: decision.requestId,
    actionClass: decision.classification.actionClass,
    level: decision.level,
    approvers: request?.approverRoles ?? [],
    status: request?.status ?? 'pending',
    reason: decision.reason,
    guidance:
      'Stop here. Announce the request number, wait for the pilot to resume you. ' +
      'Do not poll get-request-status in a loop.',
  });
}

/** declare-action — report an executed action into the chained ledger. */
export async function declareAction({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const target = typeof payload?.target === 'string' ? payload.target : '';
  const actionClass = typeof payload?.actionClass === 'string' ? payload.actionClass : 'A-02';
  const outcome = typeof payload?.outcome === 'string' ? payload.outcome : '';
  const permitId = typeof payload?.permitId === 'string' ? payload.permitId : undefined;
  const prev = await runtime.repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    {
      kind: 'action-declared',
      projectId,
      issueId: issueKey,
      profileId: resolveProfileId(payload),
      pilotAccountId: resolveAccountId(context),
      actionClass,
      target: maskSecrets(target),
      permitId,
      detail: { outcome: maskSecrets(outcome) },
      at: runtime.now(),
    },
    prev,
  );
  await runtime.repos.ledger.append(entry);
  return toJson({
    declared: true,
    seq: entry.seq,
    hash: entry.hash,
    actionClass,
    permitId,
    note: 'Cite the permit in the commit message or the pull request description.',
  });
}

/** Evaluate every action of the plan in sequential order. */
async function evaluatePlanActions(
  runtime: Awaited<ReturnType<typeof getRuntime>>,
  projectId: string,
  issueKey: string | undefined,
  caller: ReturnType<typeof buildCaller>,
  actions: ReturnType<typeof parsePlan>,
) {
  const decisions = [];
  for (const item of actions) {
    const decision = await runtime.engine.evaluateAction(
      { issueKey, declaredClass: item.actionClass, target: item.target, projectId, at: runtime.now() },
      caller,
    );
    decisions.push({ action: item, decision });
  }
  return decisions;
}

/** submit-plan — split the plan, decide each action, group the approvals. */
export async function submitPlan({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const planText = typeof payload?.plan === 'string' ? payload.plan : '';
  const actions = parsePlan(planText);
  const caller = buildCaller({
    projectId,
    issueKey,
    profileId: resolveProfileId(payload),
    accountId: resolveAccountId(context),
    via: 'mcp',
  });
  const decisions = await evaluatePlanActions(runtime, projectId, issueKey, caller, actions);
  const needsApproval = decisions.filter((entry) => entry.decision.requestId !== undefined);
  const grouped = await groupApproval(runtime, projectId, issueKey, caller, needsApproval, planText);
  await recordPlanSubmission(runtime, projectId, issueKey, caller.profileId, caller.pilot.accountId, {
    actions: actions.length,
    approvalsNeeded: needsApproval.length,
    requestId: grouped?.id,
  });
  return toJson({
    actions: decisions.map((entry2) => ({
      target: entry2.action.target,
      actionClass: entry2.decision.classification.actionClass,
      decision: entry2.decision.decision,
      level: entry2.decision.level,
      reason: entry2.decision.reason,
    })),
    groupedRequestId: grouped?.id,
    guidance: grouped
      ? 'One approval request covers the whole plan. Stop and wait for the pilot.'
      : 'Every action of the plan is allowed under the current policy.',
  });
}

/** Record the plan submission event into the chained ledger. */
async function recordPlanSubmission(
  runtime: Awaited<ReturnType<typeof getRuntime>>,
  projectId: string,
  issueKey: string | undefined,
  profileId: string,
  pilotAccountId: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const prev = await runtime.repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    {
      kind: 'plan-submitted',
      projectId,
      issueId: issueKey,
      profileId,
      pilotAccountId,
      detail,
      at: runtime.now(),
    },
    prev,
  );
  await runtime.repos.ledger.append(entry);
}

/** One request for every action of the plan that needs an approval. */
async function groupApproval(
  runtime: Awaited<ReturnType<typeof getRuntime>>,
  projectId: string,
  issueKey: string | undefined,
  caller: ReturnType<typeof buildCaller>,
  needsApproval: { action: { target: string; actionClass?: string }; decision: any }[],
  planText: string,
): Promise<ApprovalRequest | undefined> {
  if (needsApproval.length === 0) return undefined;
  const classes = needsApproval.map((entry) => entry.decision.classification.actionClass as string);
  const strictest = classes.reduce((worst, code) =>
    defaultLevelFor(code) < defaultLevelFor(worst) ? code : worst,
  );
  const level = needsApproval.reduce(
    (worst, entry) => (entry.decision.level < worst ? entry.decision.level : worst),
    5 as number,
  ) as ApprovalRequest['level'];
  const year = new Date().getUTCFullYear();
  const sequence = await runtime.repos.requests.nextRequestSequence(year);
  const request: ApprovalRequest = {
    id: `RQ-${year}-${String(sequence).padStart(6, '0')}`,
    issueId: issueKey ?? '',
    projectId,
    profileId: caller.profileId,
    pilotAccountId: caller.pilot.accountId,
    actionClass: strictest,
    target: needsApproval.map((entry) => entry.action.target).join(', '),
    justification: 'Plan submitted: several actions require approval.',
    plan: planText,
    level,
    status: 'pending',
    createdAt: runtime.now(),
    approvals: [],
    approverRoles: await approverRolesFor(runtime.repos, projectId, strictest),
  };
  await runtime.repos.requests.create(request);
  return request;
}

/** Roles allowed to approve a class, read from the policy rules. */
async function approverRolesFor(
  repos: Awaited<ReturnType<typeof getRuntime>>['repos'],
  projectId: string,
  actionClass: string,
): Promise<string[]> {
  const rules = await repos.policies.listRules(projectId);
  const roles = rules
    .filter((rule) => rule.actionClass === actionClass && rule.approverRole)
    .map((rule) => rule.approverRole as string);
  return roles.length > 0 ? Array.from(new Set(roles)) : ['project-admin'];
}
