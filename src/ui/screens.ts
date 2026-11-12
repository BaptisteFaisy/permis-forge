/**
 * Read-only screen builders for the six Jira screens (spec §15).
 */
import { levelName } from '../core/catalog';
import { AgentCallContext, Decision } from '../core/types';
import { lintPolicy, summarizeFindings } from '../services/policy-lint';
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
  decisionForSimulation,
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
import { detectLang, statusLabel, t } from './i18n';
import { issueHookToken } from './mutations';
import type { ResolverDeps } from './resolvers';

/** Issue panel: pending requests, active permits, last 10 actions, deviations. */
export async function issuePanel(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const issueKey = issueKeyOf(payload, context);
  const projectId = projectIdOf(payload, context);
  const lang = detectLang(payload, context);
  const title = t(lang, 'screen.issuePanel.title');
  if (!issueKey) {
    return { lang, title, issueKey: undefined, projectId, pendingRequests: [], activePermits: [], recentActions: [], deviations: [] };
  }
  const nowIso = new Date().toISOString();
  const [pending, permits, entries] = await Promise.all([
    deps.repos.requests.listPending(issueKey),
    deps.repos.permits.listPermits({ issueKey }),
    deps.repos.ledger.list({ projectId, issueId: issueKey }),
  ]);
  const ordered = [...entries].sort((a, b) => b.seq - a.seq);
  const killSwitchActive = (await deps.repos.killSwitches.listActive(projectId)).some((s) => s.active);
  return {
    lang,
    title,
    issueKey,
    projectId,
    killSwitchBanner: killSwitchActive ? t(lang, 'banner.killSwitch') : undefined,
    pendingRequests: pending.map((r) => ({
      ...summarizeRequest(r, lang),
      statusLabel: statusLabel(lang, r.status),
    })),
    activePermits: permits.filter((p) => isUsablePermit(p, nowIso)).map(summarizePermit),
    recentActions: ordered.slice(0, RECENT_ACTIONS_LIMIT).map(summarizeEntry),
    deviations: ordered.filter((e) => e.kind === 'deviation' || e.kind === 'correction').map(summarizeEntry),
    actions: {
      grant: t(lang, 'action.grant'),
      deny: t(lang, 'action.deny'),
      clarify: t(lang, 'action.clarify'),
      revoke: t(lang, 'action.revoke'),
    },
  };
}

/** Project settings: policy grid, zones, kill switch, project settings. */
export async function projectSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const projectId = projectIdOf(payload, context);
  const lang = detectLang(payload, context);
  const [rules, zones, killSwitch] = await Promise.all([
    deps.repos.policies.listRules(projectId),
    deps.repos.zones.listZones(projectId),
    deps.repos.killSwitches.get('project', projectId),
  ]);
  const findings = lintPolicy({ projectId, rules, zones });
  return {
    lang,
    title: t(lang, 'screen.projectSettings.title'),
    projectId,
    rules: decorateRules(rules, lang),
    zones,
    killSwitch: killSwitch ?? { scope: 'project', projectId, active: false },
    killSwitchLabels: {
      activate: t(lang, 'action.activateKillSwitch'),
      lift: t(lang, 'action.liftKillSwitch'),
      banner: t(lang, 'banner.killSwitch'),
    },
    settings: {
      trustEffectsEnabled: true,
      defaultPermitTtlMinutes: DEFAULT_PERMIT_TTL_MINUTES,
      killSwitchRequiresDifferentPerson: true,
      maxLevelWithoutTicket: 4,
    },
    catalog: catalogSummary(lang),
    // The lint findings ride along with the policy grid: an administrator who
    // opens the settings screen sees the contradictions in the same call, with
    // no extra round trip. Messages are English, built by the pure linter.
    lint: {
      summary: summarizeFindings(findings),
      findings,
    },
  };
}

/** Project page: paginated journal, activity stats, agents, 30-day observation. */
export async function projectPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const projectId = projectIdOf(payload, context);
  const lang = detectLang(payload, context);
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
    lang,
    title: t(lang, 'screen.projectPage.title'),
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
  const lang = detectLang(payload, context);
  const action = buildSimulatedAction(payload, context);
  const engine = deps.engine as EngineLike;
  const profileId = profileIdOf(payload);
  const classify = pickMethod(engine, ['classifyAction', 'classify']);
  const resolve = pickMethod(engine, ['resolvePolicy', 'resolve']);
  if (classify && resolve) {
    const classification = await classify(action);
    const resolution = await resolve(await buildPolicyInput(deps, action, classification, profileId));
    const decision = await decisionForSimulation(deps, action, classification, resolution, profileId);
    return {
      classification,
      resolution,
      decision,
      wouldBlock: resolution.level < 4,
      level: resolution.level,
      levelName: levelName(resolution.level, lang),
      reason: resolution.reason,
      guidance: t(lang, 'notice.simulation'),
      lang,
      title: t(lang, 'screen.simulation.title'),
    };
  }
  const evaluate = pickMethod(engine, ['simulateAction', 'evaluateAction']);
  if (!evaluate) return { error: 'ENGINE_EVALUATION_UNAVAILABLE', message: t(lang, 'error.engineUnavailable'), lang };
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
    levelName: levelName(res.level, lang),
    reason: res.reason,
    guidance: res.guidance,
    lang,
    title: t(lang, 'screen.simulation.title'),
  };
}

/** Global page: organisation view, org kill switch, org floor rules, global status. */
export async function globalPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const lang = detectLang(payload, context);
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
    lang,
    title: t(lang, 'screen.globalPage.title'),
    killSwitch: killSwitch ?? { scope: 'org', active: false },
    killSwitchLabels: {
      activate: t(lang, 'action.activateKillSwitch'),
      lift: t(lang, 'action.liftKillSwitch'),
      banner: t(lang, 'banner.killSwitch'),
    },
    orgRules: decorateRules(orgRules, lang),
    floorByClass,
    status: {
      orgRuleCount: orgRules.length,
      emergencyStopActive: killSwitch?.active === true,
      classes: catalogSummary(lang).map((c) => ({ ...c, orgFloor: floorByClass[String(c.code)] })),
    },
  };
}

/** Personal settings: personal hook tokens of the current account (spec §16). */
export async function personalSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const accountId = accountIdOf(context);
  const lang = detectLang(payload, context);
  const existing = await deps.repos.hookTokens.listForAccount(accountId);
  const tokens = existing.map(({ tokenHash, label, createdAt, lastUsedAt }) => ({
    tokenHash,
    label,
    createdAt,
    lastUsedAt,
  }));
  // Listing only never exposes a plaintext token: it is shown once, at creation.
  if (payload?.action === 'list' || payload?.generate === false) {
    return {
      lang,
      title: t(lang, 'screen.personalSettings.title'),
      accountId,
      tokens,
      notice: t(lang, 'notice.onlyHashStored'),
      generateLabel: t(lang, 'action.generateToken'),
    };
  }
  const issued = await issueHookToken(deps, accountId, payload?.label);
  return {
    lang,
    title: t(lang, 'screen.personalSettings.title'),
    accountId,
    tokens,
    token: issued.token,
    tokenHash: issued.tokenHash,
    notice: t(lang, 'notice.tokenShownOnce'),
    generateLabel: t(lang, 'action.generateToken'),
  };
}
