/**
 * Forge UI resolvers for the six Jira screens (spec §15) and their mutations.
 *
 * Screens are read-only; writes go through explicit mutations (policy rules,
 * zones, project emergency brake, personal hook tokens, ledger verification).
 * Caller identity always comes from the Forge context, never from the payload,
 * and every repository and engine call is injected so the screens stay testable
 * offline (no Forge runtime, no database).
 */
import { createHash, randomBytes } from 'crypto';
import Resolver from '@forge/resolver';
import { ACTION_CLASSES, className, levelName } from '../core/catalog';
import {
  ActionRequest, AgentCallContext, ChainVerification, Classification, Decision, HookDecision,
  LedgerEntry, LedgerFilter, Permit, PolicyResolution, PolicyResolutionInput, PolicyRule,
  Repositories, Zone,
} from '../core/types';
import { summarize30DayObservation, verifyLedgerIntegrity } from './audit';

const RECENT_ACTIONS_LIMIT = 10;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const DEFAULT_PERMIT_TTL_MINUTES = 120;
const TOKEN_NOTICE = 'This token is shown once. Store it in PERMIS_AGENT_TOKEN.';

/** Structural view of the injected engine: the pure pair, else the pipeline. */
interface EngineLike {
  classifyAction?: (action: ActionRequest) => Promise<Classification> | Classification;
  classify?: (action: ActionRequest) => Promise<Classification> | Classification;
  resolvePolicy?: (input: PolicyResolutionInput) => Promise<PolicyResolution> | PolicyResolution;
  resolve?: (input: PolicyResolutionInput) => Promise<PolicyResolution> | PolicyResolution;
  simulateAction?: (action: ActionRequest, caller: AgentCallContext) => Promise<Decision> | Decision;
  evaluateAction?: (action: ActionRequest, caller: AgentCallContext) => Promise<Decision> | Decision;
}

export interface ResolverDeps {
  repos: Repositories;
  engine: any;
  verifyChain: any;
}

type ScreenResult = Record<string, unknown>;
type DefineFn = (key: string, handler: (request: any) => Promise<unknown>) => void;

// --------------------------------------------------------------- call context

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function issueKeyOf(payload: any, context: any): string | undefined {
  return str(context?.extension?.issue?.key) ?? str(payload?.issueKey);
}

function projectIdOf(payload: any, context: any): string {
  const direct = str(payload?.projectId) ?? str(payload?.projectKey) ?? str(context?.extension?.project?.key);
  if (direct) return direct;
  const issueKey = issueKeyOf(payload, context);
  return issueKey && issueKey.includes('-') ? issueKey.split('-')[0] : 'unknown';
}

function accountIdOf(context: any): string {
  return str(context?.accountId) ?? str(context?.extension?.accountId) ?? 'unknown';
}

/** A named agent profile: naming one grants no right by itself (spec §16). */
function profileIdOf(payload: any): string {
  return str(payload?.agentProfile) ?? str(payload?.profileId) ?? 'default';
}

/** Identifier the UI may send under several names. */
function idOf(payload: any, aliases: string[]): string {
  for (const key of aliases) {
    const value = str(payload?.[key]);
    if (value) return value;
  }
  return '';
}

function pickMethod(engine: any, names: string[]): ((...args: any[]) => any) | undefined {
  for (const name of names) {
    if (typeof engine?.[name] === 'function') return engine[name].bind(engine);
  }
  return undefined;
}

// ------------------------------------------------------------------- view maps

function isUsablePermit(permit: Permit, nowIso: string): boolean {
  return !permit.revokedAt && permit.suspended !== true && permit.usesLeft > 0 && permit.expiresAt > nowIso;
}

function summarizeEntry(entry: LedgerEntry): Record<string, unknown> {
  const { seq, at, kind, issueId, profileId, actionClass, target, ruleId, decision, permitId } = entry;
  return { seq, at, kind, issueId, profileId, actionClass, target, ruleId, decision, permitId };
}

