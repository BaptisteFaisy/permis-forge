/**
 * Unit tests for src/ui/resolvers.ts — the six Forge screens and their
 * mutations. Everything runs offline and deterministically: the storage port
 * is the in-memory adapter, the decision engine is a deterministic stub built
 * on the frozen action-class catalog, and the chain verifier is injected.
 */
import { createHash } from 'crypto';
import { defaultLevelFor } from '../src/core/catalog';
import {
  ActionRequest,
  ChainVerification,
  LedgerEntry,
  Permit,
  PolicyResolutionInput,
  Repositories,
} from '../src/core/types';
import { createMemoryRepositories } from '../src/storage/memory';
import { callResolver, createResolvers } from '../src/ui/resolvers';

const ACCOUNT = 'acc-1';
const OTHER_ACCOUNT = 'acc-2';
const PROJECT = 'PAY';
const ISSUE = 'PAY-42';
const ISSUE_CONTEXT = { extension: { issue: { key: ISSUE } } };
const FAR_FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2020-01-02T00:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Deterministic engine stub honouring the contract of the decision engine:
 * a migration path is always reclassified to A-08 (spec §7.3), the winner is
 * the most restrictive applicable rule, else the catalog default level.
 */
function createFakeEngine() {
  return {
    classifyAction(action: ActionRequest) {
      const isMigration = /migrations\//.test(action.target);
      const actionClass = isMigration ? 'A-08' : action.declaredClass ?? 'A-02';
      return {
        actionClass,
        declaredClass: action.declaredClass,
        reclassified: Boolean(action.declaredClass && action.declaredClass !== actionClass),
        reason: isMigration ? 'Migration path detected' : 'Declared class retained',
        confidence: 'deterministic' as const,
      };
    },
    resolvePolicy(input: PolicyResolutionInput) {
      const cls = input.context.classification.actionClass;
      if (input.killSwitchActive && cls !== 'A-01') {
        return { level: 0 as const, source: 'kill-switch' as const, reason: 'Emergency brake', observeOnly: false, consideredRules: [] };
      }
      const matching = input.rules.filter((r) => r.actionClass === cls);
      const winner = matching.sort((a, b) => a.level - b.level)[0];
      if (!winner) {
        const level = defaultLevelFor(cls);
        return { level, source: 'class-default' as const, reason: `Default N${level} for ${cls}`, observeOnly: false, consideredRules: [] };
      }
      return {
        level: winner.level,
        rule: winner,
        source: winner.scope === 'org' ? ('org-floor' as const) : ('project-rule' as const),
        reason: `Matched rule ${winner.id}`,
        observeOnly: winner.mode === 'observe',
        consideredRules: matching.map((r) => r.id),
      };
    },
  };
}

const okVerifyChain = (entries: LedgerEntry[]): ChainVerification => ({ valid: true, checked: entries.length });

function makeEntry(seq: number, overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq,
    at: '2026-11-10T10:00:00.000Z',
    kind: 'decision',
    projectId: PROJECT,
    issueId: ISSUE,
    profileId: 'claude-pay',
    actionClass: 'A-08',
    target: 'db/migrations/001.sql',
    decision: 'deny',
    prevHash: `prev-${seq}`,
    hash: `hash-${seq}`,
    ...overrides,
  };
}

function makeDeps(repos: Repositories = createMemoryRepositories(), verifyChain: any = okVerifyChain) {
  return { deps: { repos, engine: createFakeEngine(), verifyChain }, repos };
}

function permit(id: string, expiresAt: string): Permit {
  return {
    id,
    scope: { actionClass: 'A-03', target: 'test/*.ts', issueKey: ISSUE, projectId: PROJECT },
    holderProfileId: 'claude-pay',
    pilotAccountId: ACCOUNT,
    issuedAt: '2026-11-11T08:00:00.000Z',
    expiresAt,
    usesLeft: 1,
    signature: 'signature',
  };
}

