import {
  evaluatePlan,
  findPlanMatch,
  isOutOfPlan,
  parsePlan,
} from '../src/core/plan';
import { Classification, Decision, PlanAction } from '../src/core/types';

function classification(actionClass: string): Classification {
  return {
    actionClass,
    reclassified: false,
    confidence: 'deterministic',
  };
}

function decision(overrides: Partial<Decision>): Decision {
  return {
    level: 5,
    decision: 'allow',
    log: false,
    classification: classification('A-01'),
    resolution: {
      level: 5,
      source: 'class-default',
      reason: 'test',
      observeOnly: false,
      consideredRules: [],
    },
    reason: 'test',
    guidance: 'go ahead',
    at: '2026-11-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('plan — parsing', () => {
  it('parses a JSON array of actions', () => {
    const actions = parsePlan(
      JSON.stringify([
        { actionClass: 'A-08', target: 'migrations/001.sql', description: 'init' },
        { target: 'src/index.ts' },
      ]),
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]).toEqual({
      order: 1,
      actionClass: 'A-08',
      target: 'migrations/001.sql',
      description: 'init',
    });
    expect(actions[1].order).toBe(2);
    expect(actions[1].actionClass).toBeUndefined();
  });

  it('ignores JSON entries without a valid target', () => {
    const actions = parsePlan(
      JSON.stringify([{ target: 'ok.ts' }, { target: '' }, { nope: 1 }]),
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].target).toBe('ok.ts');
    expect(actions[0].order).toBe(1);
  });

  it('falls back to markdown bullets when JSON is invalid', () => {
    const actions = parsePlan('not json at all');
    expect(actions).toEqual([]);
    const bullets = parsePlan('- src/index.ts\n- src/other.ts');
    expect(bullets.map((a) => a.target)).toEqual([
      'src/index.ts',
      'src/other.ts',
    ]);
    expect(bullets[0].order).toBe(1);
    expect(bullets[1].order).toBe(2);
  });

  it('parses a bullet with a bracketed action class', () => {
    const actions = parsePlan('- [A-08] migrations/x.sql : create the table');
    expect(actions).toHaveLength(1);
    expect(actions[0].actionClass).toBe('A-08');
    expect(actions[0].target).toBe('migrations/x.sql');
    expect(actions[0].description).toBe('create the table');
    expect(actions[0].order).toBe(1);
  });

  it('parses a bullet without a class', () => {
    const actions = parsePlan('* src/index.ts');
    expect(actions[0].actionClass).toBeUndefined();
    expect(actions[0].target).toBe('src/index.ts');
  });

  it('returns an empty plan for blank text', () => {
    expect(parsePlan('')).toEqual([]);
    expect(parsePlan('   \n  ')).toEqual([]);
  });
});

describe('plan — sequential evaluation', () => {
  const actions: PlanAction[] = [
    { order: 1, target: 'a.ts' },
    { order: 2, target: 'b.ts' },
    { order: 3, target: 'c.ts' },
  ];

  it('evaluates actions sequentially and collects approvals and denials', async () => {
    const calls: string[] = [];
    const evaluation = await evaluatePlan(actions, async (action) => {
      calls.push(action.target);
      if (action.target === 'b.ts') {
        return decision({
          level: 3,
          decision: 'ask',
          log: true,
          requestId: 'RQ-2026-0002',
        });
      }
      if (action.target === 'c.ts') {
        return decision({ level: 0, decision: 'deny', log: true });
      }
      return decision({ level: 5, decision: 'allow' });
    });

    expect(calls).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(evaluation.decisions).toHaveLength(3);
    expect(evaluation.approvalsNeeded.map((a) => a.target)).toEqual(['b.ts']);
    expect(evaluation.denied.map((a) => a.target)).toEqual(['c.ts']);
  });

  it('does not treat an approval request as a denial', async () => {
    const evaluation = await evaluatePlan([{ order: 1, target: 'x.ts' }], async () =>
      decision({ level: 3, decision: 'ask', log: true, requestId: 'RQ-1' }),
    );
    expect(evaluation.approvalsNeeded).toHaveLength(1);
    expect(evaluation.denied).toHaveLength(0);
  });

  it('treats a deny without request id as a denial', async () => {
    const evaluation = await evaluatePlan([{ order: 1, target: 'x.ts' }], async () =>
      decision({ level: 2, decision: 'deny', log: true }),
    );
    expect(evaluation.denied).toHaveLength(1);
    expect(evaluation.approvalsNeeded).toHaveLength(0);
  });
});

describe('plan — matching and deviation', () => {
  const plan: PlanAction[] = [
    { order: 1, actionClass: 'A-08', target: 'migrations/*.sql' },
    { order: 2, target: 'src/**/*.ts' },
  ];

  it('matches an exact target', () => {
    const match = findPlanMatch(
      [{ order: 1, target: 'src/index.ts' }],
      classification('A-02'),
      'src/index.ts',
    );
    expect(match).toBeDefined();
    expect(match?.target).toBe('src/index.ts');
  });

  it('matches through a glob pattern', () => {
    const match = findPlanMatch(plan, classification('A-08'), 'migrations/001.sql');
    expect(match).toBeDefined();
    expect(match?.order).toBe(1);
  });

  it('treats a step without a class as a wildcard', () => {
    const match = findPlanMatch(plan, classification('A-09'), 'src/core/index.ts');
    expect(match).toBeDefined();
    expect(match?.order).toBe(2);
  });

  it('does not match when the class differs', () => {
    expect(
      findPlanMatch(
        [{ order: 1, actionClass: 'A-08', target: 'migrations/001.sql' }],
        classification('A-09'),
        'migrations/001.sql',
      ),
    ).toBeUndefined();
  });

  it('detects out-of-plan actions', () => {
    expect(isOutOfPlan(plan, classification('A-08'), 'migrations/001.sql')).toBe(
      false,
    );
    expect(isOutOfPlan(plan, classification('A-02'), 'config/secrets.yml')).toBe(
      true,
    );
    expect(isOutOfPlan([], classification('A-01'), 'src/index.ts')).toBe(true);
  });
});
