/**
 * Unit tests for policy suggestions from history (PA-21, spec §26 and §7.4).
 */
import { applySuggestion, suggestPolicyChanges } from '../src/services/policy-suggestions';
import { makeEntry } from '../src/core/ledger';
import { createMemoryRepositories } from '../src/storage/memory';
import { LedgerEntry, Repositories } from '../src/core/types';

const PROJECT = 'PAY';
const AT = '2026-11-11T12:00:00.000Z';

/** Build a day-stamped entry inside the analysis window. */
function entry(seq: number, kind: LedgerEntry['kind'], actionClass: string, detail?: Record<string, unknown>): LedgerEntry {
  return makeEntry(
    {
      kind,
      projectId: PROJECT,
      actionClass,
      decision: kind,
      detail,
      at: '2026-11-05T10:00:00.000Z',
    },
    { seq: seq - 1, hash: `hash-${seq - 1}` } as LedgerEntry,
  );
}

async function seedRequests(repos: Repositories, actionClass: string, granted: number, denied: number) {
  let seq = 1;
  const entries: LedgerEntry[] = [];
  for (let index = 0; index < granted; index++) entries.push(entry(seq++, 'approval', actionClass));
  for (let index = 0; index < denied; index++) entries.push(entry(seq++, 'denial', actionClass));
  for (const item of entries) await repos.ledger.append(item);
  return entries;
}

describe('suggestPolicyChanges', () => {
  it('proposes relaxing a class granted repeatedly without incident', async () => {
    const repos = createMemoryRepositories();
    await seedRequests(repos, 'A-05', 24, 1);

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    const relax = suggestions.find((s) => s.actionClass === 'A-05' && s.direction === 'relax');

    expect(relax).toBeDefined();
    expect(relax?.currentLevel).toBe(3);
    expect(relax?.proposedLevel).toBe(4);
    expect(relax?.status).toBe('proposal');
    expect(relax?.evidence.requests).toBe(25);
    expect(relax?.evidence.seqs.length).toBeGreaterThan(0);
  });

  it('never goes beyond N4 and never without enough history', async () => {
    const repos = createMemoryRepositories();
    await seedRequests(repos, 'A-01', 30, 0);

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    expect(suggestions.find((s) => s.actionClass === 'A-01')).toBeUndefined();

    const sparse = createMemoryRepositories();
    await seedRequests(sparse, 'A-05', 3, 0);
    const few = await suggestPolicyChanges(sparse, PROJECT, { at: AT });
    expect(few.find((s) => s.actionClass === 'A-05' && s.direction === 'relax')).toBeUndefined();
  });

  it('proposes hardening through observe mode after incidents', async () => {
    const repos = createMemoryRepositories();
    await seedRequests(repos, 'A-07', 5, 1);
    for (let index = 0; index < 3; index++) {
      await repos.ledger.append(entry(100 + index, 'trust-change', 'A-07', { trustKind: 'incident' }));
    }

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    const harden = suggestions.find((s) => s.actionClass === 'A-07');

    expect(harden?.direction).toBe('observe-first');
    expect(harden?.proposedMode).toBe('observe');
    expect(harden?.proposedLevel).toBe(1);
    expect(harden?.evidence.incidents).toBe(3);
  });

  it('never suggests anything for a locked class', async () => {
    const repos = createMemoryRepositories();
    await seedRequests(repos, 'A-15', 40, 0);
    for (let index = 0; index < 5; index++) {
      await repos.ledger.append(entry(200 + index, 'trust-change', 'A-15', { trustKind: 'incident' }));
    }

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    expect(suggestions.find((s) => s.actionClass === 'A-15')).toBeUndefined();
  });

  it('never relaxes data, secrets, destructive git or production classes', async () => {
    const repos = createMemoryRepositories();
    for (const actionClass of ['A-09', 'A-10', 'A-12', 'A-13']) {
      await seedRequests(repos, actionClass, 30, 0);
    }

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    const relaxed = suggestions.filter((s) => s.direction === 'relax').map((s) => s.actionClass);
    expect(relaxed).toEqual([]);
  });

  it('refuses a proposal more permissive than the organisation floor', async () => {
    const repos = createMemoryRepositories();
    await repos.policies.upsertRule({
      id: 'org-a05-floor',
      scope: 'org',
      actionClass: 'A-05',
      level: 3,
      mode: 'enforce',
    });
    await seedRequests(repos, 'A-05', 25, 0);

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    expect(suggestions.find((s) => s.actionClass === 'A-05' && s.direction === 'relax')).toBeUndefined();
  });

  it('proposes enforcing an observed rule that would have blocked actions', async () => {
    const repos = createMemoryRepositories();
    await repos.policies.upsertRule({
      id: 'pay-a06-observe',
      scope: 'project',
      projectId: PROJECT,
      actionClass: 'A-06',
      level: 3,
      mode: 'observe',
    });
    await repos.ledger.append(
      entry(1, 'decision', 'A-06', { level: 2, observeOnly: true }),
    );

    const suggestions = await suggestPolicyChanges(repos, PROJECT, { at: AT });
    const promote = suggestions.find((s) => s.direction === 'enforce-observed');

    expect(promote?.actionClass).toBe('A-06');
    expect(promote?.proposedMode).toBe('enforce');
  });
});

describe('applySuggestion', () => {
  const suggestion = {
    id: 'PAY-A-05-relax',
    projectId: PROJECT,
    actionClass: 'A-05',
    currentLevel: 3 as const,
    proposedLevel: 4 as const,
    proposedMode: 'enforce' as const,
    direction: 'relax' as const,
    evidence: {
      windowDays: 30, requests: 25, granted: 24, denied: 1, grantRate: 0.96,
      incidents: 0, deviations: 0, wouldHaveBlocked: 0, seqs: [1, 2, 3],
    },
    risk: 'Widens autonomy for A-05.',
    status: 'proposal' as const,
  };

  it('writes the rule and journals the change with its author', async () => {
    const repos = createMemoryRepositories();
    const outcome = await applySuggestion(repos, suggestion, 'tech-lead-1', { at: AT });

    expect(outcome.ok).toBe(true);
    expect(outcome.rule?.level).toBe(4);
    expect((await repos.policies.listRules(PROJECT))).toHaveLength(1);

    const entries = await repos.ledger.list({ projectId: PROJECT });
    expect(entries[0].kind).toBe('policy-changed');
    expect(entries[0].detail?.actor).toBe('tech-lead-1');
    expect(entries[0].detail?.to).toBe(4);
  });

  it('refuses a locked class even when asked explicitly', async () => {
    const repos = createMemoryRepositories();
    const outcome = await applySuggestion(repos, { ...suggestion, actionClass: 'A-15' }, 'tech-lead-1', { at: AT });

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('CLASS_LOCKED');
    expect(await repos.policies.listRules(PROJECT)).toHaveLength(0);
  });

  it('refuses an anonymous application', async () => {
    const repos = createMemoryRepositories();
    const outcome = await applySuggestion(repos, suggestion, '', { at: AT });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe('MISSING_ACTOR');
  });
});