describe('simulationConsole', () => {
  it('returns the expected decision for an A-08 migration target', async () => {
    const { deps } = makeDeps();
    const resolver = createResolvers(deps);

    const out = await callResolver(resolver, 'simulationConsole', {
      payload: { actionClass: 'A-02', target: 'db/migrations/002_add_users.sql', issueKey: 'PAY-12' },
      context: { accountId: ACCOUNT },
    });

    expect(out.classification.actionClass).toBe('A-08');
    expect(out.classification.reclassified).toBe(true);
    expect(out.resolution.level).toBe(2);
    expect(out.levelName).toBe('N2 — Third-party approval');
    expect(out.decision).toBe('deny');
    expect(out.wouldBlock).toBe(true);
  });

  it('lets an observe-mode rule through while still reporting it would block', async () => {
    const { deps, repos } = makeDeps();
    await repos.policies.upsertRule({
      id: 'obs-a08', scope: 'project', projectId: PROJECT, actionClass: 'A-08', level: 2, mode: 'observe',
    });

    const out = await callResolver(createResolvers(deps), 'simulationConsole', {
      payload: { target: 'db/migrations/003.sql', projectId: PROJECT },
    });

    expect(out.decision).toBe('allow');
    expect(out.wouldBlock).toBe(true);
    expect(out.resolution.observeOnly).toBe(true);
  });

  it('applies the project emergency brake and falls back to evaluateAction', async () => {
    const repos = createMemoryRepositories();
    await repos.killSwitches.save({ scope: 'project', projectId: PROJECT, active: true, by: ACCOUNT, reason: 'Drill' });
    const evaluateAction = jest.fn(async (action: ActionRequest) => ({
      level: 0 as const,
      decision: 'deny' as const,
      log: true,
      classification: { actionClass: 'A-08', reclassified: false, confidence: 'declared' as const },
      resolution: { level: 0 as const, source: 'kill-switch' as const, reason: 'Emergency brake', observeOnly: false, consideredRules: [] },
      reason: `Refused: ${action.target}`,
      guidance: 'Wait for the brake to be lifted',
      at: '2026-11-11T10:00:00.000Z',
    }));

    const out = await callResolver(createResolvers({ repos, engine: { evaluateAction }, verifyChain: okVerifyChain }), 'simulationConsole', {
      payload: { target: 'db/migrations/004.sql', projectId: PROJECT },
      context: { accountId: ACCOUNT },
    });

    expect(out.decision).toBe('deny');
    expect(out.wouldBlock).toBe(true);
    expect(evaluateAction).toHaveBeenCalledTimes(1);
  });
});