function summarizePermit(permit: Permit): Record<string, unknown> {
  return { id: permit.id, ...permit.scope, issuedAt: permit.issuedAt, expiresAt: permit.expiresAt,
    usesLeft: permit.usesLeft, suspended: permit.suspended === true };
}

function summarizeRequest(request: any): Record<string, unknown> {
  return {
    id: request.id, actionClass: request.actionClass, target: request.target, level: request.level,
    levelName: levelName(request.level, 'en'), status: request.status, createdAt: request.createdAt,
    approvals: (request.approvals ?? []).length,
  };
}

function countBy<T>(items: T[], keyOf: (item: T) => string | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function catalogSummary(): Record<string, unknown>[] {
  return ACTION_CLASSES.map(({ code, nameEn, defaultLevel, locked }) => ({
    code, name: nameEn, defaultLevel, locked: locked === true,
  }));
}

function decorateRules(rules: PolicyRule[]) {
  return rules.map((r) => ({ ...r, className: className(r.actionClass, 'en'), levelName: levelName(r.level, 'en') }));
}

// ------------------------------------------------------------------- §15 screens

/** Issue panel: pending requests, live permits, last 10 actions, deviations. */
async function issuePanel(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
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

/** Project settings: policy grid, zones, project brake, project settings. */
async function projectSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
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

function buildLedgerFilter(projectId: string, filters: any = {}): LedgerFilter {
  const filter: LedgerFilter = { projectId };
  const keys = ['kind', 'actionClass', 'profileId', 'issueId', 'since', 'until'] as const;
  for (const key of keys) {
    const value = str(filters?.[key]);
    if (value) (filter as Record<string, unknown>)[key] = value;
  }
  return filter;
}

function buildStats(projectId: string, entries: LedgerEntry[], permits: Permit[],
  requests: { projectId: string; status: string }[], profileCount: number): Record<string, unknown> {
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

async function loadAgentStandings(deps: ResolverDeps, projectId: string) {
  const profiles = await deps.repos.profiles.listProfiles(projectId);
  return Promise.all(profiles.map(async (profile) => {
    const trust = await deps.repos.trust.getState(profile.id);
    return { ...profile, capital: trust?.score ?? 50, trustStatus: trust?.status ?? 'active',
      lastActivityAt: trust?.lastActivityAt };
  }));
}

/** Project page: paginated journal, activity stats, agents, 30-day report. */
async function projectPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const projectId = projectIdOf(payload, context);
  const page = Math.max(1, Number(payload?.page ?? 1) || 1);
  const size = Number(payload?.pageSize ?? DEFAULT_PAGE_SIZE) || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, size));
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

/** Spec §10 decision when no permit covers the action; observe mode never blocks. */
function decisionForResolution(resolution: PolicyResolution): HookDecision {
  if (resolution.observeOnly || resolution.level >= 4) return 'allow';
  return resolution.level === 3 ? 'ask' : 'deny';
}

function buildSimulatedAction(payload: any, context: any): ActionRequest {
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

async function buildPolicyInput(deps: ResolverDeps, action: ActionRequest,
  classification: Classification, profileId: string): Promise<PolicyResolutionInput> {
  const projectId = action.projectId ?? 'unknown';
  const [rules, zones, switches, trust] = await Promise.all([
    deps.repos.policies.listRules(projectId),
    deps.repos.zones.listZones(projectId),
    deps.repos.killSwitches.listActive(projectId),
    deps.repos.trust.getState(profileId),
  ]);
  return {
    context: {
      action, classification, environment: action.environment, issueType: action.issueType,
      hasAcceptanceCriteria: action.hasAcceptanceCriteria === true,
      incidentLinked: action.incidentLinked === true,
      trustScore: trust?.score, at: action.at ?? new Date().toISOString(),
    },
    rules,
    zones,
    killSwitchActive: switches.some((s) => s.active),
    trustEffectsEnabled: true,
  };
}

function formatSimulation(
  classification: Classification,
  resolution: PolicyResolution,
  decision: HookDecision,
  reason: string,
  guidance: string,
): ScreenResult {
  return {
    classification,
    resolution,
    decision,
    // Below N4 the action stops at the enforcement point (same test as PA-13).
    wouldBlock: resolution.level < 4,
    level: resolution.level,
    levelName: levelName(resolution.level, 'en'),
    reason,
    guidance,
  };
}

/** Simulation console: classify a candidate action and resolve its autonomy level. */
async function simulationConsole(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const action = buildSimulatedAction(payload, context);
  const engine = deps.engine as EngineLike;
  const profileId = profileIdOf(payload);
  const classify = pickMethod(engine, ['classifyAction', 'classify']);
  const resolve = pickMethod(engine, ['resolvePolicy', 'resolve']);
  if (classify && resolve) {
    const classification = await classify(action);
    const resolution = await resolve(await buildPolicyInput(deps, action, classification, profileId));
    return formatSimulation(
      classification, resolution, decisionForResolution(resolution),
      resolution.reason, 'Simulated only: nothing was written, no permit was consumed.',
    );
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
  return formatSimulation(res.classification, res.resolution, res.decision, res.reason, res.guidance);
}

/** Global page: organisation view, org brake, org floor rules, global status. */
async function globalPage(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
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

/** Issue a personal hook token: only its SHA-256 hash is stored (spec §16). */
async function issueHookToken(deps: ResolverDeps, accountId: string, label?: string) {
  const token = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await deps.repos.hookTokens.save({ accountId, tokenHash, label, createdAt: new Date().toISOString() });
  return { token, tokenHash };
}

/** Personal settings: hook tokens of the current account, plaintext shown once. */
async function personalSettings(deps: ResolverDeps, payload: any, context: any): Promise<ScreenResult> {
  const accountId = accountIdOf(context);
  const existing = await deps.repos.hookTokens.listForAccount(accountId);
  const tokens = existing.map(({ tokenHash, label, createdAt, lastUsedAt }) => ({
    tokenHash, label, createdAt, lastUsedAt,
  }));
  // Listing never re-exposes a plaintext token: it is shown once, at creation.
  if (payload?.action === 'list' || payload?.generate === false) {
    return { accountId, tokens, notice: 'Only the hash of a token is stored (spec §16).' };
  }
  const issued = await issueHookToken(deps, accountId, str(payload?.label));
  return { accountId, tokens, token: issued.token, tokenHash: issued.tokenHash, notice: TOKEN_NOTICE };
}

// -------------------------------------------------------------------- mutations

function toPolicyRule(payload: any, projectId: string): PolicyRule | null {
  const source = payload?.rule ?? payload;
  const actionClass = str(source?.actionClass);
  const level = Number(source?.level);
  if (!actionClass || !Number.isInteger(level) || level < 0 || level > 5) return null;
  const scope = source?.scope === 'org' ? 'org' : 'project';
  return {
    id: str(source?.id) ?? `rule-${actionClass}`,
    scope,
    projectId: scope === 'project' ? projectId : undefined,
    actionClass,
    zoneId: str(source?.zoneId),
    conditions: source?.conditions,
    level: level as PolicyRule['level'],
    mode: source?.mode === 'observe' ? 'observe' : 'enforce',
    approverRole: str(source?.approverRole),
  };
}

function toZone(payload: any, projectId: string): Zone | null {
  const source = payload?.zone ?? payload;
  const name = str(source?.name);
  if (!name) return null;
  return {
    id: str(source?.id) ?? `zone-${name}`,
    projectId,
    name,
    pathPatterns: Array.isArray(source?.pathPatterns) ? source.pathPatterns.map(String) : [],
    component: str(source?.component),
    environment: source?.environment,
  };
}

/** Project brake: a written reason is mandatory, lifting may need another person (§12). */
async function handleToggleKillSwitch(deps: ResolverDeps, payload: any, context: any) {
  const projectId = projectIdOf(payload, context);
  const activate = payload?.activate === true;
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
  const by = accountIdOf(context);
  if (!reason) return { ok: false, error: 'REASON_REQUIRED' };
  const current = await deps.repos.killSwitches.get('project', projectId);
  if (!activate && payload?.requireDifferentPerson !== false && current?.active && current.by === by) {
    return { ok: false, error: 'DIFFERENT_PERSON_REQUIRED' };
  }
  const killSwitch = { scope: 'project' as const, projectId, active: activate, by, reason, at: new Date().toISOString() };
  await deps.repos.killSwitches.save(killSwitch);
  return { ok: true, killSwitch };
}

function registerMutations(define: DefineFn, deps: ResolverDeps): void {
  define('saveRule', async ({ payload, context }: any) => {
    const rule = toPolicyRule(payload, projectIdOf(payload, context));
    if (!rule) return { ok: false, error: 'INVALID_RULE' };
    await deps.repos.policies.upsertRule(rule);
    return { ok: true, rule };
  });
  define('deleteRule', async ({ payload }: any) => {
    const id = idOf(payload, ['id', 'ruleId']);
    if (!id) return { ok: false, error: 'MISSING_RULE_ID' };
    await deps.repos.policies.deleteRule(id);
    return { ok: true, id };
  });
  define('saveZone', async ({ payload, context }: any) => {
    const zone = toZone(payload, projectIdOf(payload, context));
    if (!zone) return { ok: false, error: 'INVALID_ZONE' };
    await deps.repos.zones.upsertZone(zone);
    return { ok: true, zone };
  });
  define('deleteZone', async ({ payload }: any) => {
    const id = idOf(payload, ['id', 'zoneId']);
    if (!id) return { ok: false, error: 'MISSING_ZONE_ID' };
    await deps.repos.zones.deleteZone(id);
    return { ok: true, id };
  });
  define('toggleProjectKillSwitch', ({ payload, context }: any) => handleToggleKillSwitch(deps, payload, context));
  define('generateHookToken', async ({ payload, context }: any) => {
    const issued = await issueHookToken(deps, accountIdOf(context), str(payload?.label));
    return { ok: true, ...issued, notice: TOKEN_NOTICE };
  });
  define('verifyLedger', async ({ payload, context }: any) => {
    const entries = await deps.repos.ledger.list({ projectId: projectIdOf(payload, context) });
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);
    const v = verifyLedgerIntegrity(ordered, deps.verifyChain as (e: LedgerEntry[]) => ChainVerification);
    return { ok: v.valid, ...v };
  });
}

/** Register every screen and mutation on one Forge Resolver instance. */
export function createResolvers(deps: ResolverDeps): Resolver {
  const resolver = new Resolver();
  const define: DefineFn = (key, handler) => {
    try { resolver.define(key, handler); }
    catch (error) { if (!/already exists/.test(String(error))) throw error; }
  };
  const screens = { issuePanel, projectSettings, projectPage, simulationConsole, globalPage, personalSettings };
  for (const [name, screen] of Object.entries(screens)) define(name, ({ payload, context }: any) => screen(deps, payload, context));
  registerMutations(define, deps);
  return resolver;
}

/** Invoke a resolver definition directly, without the Forge runtime. */
export async function callResolver(resolver: any, name: string,
  req: { payload?: any; context?: any } = {}): Promise<any> {
  const payload = req.payload ?? {};
  const context = req.context ?? {};
  if (typeof resolver?.getDefinitions === 'function') {
    const definitions = resolver.getDefinitions();
    const backendPayload = { principal: { accountId: context.accountId }, installContext: context.installContext };
    return definitions({ call: { functionKey: name, payload }, context }, backendPayload);
  }
  const handler = resolver?.functions?.[name];
  if (typeof handler !== 'function') throw new Error(`Resolver has no definition for '${name}'.`);
  return handler({ payload, context });
}
