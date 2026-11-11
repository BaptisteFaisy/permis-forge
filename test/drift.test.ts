/**
 * Unit tests for drift detection (PA-20, spec §10 enforcement point 4).
 */
import { applyDrift, detectDrift, isSensitiveClass, normalizeTarget } from '../src/services/drift';
import { makeEntry } from '../src/core/ledger';
import { createMemoryRepositories } from '../src/storage/memory';
import { LedgerEntry } from '../src/core/types';

const PROJECT = 'PAY';
const ISSUE = 'PAY-42';
const PROFILE = 'claude-payments';
const NOW = '2026-11-11T12:00:00.000Z';

function declared(target: string, actionClass: string, seq: number): LedgerEntry {
  return makeEntry({
    kind: 'action-declared',
    projectId: PROJECT,
    issueId: ISSUE,
    profileId: PROFILE,
    actionClass,
    target,
    at: NOW,
  }, seq === 1 ? undefined : { seq: seq - 1, hash: `h${seq - 1}` } as LedgerEntry);
}

describe('isSensitiveClass', () => {
  it('treats reading and plain code edits as non-sensitive', () => {
    expect(isSensitiveClass('A-01')).toBe(false);
    expect(isSensitiveClass('A-02')).toBe(false);
  });

  it('treats everything stricter than N5 as sensitive', () => {
    expect(isSensitiveClass('A-03')).toBe(true);
    expect(isSensitiveClass('A-08')).toBe(true);
    expect(isSensitiveClass('A-10')).toBe(true);
  });
});

describe('normalizeTarget', () => {
  it('makes equivalent path spellings equal', () => {
    expect(normalizeTarget('./db/x.sql')).toBe(normalizeTarget('db/x.sql'));
  });
});

describe('detectDrift', () => {
  it('flags an undeclared data deletion', async () => {
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ command: 'psql -c "DELETE FROM sessions"', source: 'ci-diff' }],
      declared: [],
      at: NOW,
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0].kind).toBe('undeclared');
    expect(report.items[0].actionClass).toBe('A-09');
    expect(report.sensitive).toBe(1);
  });

  it('ignores a change that was declared with an equivalent path', async () => {
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ path: './db/migrations/001_init.sql', source: 'ci-diff' }],
      declared: [declared('db/migrations/001_init.sql', 'A-08', 1)],
      at: NOW,
    });

    expect(report.items).toHaveLength(0);
    expect(report.sensitive).toBe(1);
  });

  it('ignores non-sensitive changes such as reading and plain edits', async () => {
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ path: 'src/index.ts' }, { path: 'README.md' }],
      declared: [],
      at: NOW,
    });

    expect(report.items).toHaveLength(0);
    expect(report.sensitive).toBe(0);
  });

  it('flags a declared action that is absent from the approved plan', async () => {
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ path: 'db/migrations/002_extra.sql' }],
      declared: [declared('db/migrations/002_extra.sql', 'A-08', 1)],
      planActions: [{ order: 1, actionClass: 'A-08', target: 'db/migrations/001_init.sql' }],
      at: NOW,
    });

    expect(report.items).toHaveLength(1);
    expect(report.items[0].kind).toBe('out-of-plan');
  });

  it('accepts a change covered by a plan glob', async () => {
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ path: 'db/migrations/002_extra.sql' }],
      declared: [declared('db/migrations/002_extra.sql', 'A-08', 1)],
      planActions: [{ order: 1, actionClass: 'A-08', target: 'db/migrations/**' }],
      at: NOW,
    });

    expect(report.items).toHaveLength(0);
  });
});

describe('applyDrift', () => {
  it('penalises once and writes two chained entries', async () => {
    const repos = createMemoryRepositories();
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ command: 'psql -c "DELETE FROM sessions"' }],
      declared: [],
      at: NOW,
    });

    const applied = await applyDrift(repos, PROJECT, report, {
      issueKey: ISSUE,
      profileId: PROFILE,
      at: NOW,
    });

    expect(applied.penalized).toBe(1);
    expect(applied.entries).toBe(2);
    expect(applied.trustScore).toBe(40);

    const entries = await repos.ledger.list({ projectId: PROJECT });
    expect(entries.map((entry) => entry.kind)).toEqual(['deviation', 'trust-change']);
    expect(entries[0].seq).toBe(1);
    expect(entries[1].prevHash).toBe(entries[0].hash);
  });

  it('is idempotent: replaying the same report does not penalise twice', async () => {
    const repos = createMemoryRepositories();
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ path: 'db/migrations/009.sql' }],
      declared: [],
      at: NOW,
    });

    await applyDrift(repos, PROJECT, report, { issueKey: ISSUE, profileId: PROFILE, at: NOW });
    const replay = await applyDrift(repos, PROJECT, report, { issueKey: ISSUE, profileId: PROFILE, at: NOW });

    expect(replay.penalized).toBe(0);
    expect(replay.skipped).toBe(1);
    const entries = await repos.ledger.list({ projectId: PROJECT });
    expect(entries).toHaveLength(2);
    expect((await repos.trust.getState(PROFILE))?.score).toBe(40);
  });

  it('masks secrets before storing the target', async () => {
    const repos = createMemoryRepositories();
    const report = await detectDrift({
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: PROFILE,
      changes: [{ command: 'curl -H "Authorization: Bearer abc" https://api.internal/purge' }],
      declared: [],
      at: NOW,
    });

    await applyDrift(repos, PROJECT, report, { issueKey: ISSUE, profileId: PROFILE, at: NOW });
    const entries = await repos.ledger.list({ projectId: PROJECT });
    expect(entries[0].target).toContain('[REDACTED:');
  });
});