describe('projectSettings and its mutations', () => {
  it('returns the policy grid, zones, brake and settings', async () => {
    const { deps, repos } = makeDeps();
    await repos.policies.upsertRule({
      id: 'r1', scope: 'project', projectId: PROJECT, actionClass: 'A-08', level: 1, mode: 'enforce',
    });
    await repos.zones.upsertZone({ id: 'z1', projectId: PROJECT, name: 'Migrations', pathPatterns: ['**/migrations/**'] });

    const out = await callResolver(createResolvers(deps), 'projectSettings', { payload: { projectId: PROJECT } });

    expect(out.projectId).toBe(PROJECT);
    expect(out.rules).toHaveLength(1);
    expect(out.rules[0]).toMatchObject({ id: 'r1', level: 1, className: 'Schema migration' });
    expect(out.rules[0].levelName).toContain('N1');
    expect(out.zones[0]).toMatchObject({ id: 'z1', name: 'Migrations' });
    expect(out.killSwitch).toMatchObject({ scope: 'project', active: false });
    expect(out.settings).toMatchObject({ trustEffectsEnabled: true, defaultPermitTtlMinutes: 120 });
    expect(out.catalog[0]).toMatchObject({ code: 'A-01', defaultLevel: 5 });
  });

  it('creates, updates and deletes a rule via saveRule and deleteRule', async () => {
    const { deps, repos } = makeDeps();
    const resolver = createResolvers(deps);

    const saved = await callResolver(resolver, 'saveRule', {
      payload: { projectId: PROJECT, rule: { id: 'rule-mig', actionClass: 'A-08', level: 2, mode: 'enforce', approverRole: 'dba' } },
    });
    expect(saved.ok).toBe(true);
    expect(await repos.policies.listRules(PROJECT)).toHaveLength(1);

    const updated = await callResolver(resolver, 'saveRule', {
      payload: { projectId: PROJECT, rule: { id: 'rule-mig', actionClass: 'A-08', level: 0, mode: 'enforce' } },
    });
    expect(updated.rule.level).toBe(0);
    expect(await repos.policies.listRules(PROJECT)).toHaveLength(1);

    expect(await callResolver(resolver, 'deleteRule', { payload: { id: 'rule-mig' } })).toEqual({ ok: true, id: 'rule-mig' });
    expect(await repos.policies.listRules(PROJECT)).toHaveLength(0);
    expect(await callResolver(resolver, 'deleteRule', { payload: {} })).toEqual({ ok: false, error: 'MISSING_RULE_ID' });
    expect(await callResolver(resolver, 'saveRule', { payload: { projectId: PROJECT } })).toEqual({ ok: false, error: 'INVALID_RULE' });
  });

  it('saves and deletes a zone via saveZone and deleteZone', async () => {
    const { deps, repos } = makeDeps();
    const resolver = createResolvers(deps);

    const saved = await callResolver(resolver, 'saveZone', {
      payload: { projectId: PROJECT, zone: { id: 'z-api', name: 'API', pathPatterns: ['api/**'], environment: 'production' } },
    });
    expect(saved.ok).toBe(true);
    expect(await repos.zones.listZones(PROJECT)).toHaveLength(1);

    expect(await callResolver(resolver, 'deleteZone', { payload: { zoneId: 'z-api' } })).toEqual({ ok: true, id: 'z-api' });
    expect(await repos.zones.listZones(PROJECT)).toHaveLength(0);
    expect(await callResolver(resolver, 'saveZone', { payload: { projectId: PROJECT } })).toEqual({ ok: false, error: 'INVALID_ZONE' });
  });

  it('requires a written reason and another person to lift the project brake', async () => {
    const { deps } = makeDeps();
    const resolver = createResolvers(deps);

    expect(await callResolver(resolver, 'toggleProjectKillSwitch', {
      payload: { projectId: PROJECT, activate: true, reason: '   ' }, context: { accountId: ACCOUNT },
    })).toEqual({ ok: false, error: 'REASON_REQUIRED' });

    const activated = await callResolver(resolver, 'toggleProjectKillSwitch', {
      payload: { projectId: PROJECT, activate: true, reason: 'Incident 101' }, context: { accountId: ACCOUNT },
    });
    expect(activated.killSwitch).toMatchObject({ active: true, by: ACCOUNT, reason: 'Incident 101' });

    expect(await callResolver(resolver, 'toggleProjectKillSwitch', {
      payload: { projectId: PROJECT, activate: false, reason: 'Resolved' }, context: { accountId: ACCOUNT },
    })).toEqual({ ok: false, error: 'DIFFERENT_PERSON_REQUIRED' });

    const lifted = await callResolver(resolver, 'toggleProjectKillSwitch', {
      payload: { projectId: PROJECT, activate: false, reason: 'Verified safe' }, context: { accountId: OTHER_ACCOUNT },
    });
    expect(lifted.killSwitch).toMatchObject({ active: false, by: OTHER_ACCOUNT });
  });
});

