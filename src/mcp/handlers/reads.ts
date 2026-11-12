/**
 * Read-side MCP handlers: check-permission, get-policy, get-request-status,
 * list-permits, get-agent-standing.
 *
 * Every handler returns a string (Forge actions return strings) holding the
 * decision, the rule that produced it and the next step — never a bare
 * boolean, always with the reason (spec §19 Explicabilité).
 */
import { ACTION_CLASSES, defaultLevelFor, levelName } from '../../core/catalog';
import { parsePlan } from '../../core/plan';
import { ActionRequest, LedgerEntry, Permit, PlanAction } from '../../core/types';
import { detectDrift as detectDriftReport, ObservedChange } from '../../services/drift';
import { suggestPolicyChanges } from '../../services/policy-suggestions';
import {
  buildCaller,
  getRuntime,
  resolveAccountId,
  resolveIssueKey,
  resolveProfileId,
  resolveProjectId,
  toJson,
} from '../runtime';

export interface HandlerArgs {
  payload: any;
  context: any;
}

/** check-permission — decide an action and explain the decision. */
export async function checkPermission({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const action: ActionRequest = {
    issueKey,
    declaredClass: typeof payload?.actionClass === 'string' ? payload.actionClass : undefined,
    target: typeof payload?.target === 'string' ? payload.target : '',
    description: typeof payload?.description === 'string' ? payload.description : undefined,
    command: typeof payload?.command === 'string' ? payload.command : undefined,
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
  return toJson({
    decision: decision.decision,
    level: decision.level,
    levelName: levelName(decision.level, 'en'),
    actionClass: decision.classification.actionClass,
    reclassified: decision.classification.reclassified,
    classificationReason: decision.classification.reason,
    rule: decision.resolution.rule?.id,
    source: decision.resolution.source,
    reason: decision.reason,
    guidance: decision.guidance,
    requestId: decision.requestId,
    permit: decision.permitConsumed,
  });
}

/** get-policy — the policy in force, for planning. */
export async function getPolicy({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const rules = await runtime.repos.policies.listRules(projectId);
  const zones = await runtime.repos.zones.listZones(projectId);
  const killSwitches = await runtime.repos.killSwitches.listActive(projectId);
  return toJson({
    projectId,
    classes: ACTION_CLASSES.map((def) => ({
      code: def.code,
      name: def.nameEn,
      defaultLevel: def.defaultLevel,
      locked: def.locked === true,
    })),
    zones: zones.map((zone) => ({
      id: zone.id,
      name: zone.name,
      pathPatterns: zone.pathPatterns,
      component: zone.component,
      environment: zone.environment,
    })),
    rules: rules.map((rule) => ({
      id: rule.id,
      scope: rule.scope,
      actionClass: rule.actionClass,
      zoneId: rule.zoneId,
      level: rule.level,
      mode: rule.mode,
      approverRole: rule.approverRole,
      conditions: rule.conditions,
    })),
    emergencyStopActive: killSwitches.some((state) => state.active),
    note: 'check-permission returns the effective level for one exact action.',
  });
}

/** get-request-status — pending, granted with a permit, denied, or frozen. */
export async function getRequestStatus({ payload }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
  const request = await runtime.repos.requests.get(requestId);
  if (!request) return toJson({ requestId, found: false });
  const permits = await runtime.repos.permits.listPermits({ issueKey: request.issueId });
  const permit = permits.find((item) => item.requestId === requestId);
  return toJson({
    requestId,
    found: true,
    status: request.status,
    actionClass: request.actionClass,
    target: request.target,
    level: request.level,
    approvals: request.approvals,
    approverRoles: request.approverRoles,
    permit: permit ? summarizePermit(permit) : undefined,
  });
}

/** list-permits — permits covering one ticket. */
export async function listPermits({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const permits = await runtime.repos.permits.listPermits({ issueKey });
  const usable = permits.filter((permit) => permit.usesLeft > 0 && !permit.revokedAt);
  return toJson({
    issueKey,
    permits: usable.map(summarizePermit),
  });
}

/** get-agent-standing — trust capital of an agent profile. */
export async function getAgentStanding({ payload }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const profileId = resolveProfileId(payload);
  const state = await runtime.repos.trust.getState(profileId);
  const events = await runtime.repos.trust.listEvents(profileId);
  const score = state?.score ?? 50;
  return toJson({
    profileId,
    score,
    status: state?.status ?? 'active',
    lastActivityAt: state?.lastActivityAt,
    effects: trustEffects(score),
    recentEvents: events.slice(-10),
  });
}

function summarizePermit(permit: Permit): Record<string, unknown> {
  return {
    id: permit.id,
    scope: permit.scope,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    usesLeft: permit.usesLeft,
    revoked: Boolean(permit.revokedAt),
    suspended: permit.suspended === true,
    signature: permit.signature.slice(0, 16),
  };
}

function trustEffects(score: number): string[] {
  const effects: string[] = [];
  if (score > 80) effects.push('Classes set to N3 are raised to N4.');
  if (score < 30) effects.push('Classes set to N4/N5 (except reading) fall back to N3.');
  if (score === 0) effects.push('Profile suspended until human review.');
  if (effects.length === 0) effects.push('No effect on levels.');
  effects.push('Never opens N0, N1 or N2 classes.');
  return effects;
}

/** Default level of a class, used by the policy summary. */
export function defaultLevelLabel(code: string): string {
  return levelName(defaultLevelFor(code), 'en');
}

// --------------------------------------------------- dérive et suggestions

/** Parse the `changes` input: a JSON array of `{ path?, command?, source? }`. */
export function parseChanges(raw: unknown): ObservedChange[] | undefined {
  if (Array.isArray(raw)) return raw.every(isChange) ? raw : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isChange) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isChange(value: unknown): value is ObservedChange {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.path === 'string' || typeof item.command === 'string';
}

/**
 * Actions of the last plan submitted on this ticket, recovered from the ledger.
 * Without them the "out of plan" half of drift detection has nothing to compare
 * against — which is why `submit-plan` journals the plan text (masked, capped).
 */
export function planActionsFrom(entries: LedgerEntry[], issueKey?: string): PlanAction[] {
  const submissions = entries.filter(
    (entry) => entry.kind === 'plan-submitted' && (issueKey === undefined || entry.issueId === issueKey),
  );
  const last = submissions[submissions.length - 1];
  const detail = last?.detail as Record<string, unknown> | undefined;
  return typeof detail?.plan === 'string' ? parsePlan(detail.plan) : [];
}

/**
 * detect-drift — compare what was observed with what was declared (spec §10,
 * enforcement point 4). Read-only on purpose: recording a deviation moves the
 * trust capital, and an agent must never move its own standing. That is the
 * operator's `apply-drift` action.
 */
export async function detectDrift({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const changes = parseChanges(payload?.changes);
  if (changes === undefined) {
    return toJson({
      error: 'CHANGES_INVALID',
      note: 'changes must be a JSON array of objects carrying a "path" or a "command".',
    });
  }
  const entries = await runtime.repos.ledger.list({ projectId, issueId: issueKey });
  const report = await detectDriftReport({
    projectId,
    issueKey,
    profileId: resolveProfileId(payload),
    pilotAccountId: resolveAccountId(context),
    changes,
    declared: entries.filter((entry) => entry.kind === 'action-declared'),
    planActions: planActionsFrom(entries, issueKey),
    at: runtime.now(),
  });
  return toJson({
    ...report,
    recorded: false,
    note:
      report.items.length === 0
        ? 'Every sensitive observed change is declared.'
        : 'Nothing was journaled: recording a deviation and moving the trust capital is an operator action (apply-drift).',
  });
}

/**
 * suggest-policy — the proposals the history supports (spec §26). Reading them
 * is open; applying them is not. Writing a rule is class A-15 (N0), so only the
 * operator endpoint can apply a suggestion, and it refuses a locked class.
 */
export async function suggestPolicy({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const issueKey = resolveIssueKey(context, payload);
  const projectId = resolveProjectId({ issueKey, projectKey: payload?.projectKey });
  const days = typeof payload?.days === 'number' && payload.days > 0 ? payload.days : undefined;
  const suggestions = await suggestPolicyChanges(runtime.repos, projectId, days ? { days } : {});
  return toJson({
    projectId,
    count: suggestions.length,
    suggestions: suggestions.map((item) => ({
      id: item.id,
      actionClass: item.actionClass,
      currentLevel: `N${item.currentLevel}`,
      proposedLevel: `N${item.proposedLevel}`,
      proposedMode: item.proposedMode,
      direction: item.direction,
      evidence: item.evidence,
      risk: item.risk,
    })),
    note:
      suggestions.length === 0
        ? 'No class has enough history yet to propose a change.'
        : 'An agent cannot apply these: writing a rule is class A-15 (N0). An operator applies one with the apply-suggestion action.',
  });
}
