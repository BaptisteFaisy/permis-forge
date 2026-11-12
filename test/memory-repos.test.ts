import {
  ApprovalRequest,
  HookToken,
  LedgerEntry,
  Permit,
  PolicyRule,
  Repositories,
  Zone,
} from '../src/core/types';
import {
  applySchema,
  createMemoryRepositories,
  createSqlRepositories,
  getDefaultRepositories,
  INIT_DEFAULT_RULES_SQL,
  resetDefaultRepositories,
  SCHEMA_DDL,
} from '../src/storage';

function sampleRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'rule-1',
    scope: 'project',
    projectId: 'PROJ',
    actionClass: 'A-08',
    level: 2,
    mode: 'enforce',
    ...overrides,
  };
}

function samplePermit(overrides: Partial<Permit> = {}): Permit {
  return {
    id: 'PA-2026-000001',
    scope: {
      actionClass: 'A-08',
      target: 'migrations/001.sql',
      issueKey: 'PROJ-10',
      projectId: 'PROJ',
    },
    holderProfileId: 'agent-1',
    pilotAccountId: 'user-1',
    issuedAt: '2026-11-11T10:00:00.000Z',
    expiresAt: '2026-11-11T12:00:00.000Z',
    usesLeft: 1,
    signature: 'sig-hex',
    ...overrides,
  };
}

function sampleEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq: 1,
    at: '2026-11-11T10:00:00.000Z',
    kind: 'decision',
    projectId: 'PROJ',
    prevHash: 'GENESIS',
    hash: 'h-1',
    ...overrides,
  };
}

function sampleRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'RQ-2026-000001',
    issueId: 'PROJ-10',
    projectId: 'PROJ',
    profileId: 'agent-1',
    pilotAccountId: 'user-1',
    actionClass: 'A-08',
    target: 'migrations/001.sql',
    level: 2,
    status: 'pending',
    createdAt: '2026-11-11T10:00:00.000Z',
    approvals: [],
    ...overrides,
  };
}

describe('schema DDL and seed rules', () => {
  it('defines the ten Forge SQL tables without foreign keys', () => {
    const tables = SCHEMA_DDL.filter((stmt) => stmt.startsWith('CREATE TABLE IF NOT EXISTS')).map(
      (stmt) => /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(stmt)?.[1],
    );
    // Pinned by name, not by count: a table nobody reads is a table nobody tests.
    expect(tables).toEqual([
      'policy_rule',
      'zone',
      'agent_profile',
      'request',
      'permit',
      'ledger',
      'trust_event',
      'kill_switch',
      'hook_token',
      'token_revocation',
    ]);
    for (const stmt of SCHEMA_DDL) {
      expect(stmt.toUpperCase()).not.toContain('FOREIGN KEY');
    }
  });

  it('seeds the critical organisation rules in enforce mode', () => {
    const joined = INIT_DEFAULT_RULES_SQL.join('\n');
    expect(INIT_DEFAULT_RULES_SQL).toHaveLength(5);
    for (const code of ['A-10', 'A-12', 'A-15', 'A-09', 'A-13']) {
      expect(joined).toContain(`'${code}'`);
    }
    expect(joined).toContain("'org'");
    expect(joined).toContain("'enforce'");
  });

  it('applies DDL and optional seed rules sequentially', async () => {
    const executed: string[] = [];
    await applySchema(async (sql: string) => {
      executed.push(sql);
    }, { withDefaultRules: true });
    expect(executed).toHaveLength(SCHEMA_DDL.length + INIT_DEFAULT_RULES_SQL.length);
  });
});

describe('memory repositories — policies, zones, profiles', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it('supports policy CRUD across org and project scopes with defensive copies', async () => {
    await repos.policies.upsertRule(sampleRule({ id: 'org-1', scope: 'org', projectId: undefined }));
    await repos.policies.upsertRule(sampleRule({ id: 'p1', projectId: 'PROJ', level: 2 }));
    await repos.policies.upsertRule(sampleRule({ id: 'p2', projectId: 'OTHER', level: 4 }));

    const projRules = await repos.policies.listRules('PROJ');
    expect(projRules.map((r) => r.id).sort()).toEqual(['org-1', 'p1']);

    // Mutating the returned object must not mutate stored state.
    projRules[0].level = 5;
    const afterMutation = await repos.policies.listRules('PROJ');
    expect(afterMutation.find((r) => r.id === 'p1')?.level).toBe(2);

    await repos.policies.upsertRule(sampleRule({ id: 'p1', projectId: 'PROJ', level: 1 }));
    expect((await repos.policies.listRules('PROJ')).find((r) => r.id === 'p1')?.level).toBe(1);

    await repos.policies.deleteRule('p1');
    expect((await repos.policies.listRules('PROJ')).map((r) => r.id)).toEqual(['org-1']);
  });

  it('supports zone CRUD and profile upsert/get/list', async () => {
    const zone: Zone = {
      id: 'z-db',
      projectId: 'PROJ',
      name: 'Migrations',
      pathPatterns: ['**/migrations/**'],
      environment: 'production',
    };
    await repos.zones.upsertZone(zone);
    zone.pathPatterns.push('mutated');
    const listedZones = await repos.zones.listZones('PROJ');
    expect(listedZones).toHaveLength(1);
    expect(listedZones[0].pathPatterns).toEqual(['**/migrations/**']);
    await repos.zones.deleteZone('z-db');
    expect(await repos.zones.listZones('PROJ')).toEqual([]);

    await repos.profiles.upsertProfile({
      id: 'agent-1',
      projectId: 'PROJ',
      name: 'Claude Code',
      client: 'claude-code',
      status: 'active',
    });
    expect(await repos.profiles.getProfile('PROJ', 'agent-1')).toMatchObject({ name: 'Claude Code' });
    expect(await repos.profiles.getProfile('OTHER', 'agent-1')).toBeUndefined();
    expect(await repos.profiles.listProfiles('PROJ')).toHaveLength(1);
  });
});

