/**
 * Shared formatting, extraction, and simulation-input helpers for UI resolvers.
 */
import { ACTION_CLASSES, className, levelName } from '../core/catalog';
import { targetCovers } from '../core/glob';
import { Lang } from './i18n';
import {
  ActionRequest,
  Classification,
  HookDecision,
  LedgerEntry,
  LedgerFilter,
  Permit,
  PolicyResolution,
  PolicyResolutionInput,
  PolicyRule,
} from '../core/types';
import type { ResolverDeps } from './resolvers';

export const RECENT_ACTIONS_LIMIT = 10;
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PERMIT_TTL_MINUTES = 120;

export type ScreenResult = Record<string, unknown>;

export interface EngineLike {
  classifyAction?: (action: ActionRequest) => Promise<Classification> | Classification;
  classify?: (action: ActionRequest) => Promise<Classification> | Classification;
  resolvePolicy?: (input: PolicyResolutionInput) => Promise<PolicyResolution> | PolicyResolution;
  resolve?: (input: PolicyResolutionInput) => Promise<PolicyResolution> | PolicyResolution;
  simulateAction?: (action: ActionRequest, caller: any) => Promise<any> | any;
  evaluateAction?: (action: ActionRequest, caller: any) => Promise<any> | any;
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function issueKeyOf(payload: any, context: any): string | undefined {
  return str(context?.extension?.issue?.key) ?? str(payload?.issueKey);
}

export function projectIdOf(payload: any, context: any): string {
  const direct = str(payload?.projectId) ?? str(payload?.projectKey) ?? str(context?.extension?.project?.key);
  if (direct) return direct;
  const issueKey = issueKeyOf(payload, context);
  return issueKey && issueKey.includes('-') ? issueKey.split('-')[0] : 'unknown';
}

export function accountIdOf(context: any): string {
  return str(context?.accountId) ?? str(context?.extension?.accountId) ?? 'unknown';
}

export function profileIdOf(payload: any): string {
  return str(payload?.agentProfile) ?? str(payload?.profileId) ?? 'default';
}

export function idOf(payload: any, aliases: string[]): string {
  for (const key of aliases) {
    const value = str(payload?.[key]);
    if (value) return value;
  }
  return '';
}

export function pickMethod(engine: any, names: string[]): ((...args: any[]) => any) | undefined {
  for (const name of names) {
    if (typeof engine?.[name] === 'function') return engine[name].bind(engine);
  }
  return undefined;
}

export function isUsablePermit(permit: Permit, nowIso: string): boolean {
  return !permit.revokedAt && permit.suspended !== true && permit.usesLeft > 0 && permit.expiresAt > nowIso;
}

export function summarizeEntry(entry: LedgerEntry): Record<string, unknown> {
  const { seq, at, kind, issueId, profileId, actionClass, target, ruleId, decision, permitId } = entry;
  return { seq, at, kind, issueId, profileId, actionClass, target, ruleId, decision, permitId };
}

export function summarizePermit(permit: Permit): Record<string, unknown> {
  const { id, scope, issuedAt, expiresAt, usesLeft, suspended } = permit;
  return {
    id,
    actionClass: scope.actionClass,
    target: scope.target,
    issueKey: scope.issueKey,
    issuedAt,
    expiresAt,
    usesLeft,
    suspended: suspended === true,
  };
}

/** Localized summary; `lang` defaults to English so callers stay compatible. */
export function summarizeRequest(request: {
  id: string;
  actionClass: string;
  target: string;
  level: PolicyRule['level'];
  status: string;
  createdAt: string;
  approvals: unknown[];
}, lang: Lang = 'en'): Record<string, unknown> {
  return {
    id: request.id,
    actionClass: request.actionClass,
    target: request.target,
    level: request.level,
    levelName: levelName(request.level, lang),
    status: request.status,
    createdAt: request.createdAt,
    approvals: request.approvals.length,
  };
}

export function countBy<T>(items: T[], keyOf: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function catalogSummary(lang: Lang = 'en'): Record<string, unknown>[] {
  return ACTION_CLASSES.map(({ code, defaultLevel, locked }) => ({
    code,
    name: className(code, lang),
    defaultLevel,
    locked: locked === true,
  }));
}

export function decorateRules(rules: PolicyRule[], lang: Lang = 'en') {
  return rules.map((r) => ({
    ...r,
    className: className(r.actionClass, lang),
    levelName: levelName(r.level, lang),
  }));
}

export function buildLedgerFilter(projectId: string, filters: any = {}): LedgerFilter {
  const filter: LedgerFilter = { projectId };
  if (str(filters.kind)) filter.kind = filters.kind;
  if (str(filters.actionClass)) filter.actionClass = filters.actionClass;
  if (str(filters.profileId)) filter.profileId = filters.profileId;
  if (str(filters.issueId)) filter.issueId = filters.issueId;
  if (str(filters.since)) filter.since = filters.since;
  if (str(filters.until)) filter.until = filters.until;
  return filter;
}

export function buildStats(
  projectId: string,
  entries: LedgerEntry[],
  permits: Permit[],
  requests: { projectId: string; status: string }[],
  profileCount: number,
): Record<string, unknown> {
  const decisions = entries.filter((e) => e.kind === 'decision');
  return {
    totalEntries: entries.length,
    decisions: decisions.length,
    byKind: countBy(entries, (e) => e.kind),
    byDecision: countBy(decisions, (e) => e.decision),
    byClass: countBy(decisions, (e) => e.actionClass),
    activePermits: permits.filter((p) => p.usesLeft > 0 && !p.revokedAt).length,
    pendingRequests: requests.filter((r) => r.projectId === projectId && r.status === 'pending').length,
    agentProfiles: profileCount,
    lastEntryAt: entries.length > 0 ? entries[entries.length - 1].at : undefined,
  };
}

export async function loadAgentStandings(deps: ResolverDeps, projectId: string) {
  const profiles = await deps.repos.profiles.listProfiles(projectId);
  return Promise.all(
    profiles.map(async (profile) => {
      const trust = await deps.repos.trust.getState(profile.id);
      return {
        ...profile,
        capital: trust?.score ?? 50,
        trustStatus: trust?.status ?? 'active',
        lastActivityAt: trust?.lastActivityAt,
      };
    }),
  );
}

/** Spec §10 decision without a permit; observe-mode rules never block. */
export function decisionForResolution(resolution: PolicyResolution): HookDecision {
  if (resolution.observeOnly || resolution.level >= 4) return 'allow';
  return resolution.level === 3 ? 'ask' : 'deny';
}

/**
 * Simulation decision (spec §21.10: the console must answer like the MCP tool).
 * Read-only: it looks for a permit that already covers the action instead of
 * consuming one, and never writes to the journal.
 */
export async function decisionForSimulation(
  deps: ResolverDeps,
  action: ActionRequest,
  classification: Classification,
  resolution: PolicyResolution,
  profileId: string,
): Promise<HookDecision> {
  const base = decisionForResolution(resolution);
  if (base !== 'deny' || resolution.level > 2) return base;
  const permits = await deps.repos.permits.listPermits({
    projectId: action.projectId,
    issueKey: action.issueKey,
    profileId,
  });
  const nowIso = new Date().toISOString();
  const covered = permits.some(
    (permit) =>
      isUsablePermit(permit, nowIso) &&
      permit.scope.actionClass === classification.actionClass &&
      targetCovers(permit.scope.target, action.target),
  );
  return covered ? 'allow' : 'deny';
}

export function buildSimulatedAction(payload: any, context: any): ActionRequest {
  return {
    issueKey: issueKeyOf(payload, context),
    declaredClass: str(payload?.actionClass),
    target: typeof payload?.target === 'string' ? payload.target : '',
    command: str(payload?.command),
    description: str(payload?.description),
    environment: payload?.environment,
    issueType: str(payload?.issueType),
    hasAcceptanceCriteria: payload?.hasAcceptanceCriteria === true,
    incidentLinked: payload?.incidentLinked === true,
    projectId: projectIdOf(payload, context),
    at: new Date().toISOString(),
  };
}

export async function buildPolicyInput(
  deps: ResolverDeps,
  action: ActionRequest,
  classification: Classification,
  profileId: string,
): Promise<PolicyResolutionInput> {
  const projectId = action.projectId ?? 'unknown';
  const [rules, zones, switches, trust] = await Promise.all([
    deps.repos.policies.listRules(projectId),
    deps.repos.zones.listZones(projectId),
    deps.repos.killSwitches.listActive(projectId),
    deps.repos.trust.getState(profileId),
  ]);
  return {
    context: {
      action,
      classification,
      environment: action.environment,
      issueType: action.issueType,
      hasAcceptanceCriteria: action.hasAcceptanceCriteria === true,
      incidentLinked: action.incidentLinked === true,
      trustScore: trust?.score,
      at: action.at ?? new Date().toISOString(),
    },
    rules,
    zones,
    killSwitchActive: switches.some((s) => s.active),
    trustEffectsEnabled: true,
  };
}
