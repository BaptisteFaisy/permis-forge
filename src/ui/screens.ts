/**
 * Read-only screen builders for the six Jira screens (spec §15).
 */
import { levelName } from '../core/catalog';
import { AgentCallContext, Decision } from '../core/types';
import { summarize30DayObservation } from './audit';
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PERMIT_TTL_MINUTES,
  EngineLike,
  MAX_PAGE_SIZE,
  RECENT_ACTIONS_LIMIT,
  ScreenResult,
  accountIdOf,
  buildLedgerFilter,
  buildPolicyInput,
  buildSimulatedAction,
  buildStats,
  catalogSummary,
  decisionForResolution,
  decorateRules,
  isUsablePermit,
  issueKeyOf,
  loadAgentStandings,
  pickMethod,
  profileIdOf,
  projectIdOf,
  summarizeEntry,
  summarizePermit,
  summarizeRequest,
} from './format';
import { issueHookToken } from './mutations';
import type { ResolverDeps } from './resolvers';

/** Issue panel: pending requests, active permits, last 10 actions, deviations. */
export async function issuePanel(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const issueKey = issueKeyOf(payload, context);
  const projectId = projectIdOf(payload, context);
  if (!issueKey) {
    return { issueKey: undefined, projectId, pendingRequests: [], activePermits: [], recentActions: [], deviations: [] };
  }
  const nowIso = new Date().toISOString();
  const [pending, permits, entries] = await Promise.all([
    deps.repos.requests.listPending(issueKey),
    deps.repos.permits.listPermits({ issueKey }),
    deps.repos.ledger.list({ projectId, issueId: issueKey }),
  ]);
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);
  return {
    issueKey,
    projectId,
    pendingRequests: pending.map(summarizeRequest),
    activePermits: permits.filter((p) => isUsablePermit(p, nowIso)).map(summarizePermit),
    recentActions: ordered.slice(0, RECENT_ACTIONS_LIMIT).map(summarizeEntry),
    deviations: ordered.filter((e) => e.kind === 'deviation' || e.kind === 'correction').map(summarizeEntry),
  };
}

/** Project settings: policy grid, zones, kill switch, project settings. */
export async function projectSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const projectId = projectIdOf(payload, context);
  const [rules, zones, killSwitch] = await Promise.all([
    deps.repos.policies.listRules(projectId),
    deps.repos.zones.listZones(projectId),
    deps.repos.killSwitches.get('project', projectId),
  ]);
  return {
    projectId,
    rules: decorateRules(rules),
    zones,
    killSwitch: killSwitch ?? { scope: 'project', projectId, active: false },
    settings: {
      trustEffectsEnabled: true,
      defaultPermitTtlMinutes: DEFAULT_PERMIT_TTL_MINUTES,
      killSwitchRequiresDifferentPerson: true,
      maxLevelWithoutTicket: 4,
    },
    catalog: catalogSummary(),
  };
}

/** Project page: paginated journal, activity stats, agents, 30-day observation. */
export async function projectPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const projectId = projectIdOf(payload, context);
  const page = Math.max(1, Number(payload?.page ?? 1) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(payload?.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE));
  const [filtered, allEntries, permits, requests, agents] = await Promise.all([
    deps.repos.ledger.list(buildLedgerFilter(projectId, payload?.filters)),
    deps.repos.ledger.list({ projectId }),
    deps.repos.permits.listPermits({ projectId }),
    deps.repos.requests.listPending(),
    loadAgentStandings(deps, projectId),
  ]);
  const ordered = [...filtered].sort((a, b) => b.seq - a.seq);
  const start = (page - 1) * pageSize;
  const ascEntries = [...allEntries].sort((a, b) => a.seq - b.seq);
  return {
    projectId,
    page,
    pageSize,
    total: ordered.length,
    totalPages: Math.max(1, Math.ceil(ordered.length / pageSize)),
    entries: ordered.slice(start, start + pageSize).map(summarizeEntry),
    stats: buildStats(projectId, ascEntries, permits, requests, agents.length),
    agents,
    observation: summarize30DayObservation(allEntries),
  };
}

/** Simulation console: full classification + policy resolution without side effects. */
export async function simulationConsole(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const action = buildSimulatedAction(payload, context);
  const engine = deps.engine as EngineLike;
  const profileId = profileIdOf(payload);
  const classify = pickMethod(engine, ['classifyAction', 'classify']);
  const resolve = pickMethod(engine, ['resolvePolicy', 'resolve']);
  if (classify && resolve) {
    const classification = await classify(action);
    const resolution = await resolve(await buildPolicyInput(deps, action, classification, profileId));
    const decision = decisionForResolution(resolution);
    return {
      classification,
      resolution,
      decision,
      wouldBlock: resolution.level < 4,
      level: resolution.level,
      levelName: levelName(resolution.level, 'en'),
      reason: resolution.reason,
      guidance: 'Simulated only: nothing was written, no permit was consumed.',
    };
  }
  const evaluate = pickMethod(engine, ['simulateAction', 'evaluateAction']);
  if (!evaluate) return { error: 'ENGINE_EVALUATION_UNAVAILABLE' };
  const caller: AgentCallContext = {
    projectId: action.projectId ?? 'unknown',
    issueKey: action.issueKey,
    profileId,
    pilot: { accountId: accountIdOf(context), roles: [] },
    via: 'console',
  };
  const res = (await evaluate(action, caller)) as Decision;
  return {
    classification: res.classification,
    resolution: res.resolution,
    decision: res.decision,
    wouldBlock: res.level < 4,
    level: res.level,
    levelName: levelName(res.level, 'en'),
    reason: res.reason,
    guidance: res.guidance,
  };
}

/** Global page: organisation view, org kill switch, org floor rules, global status. */
export async function globalPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const [rules, killSwitch] = await Promise.all([
    deps.repos.policies.listRules(projectIdOf(payload, context)),
    deps.repos.killSwitches.get('org'),
  ]);
  const orgRules = rules.filter((r) => r.scope === 'org');
  const floorByClass: Record<string, number> = {};
  for (const r of orgRules) {
    floorByClass[r.actionClass] = Math.min(floorByClass[r.actionClass] ?? 5, r.level);
  }
  return {
    killSwitch: killSwitch ?? { scope: 'org', active: false },
    orgRules: decorateRules(orgRules),
    floorByClass,
    status: {
      orgRuleCount: orgRules.length,
      emergencyStopActive: killSwitch?.active === true,
      classes: catalogSummary().map((c) => ({ ...c, orgFloor: floorByClass[String(c.code)] })),
    },
  };
}

/** Personal settings: personal hook tokens of the current account (spec §16). */
export async function personalSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const accountId = accountIdOf(context);
  const existing = await deps.repos.hookTokens.listForAccount(accountId);
  const tokens = existing.map(({ tokenHash, label, createdAt, lastUsedAt }) => ({
    tokenHash,
    label,
    createdAt,
    lastUsedAt,
  }));
  // Listing only never exposes a plaintext token: it is shown once, at creation.
  if (payload?.action === 'list' || payload?.generate === false) {
    return { accountId, tokens, notice: 'Only the hash of a token is stored (spec §16).' };
  }
  const issued = await issueHookToken(deps, accountId, payload?.label);
  return {
    accountId,
    tokens,
    token: issued.token,
    tokenHash: issued.tokenHash,
    notice: 'This token is shown once. Store it in PERMIS_AGENT_TOKEN.',
  };
}
