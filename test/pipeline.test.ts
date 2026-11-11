/**
 * Unit tests for src/core/pipeline.ts — the complete decision flow (spec §16).
 */
import { classifyAction } from '../src/core/classify';
import { makeEntry } from '../src/core/ledger';
import { maskSecrets } from '../src/core/mask';
import { consumePermitUse, isPermitActive, issuePermit, newPermitId, permitCovers } from '../src/core/permits';
import { createDecisionEngine } from '../src/core/pipeline';
import { resolvePolicy } from '../src/core/policy';
import { trustAdjustLevel } from '../src/core/trust';
import { createMemoryRepositories } from '../src/storage/memory';
import { AgentCallContext, Repositories } from '../src/core/types';

const SECRET = 'pipeline-test-secret';
const NOW = '2026-11-11T10:00:00.000Z';

function caller(overrides: Partial<AgentCallContext> = {}): AgentCallContext {
  return {
    projectId: 'PAY',
    issueKey: 'PAY-42',
    profileId: 'claude-payments',
    pilot: { accountId: 'pilot-1', roles: ['developer'] },
    via: 'mcp',
    ...overrides,
  };
}

function buildEngine(repos: Repositories) {
  return createDecisionEngine({
    repos,
    secret: SECRET,
    classify: classifyAction,
    resolve: resolvePolicy,
    isPermitActive,
    permitCovers,
    consumePermitUse,
    maskSecrets,
    makeEntry,
    adjustLevel: trustAdjustLevel,
    now: () => NOW,
  });
}

describe('pipeline', () => {
  let repos: Repositories;

  beforeEach(() => {
    repos = createMemoryRepositories();
  });

  it('allows reading without a permit and does not journal it', async () => {
    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction({ target: 'src/index.ts', declaredClass: 'A-01' }, caller());

    expect(decision.decision).toBe('allow');
    expect(decision.level).toBe(5);
    expect(decision.permitConsumed).toBeUndefined();
    expect(decision.requestId).toBeUndefined();
    const ledger = await repos.ledger.list({ projectId: 'PAY' });
    expect(ledger).toHaveLength(0);
  });

  it('reclassifies migrations and asks for approval when no permit exists', async () => {
    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction(
      { target: 'db/migrations/001_init.sql', declaredClass: 'A-02', issueKey: 'PAY-42' },
      caller(),
    );

    expect(decision.classification.actionClass).toBe('A-08');
    expect(decision.classification.reclassified).toBe(true);
    expect(decision.level).toBe(2);
    expect(decision.decision).toBe('deny');
    expect(decision.requestId).toMatch(/^RQ-2026-\d{6}$/);

    const request = await repos.requests.get(decision.requestId!);
    expect(request?.status).toBe('pending');
    expect(request?.actionClass).toBe('A-08');

    const ledger = await repos.ledger.list({ projectId: 'PAY' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].decision).toBe('deny');
  });

  it('consumes a covering permit and allows the action', async () => {
    const permit = issuePermit(
      {
        id: newPermitId(1, 2026),
        scope: { actionClass: 'A-08', target: 'db/migrations/001_init.sql', issueKey: 'PAY-42', projectId: 'PAY' },
        holderProfileId: 'claude-payments',
        pilotAccountId: 'pilot-1',
        issuedAt: '2026-11-11T09:00:00.000Z',
        ttlMinutes: 120,
        uses: 1,
      },
      SECRET,
    );
    await repos.permits.savePermit(permit);

    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction(
      { target: 'db/migrations/001_init.sql', issueKey: 'PAY-42' },
      caller(),
    );

    expect(decision.decision).toBe('allow');
    expect(decision.permitConsumed).toBe(permit.id);

    const stored = (await repos.permits.listPermits({ projectId: 'PAY' }))[0];
    expect(stored.usesLeft).toBe(0);

    const second = await engine.evaluateAction(
      { target: 'db/migrations/001_init.sql', issueKey: 'PAY-42' },
      caller(),
    );
    expect(second.decision).toBe('deny');
  });

  it('strictly forbids A-10 secrets regardless of caller', async () => {
    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction({ target: '.env.production', issueKey: 'PAY-42' }, caller());

    expect(decision.classification.actionClass).toBe('A-10');
    expect(decision.level).toBe(0);
    expect(decision.decision).toBe('deny');
    expect(decision.requestId).toBeUndefined();
  });

  it('refuses actions beyond N4 when the ticket is missing (spec §20)', async () => {
    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction({ target: 'db/migrations/001_init.sql' }, caller({ issueKey: undefined }));

    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('Ticket reference required');
  });

  it('forbids every write when the kill switch is active (spec §12)', async () => {
    await repos.killSwitches.save({ scope: 'project', projectId: 'PAY', active: true, by: 'admin', at: NOW });
    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction(
      { target: 'src/app.ts', declaredClass: 'A-02', issueKey: 'PAY-42' },
      caller(),
    );

    expect(decision.decision).toBe('deny');
    expect(decision.level).toBe(0);
    expect(decision.resolution.source).toBe('kill-switch');

    const read = await engine.evaluateAction({ target: 'src/app.ts', declaredClass: 'A-01' }, caller());
    expect(read.decision).toBe('allow');
  });

  it('allows everything in observe mode and journals what would have blocked', async () => {
    await repos.policies.upsertRule({
      id: 'observe-migrations',
      scope: 'project',
      projectId: 'PAY',
      actionClass: 'A-08',
      level: 2,
      mode: 'observe',
    });

    const engine = buildEngine(repos);
    const decision = await engine.evaluateAction(
      { target: 'db/migrations/001_init.sql', issueKey: 'PAY-42' },
      caller(),
    );

    expect(decision.decision).toBe('allow');
    expect(decision.resolution.observeOnly).toBe(true);
    expect(decision.reason).toContain('OBSERVE MODE: would have been deny');

    const ledger = await repos.ledger.list({ projectId: 'PAY' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].detail?.observeOnly).toBe(true);
  });

  it('masks sensitive parameters in the journal (spec §19)', async () => {
    const engine = buildEngine(repos);
    await engine.evaluateAction(
      {
        target: 'curl -H "Authorization: Bearer secret-token" https://api.internal',
        declaredClass: 'A-14',
        issueKey: 'PAY-42',
      },
      caller(),
    );

    const ledger = await repos.ledger.list({ projectId: 'PAY' });
    expect(ledger[0].target).toContain('[REDACTED:');
    expect(ledger[0].target).not.toContain('secret-token');
  });
});