describe('memory repositories — permits', () => {
  it('increments permit sequence 1, 2, 3 per year and filters by issueKey', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.permits.nextPermitSequence(2026)).toBe(1);
    expect(await repos.permits.nextPermitSequence(2026)).toBe(2);
    expect(await repos.permits.nextPermitSequence(2026)).toBe(3);
    expect(await repos.permits.nextPermitSequence(2027)).toBe(1);

    await repos.permits.savePermit(samplePermit({ id: 'PA-2026-000001' }));
    await repos.permits.savePermit(samplePermit({
      id: 'PA-2026-000002',
      scope: { actionClass: 'A-08', target: 'migrations/002.sql', issueKey: 'PROJ-20', projectId: 'PROJ' },
      holderProfileId: 'agent-2',
    }));

    const byIssue = await repos.permits.listPermits({ issueKey: 'PROJ-10' });
    expect(byIssue.map((p) => p.id)).toEqual(['PA-2026-000001']);
    expect(await repos.permits.listPermits({ profileId: 'agent-2' })).toHaveLength(1);
    expect(await repos.permits.listPermits({ projectId: 'PROJ' })).toHaveLength(2);
  });
});

describe('memory repositories — ledger', () => {
  it('tracks lastEntry, appends in seq order, and filters by since/until/kind/limit', async () => {
    const repos = createMemoryRepositories();
    expect(await repos.ledger.lastEntry('PROJ')).toBeUndefined();

    await repos.ledger.append(sampleEntry({ seq: 2, at: '2026-11-11T10:02:00.000Z', kind: 'request', hash: 'h-2' }));
    await repos.ledger.append(sampleEntry({ seq: 1, at: '2026-11-11T10:01:00.000Z', kind: 'decision', hash: 'h-1' }));
    await repos.ledger.append(sampleEntry({ seq: 3, at: '2026-11-11T10:03:00.000Z', kind: 'approval', hash: 'h-3' }));
    await repos.ledger.append(sampleEntry({ seq: 4, at: '2026-11-11T10:04:00.000Z', kind: 'approval', hash: 'h-4' }));

    expect((await repos.ledger.lastEntry('PROJ'))?.seq).toBe(4);
    expect(await repos.ledger.lastEntry('OTHER')).toBeUndefined();

    const windowed = await repos.ledger.list({
      projectId: 'PROJ',
      since: '2026-11-11T10:02:00.000Z',
      until: '2026-11-11T10:03:00.000Z',
    });
    expect(windowed.map((e) => e.seq)).toEqual([2, 3]);

    const approvals = await repos.ledger.list({ kind: 'approval', limit: 1 });
    expect(approvals.map((e) => e.seq)).toEqual([3]);
  });
});

describe('memory repositories — requests', () => {
  it('generates sequential ids, supports create/get/update and filters listPending', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.requests.nextRequestSequence(2026)).toBe(1);
    expect(await repos.requests.nextRequestSequence(2026)).toBe(2);

    const r1 = sampleRequest({ id: 'RQ-2026-000001', issueId: 'PROJ-10', status: 'pending' });
    const r2 = sampleRequest({ id: 'RQ-2026-000002', issueId: 'PROJ-20', status: 'pending' });
    await repos.requests.create(r1);
    await repos.requests.create(r2);

    expect((await repos.requests.get('RQ-2026-000001'))?.issueId).toBe('PROJ-10');
    expect(await repos.requests.listPending()).toHaveLength(2);
    expect((await repos.requests.listPending('PROJ-20')).map((r) => r.id)).toEqual(['RQ-2026-000002']);

    await repos.requests.update({ ...r1, status: 'granted' });
    expect((await repos.requests.get('RQ-2026-000001'))?.status).toBe('granted');
    expect((await repos.requests.listPending()).map((r) => r.id)).toEqual(['RQ-2026-000002']);
  });
});

