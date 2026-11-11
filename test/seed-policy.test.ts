/**
 * Unit tests for policy seeding (operator bootstrap of a fresh installation).
 *
 * The point of these tests is the guard rails: an operator secret must not be a
 * way to widen anyone's rights, so org scope, locked classes and anything
 * softer than the organisation floor are refused — and every applied rule is
 * journaled with its author.
 */
import { applySeed, planSeed, SeedDocument } from '../src/services/seed-policy';
import { createMemoryRepositories } from '../src/storage/memory';
import { AutonomyLevel, Repositories } from '../src/core/types';

const PROJECT = 'PAY';
const ACTOR = 'operator-1';
const AT = '2026-11-11T12:00:00.000Z';

async function withOrgFloor(): Promise<Repositories> {
  const repos = createMemoryRepositories();
  await repos.policies.upsertRule({
    id: 'org-A-08',
    scope: 'org',
    actionClass: 'A-08',
    level: 2,
    mode: 'enforce',
  });
  await repos.policies.upsertRule({
    id: 'org-A-05',
    scope: 'org',
    actionClass: 'A-05',
    level: 3,
    mode: 'enforce',
  });
  return repos;
}

describe('planSeed', () => {
  it('accepts zones and project rules that respect the floor', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      zones: [{ id: 'zone-migrations', name: 'Migrations', pathPatterns: ['**/migrations/**'] }],
      rules: [
        { id: 'pay-mig', actionClass: 'A-08', zoneId: 'zone-migrations', level: 2, mode: 'enforce', approverRole: 'data-owner' },
        { id: 'pay-dep', actionClass: 'A-05', level: 3, mode: 'observe' },
      ],
    });

    expect(plan.zones).toHaveLength(1);
    expect(plan.zones[0].projectId).toBe(PROJECT);
    expect(plan.rules).toHaveLength(2);
    expect(plan.refusals).toEqual([]);
  });

  it('refuses a rule softer than the organisation floor', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      rules: [{ id: 'pay-mig-loose', actionClass: 'A-08', level: 4, mode: 'enforce' }],
    });

    expect(plan.rules).toHaveLength(0);
    expect(plan.refusals[0].reason).toBe('SOFTER_THAN_ORG_FLOOR');
    expect(plan.refusals[0].detail).toContain('N4');
  });

  it('accepts a rule stricter than the floor', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      rules: [{ id: 'pay-mig-strict', actionClass: 'A-08', level: 1, mode: 'enforce' }],
    });

    expect(plan.rules).toHaveLength(1);
    expect(plan.rules[0].level).toBe(1);
  });

  it('refuses a locked class outright', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      rules: [{ id: 'pay-policy', actionClass: 'A-15', level: 0, mode: 'enforce' }],
    });

    expect(plan.rules).toHaveLength(0);
    expect(plan.refusals[0].reason).toBe('LOCKED_CLASS');
  });

  it('refuses to write the organisation floor through this route', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      orgFloor: [],
      rules: [{ id: 'org-override', scope: 'org', actionClass: 'A-10', level: 5, mode: 'enforce' }],
    });

    expect(plan.rules).toHaveLength(0);
    expect(plan.refusals[0].reason).toBe('ORG_SCOPE_REFUSED');
  });

  it('refuses an invalid level and an unnamed zone', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      zones: [{ pathPatterns: ['x'] } as never],
      rules: [{ id: 'bad-level', actionClass: 'A-03', level: 9 as never, mode: 'enforce' }],
    });

    expect(plan.refusals.map((refusal) => refusal.reason).sort()).toEqual(['INVALID', 'INVALID_LEVEL']);
  });

  it('forces scope to project and derives a missing rule id', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      rules: [{ actionClass: 'A-03', zoneId: 'zone-tests', level: 2, mode: 'enforce' }],
    });

    expect(plan.rules[0].scope).toBe('project');
    expect(plan.rules[0].projectId).toBe(PROJECT);
    expect(plan.rules[0].id).toBe('PAY-A-03-zone-tests');
  });
});

describe('applySeed', () => {
  it('writes zones and rules, and journals every rule with its author', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      zones: [
        { id: 'zone-migrations', name: 'Migrations', pathPatterns: ['**/migrations/**'] },
        { id: 'zone-ci', name: 'CI', pathPatterns: ['**/.github/workflows/**'] },
      ],
      rules: [
        { id: 'pay-mig', actionClass: 'A-08', zoneId: 'zone-migrations', level: 2, mode: 'enforce' },
        { id: 'pay-ci', actionClass: 'A-07', zoneId: 'zone-ci', level: 2, mode: 'enforce' },
      ],
    });

    const result = await applySeed(repos, plan, ACTOR, AT);

    expect(result).toMatchObject({ ok: true, zonesWritten: 2, rulesWritten: 2, entries: 2 });
    expect(await repos.zones.listZones(PROJECT)).toHaveLength(2);

    const entries = await repos.ledger.list({ projectId: PROJECT, kind: 'policy-changed' });
    expect(entries).toHaveLength(2);
    expect(entries[0].detail?.actor).toBe(ACTOR);
    expect(entries[0].at).toBe(AT);
    // The chain stays intact.
    expect(entries[1].seq).toBe(entries[0].seq + 1);
  });

  it('is idempotent: reseeding updates instead of duplicating', async () => {
    const repos = await withOrgFloor();
    const seed: SeedDocument = {
      rules: [{ id: 'pay-mig', actionClass: 'A-08', level: 2 as AutonomyLevel, mode: 'enforce' }],
    };

    await applySeed(repos, await planSeed(repos, PROJECT, seed), ACTOR, AT);
    await applySeed(repos, await planSeed(repos, PROJECT, seed), ACTOR, AT);

    const rules = (await repos.policies.listRules(PROJECT)).filter((rule) => rule.id === 'pay-mig');
    expect(rules).toHaveLength(1);
  });

  it('reports ok=false when nothing could be applied', async () => {
    const repos = await withOrgFloor();
    const plan = await planSeed(repos, PROJECT, {
      rules: [{ id: 'locked', actionClass: 'A-15', level: 0, mode: 'enforce' }],
    });

    const result = await applySeed(repos, plan, ACTOR, AT);
    expect(result.ok).toBe(false);
    expect(result.rulesWritten).toBe(0);
    expect(result.refusals).toHaveLength(1);
  });
});