describe('issuePanel', () => {
  it('lists the ticket requests, live permits, last ten actions and deviations', async () => {
    const { deps, repos } = makeDeps();
    await repos.requests.create({
      id: 'RQ-2026-000001', issueId: ISSUE, projectId: PROJECT, profileId: 'claude-pay', pilotAccountId: ACCOUNT,
      actionClass: 'A-08', target: 'db/migrations/001.sql', level: 2, status: 'pending',
      createdAt: '2026-11-11T09:00:00.000Z', approvals: [],
    });
    await repos.permits.savePermit(permit('PA-2026-000001', FAR_FUTURE));
    await repos.permits.savePermit(permit('PA-2026-000002', PAST));
    for (let seq = 1; seq <= 12; seq += 1) {
      await repos.ledger.append(makeEntry(seq, { kind: seq === 11 ? 'deviation' : 'decision' }));
    }

    const out = await callResolver(createResolvers(deps), 'issuePanel', { context: ISSUE_CONTEXT });

    expect(out.issueKey).toBe(ISSUE);
    expect(out.projectId).toBe(PROJECT);
    expect(out.pendingRequests).toHaveLength(1);
    expect(out.pendingRequests[0]).toMatchObject({ id: 'RQ-2026-000001', level: 2, approvals: 0 });
    expect(out.activePermits.map((p: any) => p.id)).toEqual(['PA-2026-000001']);
    expect(out.recentActions).toHaveLength(10);
    expect(out.recentActions[0].seq).toBe(12);
    expect(out.deviations.map((d: any) => d.seq)).toEqual([11]);
  });

  it('stays empty when no ticket is in context', async () => {
    const { deps } = makeDeps();
    const out = await callResolver(createResolvers(deps), 'issuePanel', { context: {} });
    expect(out.pendingRequests).toEqual([]);
    expect(out.recentActions).toEqual([]);
  });
});

describe('projectPage, globalPage and verifyLedger', () => {
  it('paginates the journal and reports stats, agent capital and observation', async () => {
    const { deps, repos } = makeDeps();
    await repos.profiles.upsertProfile({ id: 'claude-pay', projectId: PROJECT, name: 'Claude Code', client: 'claude-code', status: 'active' });
    await repos.trust.saveState({ profileId: 'claude-pay', score: 78, status: 'active' });
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    await repos.ledger.append(makeEntry(1, { at: recent, detail: { level: 2, observeOnly: true } }));
    await repos.ledger.append(makeEntry(2, { at: recent, kind: 'action-declared', detail: undefined }));
    await repos.ledger.append(makeEntry(3, { at: recent, detail: { level: 5, observeOnly: true } }));

    const resolver = createResolvers(deps);
    const out = await callResolver(resolver, 'projectPage', {
      payload: { projectId: PROJECT, page: 1, pageSize: 2, filters: { kind: 'decision' } },
    });

    expect(out.total).toBe(2);
    expect(out.totalPages).toBe(1);
    expect(out.entries.map((e: any) => e.seq)).toEqual([3, 1]);
    expect(out.stats).toMatchObject({ totalEntries: 3, decisions: 2, agentProfiles: 1 });
    expect(out.agents[0]).toMatchObject({ id: 'claude-pay', capital: 78 });
    expect(out.observation).toMatchObject({ totalObserved: 2, wouldHaveBlocked: 1 });

    const page2 = await callResolver(resolver, 'projectPage', { payload: { projectId: PROJECT, page: 2, pageSize: 2 } });
    expect(page2.entries.map((e: any) => e.seq)).toEqual([1]);

    const verified = await callResolver(resolver, 'verifyLedger', { payload: { projectId: PROJECT } });
    expect(verified).toMatchObject({ ok: true, valid: true, checked: 3, summary: 'Chain valid: 3 entries verified' });
  });

  it('reports a broken chain through verifyLedger', async () => {
    const { deps, repos } = makeDeps();
    await repos.ledger.append(makeEntry(1));
    await repos.ledger.append(makeEntry(2, { hash: 'tampered' }));
    const brokenChain = (): ChainVerification => ({
      valid: false, checked: 2, firstBreak: { seq: 2, expectedHash: 'hash-2', actualHash: 'tampered' },
    });

    const out = await callResolver(createResolvers({ ...deps, verifyChain: brokenChain }), 'verifyLedger', {
      payload: { projectId: PROJECT },
    });

    expect(out.ok).toBe(false);
    expect(out.summary).toBe('Chain broken at seq 2: expected hash-2 actual tampered');
  });

  it('exposes the organisation floor and the organisation brake on globalPage', async () => {
    const { deps, repos } = makeDeps();
    await repos.policies.upsertRule({ id: 'org-a10', scope: 'org', actionClass: 'A-10', level: 0, mode: 'enforce' });
    await repos.policies.upsertRule({ id: 'org-a10-strict', scope: 'org', actionClass: 'A-10', level: 0, mode: 'enforce' });
    await repos.policies.upsertRule({ id: 'proj-rule', scope: 'project', projectId: PROJECT, actionClass: 'A-08', level: 2, mode: 'enforce' });
    await repos.killSwitches.save({ scope: 'org', active: true, by: 'security', reason: 'Drill' });

    const out = await callResolver(createResolvers(deps), 'globalPage', { payload: { projectId: PROJECT } });

    expect(out.killSwitch).toMatchObject({ scope: 'org', active: true });
    expect(out.orgRules.map((r: any) => r.id)).toEqual(['org-a10', 'org-a10-strict']);
    expect(out.floorByClass).toEqual({ 'A-10': 0 });
    expect(out.status).toMatchObject({ orgRuleCount: 2, emergencyStopActive: true });
  });
});

