import {
  PolicyContext,
  PolicyResolutionInput,
  PolicyRule,
  Zone,
} from '../src/core/types';
import { conditionsMatch, resolvePolicy, ruleApplies } from '../src/core/policy';

function makeContext(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    action: {
      projectId: 'PAY',
      target: 'src/app.ts',
      environment: 'staging',
    },
    classification: {
      actionClass: 'A-02',
      reclassified: false,
      confidence: 'deterministic',
    },
    environment: 'staging',
    at: '2026-11-11T10:00:00Z', // Wednesday (day 3), 10:00 UTC
    ...overrides,
  };
}

function makeInput(overrides: Partial<PolicyResolutionInput> = {}): PolicyResolutionInput {
  return {
    context: makeContext(),
    rules: [],
    zones: [],
    killSwitchActive: false,
    trustEffectsEnabled: false,
    ...overrides,
  };
}

describe('policy resolution', () => {
  it('enforces kill switch at N0 for every class except A-01', () => {
    const res = resolvePolicy(
      makeInput({
        killSwitchActive: true,
        context: makeContext({
          classification: { actionClass: 'A-02', reclassified: false, confidence: 'deterministic' },
        }),
      }),
    );
    expect(res.level).toBe(0);
    expect(res.source).toBe('kill-switch');
    expect(res.observeOnly).toBe(false);
    expect(res.consideredRules).toEqual([]);

    const readRes = resolvePolicy(
      makeInput({
        killSwitchActive: true,
        context: makeContext({
          classification: { actionClass: 'A-01', reclassified: false, confidence: 'deterministic' },
        }),
      }),
    );
    expect(readRes.level).toBe(5);
    expect(readRes.source).toBe('class-default');
  });

  it('applies org floor when org rule is more restrictive than project rule', () => {
    const orgRule: PolicyRule = {
      id: 'org-a02-n2',
      scope: 'org',
      actionClass: 'A-02',
      level: 2,
      mode: 'enforce',
    };
    const projectRule: PolicyRule = {
      id: 'proj-a02-n4',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-02',
      level: 4,
      mode: 'enforce',
    };
    const res = resolvePolicy(makeInput({ rules: [projectRule, orgRule] }));
    expect(res.level).toBe(2);
    expect(res.source).toBe('org-floor');
    expect(res.rule?.id).toBe('org-a02-n2');
    expect(res.reason).toContain('org-a02-n2');
    expect(res.consideredRules).toEqual(['org-a02-n2', 'proj-a02-n4']);
  });

  it('cites the organisation rule even when it equals the class default', () => {
    const orgRule: PolicyRule = {
      id: 'org-default-A-10',
      scope: 'org',
      actionClass: 'A-10',
      level: 0,
      mode: 'enforce',
    };
    const res = resolvePolicy(
      makeInput({
        rules: [orgRule],
        context: makeContext({
          classification: { actionClass: 'A-10', reclassified: false, confidence: 'deterministic' },
        }),
      }),
    );

    expect(res.level).toBe(0);
    expect(res.source).toBe('org-floor');
    expect(res.rule?.id).toBe('org-default-A-10');
    expect(res.reason).toContain('org-default-A-10');
    expect(res.reason).not.toContain('No rule matched');
  });

  it('falls back to the class default when an org rule is more permissive', () => {
    const orgRule: PolicyRule = {
      id: 'org-loose',
      scope: 'org',
      actionClass: 'A-10',
      level: 4,
      mode: 'enforce',
    };
    const res = resolvePolicy(
      makeInput({
        rules: [orgRule],
        context: makeContext({
          classification: { actionClass: 'A-10', reclassified: false, confidence: 'deterministic' },
        }),
      }),
    );

    expect(res.level).toBe(0);
    expect(res.source).toBe('class-default');
  });

  it('picks the most restrictive project rule and breaks ties deterministically', () => {
    const zone: Zone = {
      id: 'z-core',
      projectId: 'PAY',
      name: 'Core',
      pathPatterns: ['src/**'],
    };
    const loose: PolicyRule = {
      id: 'r-loose',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-02',
      level: 4,
      mode: 'enforce',
    };
    const strictUnzoned: PolicyRule = {
      id: 'r-strict-a',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-02',
      level: 2,
      mode: 'enforce',
    };
    const strictZoned: PolicyRule = {
      id: 'r-strict-z',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-02',
      zoneId: 'z-core',
      level: 2,
      mode: 'enforce',
    };
    const res = resolvePolicy(
      makeInput({ rules: [loose, strictUnzoned, strictZoned], zones: [zone] }),
    );
    expect(res.level).toBe(2);
    expect(res.source).toBe('project-rule');
    expect(res.rule?.id).toBe('r-strict-z');
    expect(res.reason).toContain('r-strict-z');
  });

  it('sets observeOnly when the winning rule runs in observe mode', () => {
    const observeRule: PolicyRule = {
      id: 'r-obs',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-02',
      level: 1,
      mode: 'observe',
    };
    const res = resolvePolicy(makeInput({ rules: [observeRule] }));
    expect(res.level).toBe(1);
    expect(res.observeOnly).toBe(true);
    expect(res.reason).toContain('r-obs');
  });

  it('falls back to catalog default when no rule applies', () => {
    const res = resolvePolicy(
      makeInput({
        context: makeContext({
          classification: { actionClass: 'A-08', reclassified: false, confidence: 'deterministic' },
        }),
      }),
    );
    expect(res.level).toBe(2);
    expect(res.source).toBe('class-default');
    expect(res.observeOnly).toBe(false);
    expect(res.reason).toContain('A-08');
  });

  it('reports trust-adjusted when injected adjustLevel changes the resolved level', () => {
    const rule: PolicyRule = {
      id: 'r-n3',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-05',
      level: 3,
      mode: 'enforce',
    };
    const res = resolvePolicy(
      makeInput({
        rules: [rule],
        trustEffectsEnabled: true,
        context: makeContext({
          classification: { actionClass: 'A-05', reclassified: false, confidence: 'deterministic' },
          trustScore: 85,
        }),
        adjustLevel: (lvl, score) => (lvl === 3 && score >= 80 ? 4 : lvl),
      }),
    );
    expect(res.level).toBe(4);
    expect(res.source).toBe('trust-adjusted');
    expect(res.rule?.id).toBe('r-n3');
    expect(res.reason).toContain('r-n3');
  });

  it('evaluates environment, UTC timeWindow and trustBelow conditions', () => {
    const conditions = {
      environments: ['production' as const],
      timeWindows: [{ startHour: 9, endHour: 12, days: [3] }],
      trustBelow: 60,
    };
    expect(
      conditionsMatch(
        conditions,
        makeContext({
          environment: 'production',
          trustScore: 45,
          at: '2026-11-11T10:00:00Z',
        }),
      ),
    ).toBe(true);
    expect(
      conditionsMatch(
        conditions,
        makeContext({
          environment: 'staging',
          trustScore: 45,
          at: '2026-11-11T10:00:00Z',
        }),
      ),
    ).toBe(false);
    expect(
      conditionsMatch(
        conditions,
        makeContext({
          environment: 'production',
          trustScore: 45,
          at: '2026-11-11T15:00:00Z',
        }),
      ),
    ).toBe(false);
    expect(
      conditionsMatch(
        conditions,
        makeContext({
          environment: 'production',
          trustScore: 70,
          at: '2026-11-11T10:00:00Z',
        }),
      ),
    ).toBe(false);
    expect(
      conditionsMatch(
        conditions,
        makeContext({
          environment: 'production',
          trustScore: undefined,
          at: '2026-11-11T10:00:00Z',
        }),
      ),
    ).toBe(false);
  });

  it('filters project rules by projectId in ruleApplies', () => {
    const otherProjectRule: PolicyRule = {
      id: 'r-other',
      scope: 'project',
      projectId: 'BILL',
      actionClass: 'A-02',
      level: 1,
      mode: 'enforce',
    };
    expect(ruleApplies(otherProjectRule, makeInput())).toBe(false);
  });
});