describe('memory repositories — trust, kill switches, hook tokens', () => {
  it('stores trust state (undefined by default) and ordered trust events', async () => {
    const repos = createMemoryRepositories();
    expect(await repos.trust.getState('agent-1')).toBeUndefined();

    await repos.trust.saveState({
      profileId: 'agent-1',
      score: 62,
      status: 'active',
      lastActivityAt: '2026-11-11T10:00:00.000Z',
    });
    expect(await repos.trust.getState('agent-1')).toEqual({
      profileId: 'agent-1',
      score: 62,
      status: 'active',
      lastActivityAt: '2026-11-11T10:00:00.000Z',
    });

    await repos.trust.recordEvent({
      profileId: 'agent-1',
      kind: 'permit-honored',
      delta: 2,
      at: '2026-11-11T10:00:00.000Z',
    });
    expect(await repos.trust.listEvents('agent-1')).toHaveLength(1);
  });

  it('tracks org and project kill switches and filters listActive', async () => {
    const repos = createMemoryRepositories();
    expect(await repos.killSwitches.get('org')).toBeUndefined();

    await repos.killSwitches.save({ scope: 'org', active: true, by: 'admin', reason: 'drill' });
    await repos.killSwitches.save({ scope: 'project', projectId: 'PROJ', active: true, by: 'lead' });
    await repos.killSwitches.save({ scope: 'project', projectId: 'OTHER', active: true, by: 'lead' });
    await repos.killSwitches.save({ scope: 'project', projectId: 'OFF', active: false, by: 'lead' });

    expect((await repos.killSwitches.get('project', 'PROJ'))?.active).toBe(true);
    const activeForProj = await repos.killSwitches.listActive('PROJ');
    expect(activeForProj.map((k) => `${k.scope}:${k.projectId ?? 'org'}`).sort()).toEqual([
      'org:org',
      'project:PROJ',
    ]);
  });

  it('saves hook tokens, looks them up by hash, and updates lastUsedAt', async () => {
    const repos = createMemoryRepositories();
    const token: HookToken = {
      accountId: 'acc-1',
      tokenHash: 'hash-abc',
      label: 'laptop',
      createdAt: '2026-11-11T09:00:00.000Z',
    };
    await repos.hookTokens.save(token);

    expect(await repos.hookTokens.findByTokenHash('missing')).toBeUndefined();
    expect((await repos.hookTokens.findByTokenHash('hash-abc'))?.lastUsedAt).toBeUndefined();

    await repos.hookTokens.touchLastUsed('hash-abc', '2026-11-11T11:00:00.000Z');
    const touched = await repos.hookTokens.findByTokenHash('hash-abc');
    expect(touched?.lastUsedAt).toBe('2026-11-11T11:00:00.000Z');
    expect(touched?.label).toBe('laptop');
    expect(await repos.hookTokens.listForAccount('acc-1')).toHaveLength(1);
  });
});

describe('storage facade and SQL adapter', () => {
  afterEach(() => {
    resetDefaultRepositories();
  });

  it('returns an in-memory singleton outside Forge runtime', () => {
    const prev = process.env.FORGE_ENVIRONMENT;
    delete process.env.FORGE_ENVIRONMENT;
    try {
      const a = getDefaultRepositories();
      const b = getDefaultRepositories();
      expect(a).toBe(b);
    } finally {
      if (prev !== undefined) process.env.FORGE_ENVIRONMENT = prev;
    }
  });

  it('serializes JSON fields and maps rows via a mock SQL client', async () => {
    const calls: { query: string; params: unknown[] }[] = [];
    const client = {
      async execute(query: string, params: unknown[] = []) {
        calls.push({ query, params });
        if (query.startsWith('SELECT') && query.includes('`policy_rule`')) {
          return {
            rows: [{
              id: 'r-1',
              scope: 'project',
              project_id: 'PROJ',
              action_class: 'A-08',
              zone_id: 'z-1',
              conditions_json: JSON.stringify({ environments: ['production'] }),
              level: 2,
              mode: 'enforce',
            }],
          };
        }
        return { rows: [] };
      },
    };

    const sqlRepos = createSqlRepositories(client);
    await sqlRepos.policies.upsertRule(sampleRule({
      conditions: { environments: ['production'] },
      zoneId: 'z-1',
    }));
    const rules = await sqlRepos.policies.listRules('PROJ');

    expect(calls[0].params).toContain('{"environments":["production"]}');
    expect(rules[0].conditions).toEqual({ environments: ['production'] });
  });
});