describe('personalSettings', () => {
  it('generates a token shown once and persists only its SHA-256 hash', async () => {
    const { deps, repos } = makeDeps();
    const resolver = createResolvers(deps);

    const created = await callResolver(resolver, 'personalSettings', {
      payload: { label: 'laptop' }, context: { accountId: ACCOUNT },
    });
    expect(typeof created.token).toBe('string');
    expect(created.token.length).toBeGreaterThan(20);
    expect(created.tokenHash).toBe(sha256(created.token));
    expect(created.tokens).toEqual([]);

    const stored = await repos.hookTokens.listForAccount(ACCOUNT);
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(created.tokenHash);
    expect(stored[0].label).toBe('laptop');
    expect(JSON.stringify(stored[0])).not.toContain(created.token);
    expect(await repos.hookTokens.findByTokenHash(created.tokenHash)).toBeDefined();

    const listed = await callResolver(resolver, 'personalSettings', {
      payload: { action: 'list' }, context: { accountId: ACCOUNT },
    });
    expect(listed.token).toBeUndefined();
    expect(listed.tokens.map((t: any) => t.tokenHash)).toEqual([created.tokenHash]);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it('keeps tokens isolated per account and issues one through generateHookToken', async () => {
    const { deps, repos } = makeDeps();
    const resolver = createResolvers(deps);

    await callResolver(resolver, 'personalSettings', { context: { accountId: ACCOUNT } });
    const other = await callResolver(resolver, 'personalSettings', { context: { accountId: OTHER_ACCOUNT } });
    expect(await repos.hookTokens.listForAccount(ACCOUNT)).toHaveLength(1);
    expect(other.token).not.toBeUndefined();

    const generated = await callResolver(resolver, 'generateHookToken', {
      payload: { label: 'ci', projectId: PROJECT }, context: { accountId: ACCOUNT },
    });
    expect(generated.ok).toBe(true);
    expect(generated.tokenHash).toBe(sha256(generated.token));
    expect(await repos.hookTokens.listForAccount(ACCOUNT)).toHaveLength(2);
  });
});

describe('callResolver', () => {
  it('rejects an unknown definition', async () => {
    const { deps } = makeDeps();
    await expect(callResolver(createResolvers(deps), 'noSuchScreen')).rejects.toThrow();
  });

  it('routes through a plain stub resolver without getDefinitions', async () => {
    const { deps } = makeDeps();
    const resolver = createResolvers(deps);
    const stub = { functions: { issuePanel: (resolver as any).functions.issuePanel } };

    const out = await callResolver(stub, 'issuePanel', { payload: { issueKey: ISSUE }, context: {} });

    expect(out.issueKey).toBe(ISSUE);
    await expect(callResolver(stub, 'projectPage')).rejects.toThrow(/no definition/i);
  });
});
