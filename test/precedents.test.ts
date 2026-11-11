/**
 * Unit tests for src/services/precedents.ts — the "precedents" block of the
 * approval request card (spec §8.1, PA-17).
 *
 * Everything runs offline on the in-memory repositories: a past request is
 * seeded together with the journal entries that reference it, exactly as the
 * pipeline and the approval service write them.
 */
import { makeEntry } from '../src/core/ledger';
import { findPrecedents } from '../src/services/precedents';
import { createMemoryRepositories } from '../src/storage/memory';
import { callResolver, createResolvers } from '../src/ui/resolvers';
import {
  Approval,
  ApprovalRequest,
  LedgerEntry,
  LedgerEntryInput,
  Permit,
  Repositories,
  RequestStatus,
} from '../src/core/types';

const PROJECT = 'PAY';
const ISSUE = 'PAY-42';
const NOW = '2026-11-11T12:00:00.000Z';

const GRANT: Approval = {
  approverAccountId: 'acc-lead',
  role: 'tech-lead',
  decision: 'grant',
  at: '2026-11-01T11:00:00.000Z',
};

/** Append one entry to the chained journal of the project. */
async function append(repos: Repositories, input: LedgerEntryInput): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(PROJECT);
  const entry = makeEntry(input, prev);
  await repos.ledger.append(entry);
  return entry;
}

interface SeedOptions {
  id?: string;
  actionClass?: string;
  target?: string;
  status?: RequestStatus;
  createdAt?: string;
  approvals?: Approval[];
}

/** Seed a past request and the journal entry that references it. */
async function seedRequest(
  repos: Repositories,
  options: SeedOptions = {},
): Promise<ApprovalRequest> {
  const request: ApprovalRequest = {
    id: options.id ?? 'RQ-2026-0001',
    issueId: ISSUE,
    projectId: PROJECT,
    profileId: 'claude-pay',
    pilotAccountId: 'acc-pilot',
    actionClass: options.actionClass ?? 'A-02',
    target: options.target ?? 'db/migrations/001_init.sql',
    level: 2,
    status: options.status ?? 'granted',
    createdAt: options.createdAt ?? '2026-11-01T10:00:00.000Z',
    approvals: options.approvals ?? [],
  };
  await repos.requests.create(request);
  await append(repos, {
    kind: 'decision',
    projectId: PROJECT,
    issueId: ISSUE,
    actionClass: request.actionClass,
    target: request.target,
    decision: 'ask',
    detail: { requestId: request.id },
    at: request.createdAt,
  });
  return request;
}

/** Seed the permit a granted request produced. */
async function seedPermit(
  repos: Repositories,
  request: ApprovalRequest,
  id = 'PA-2026-000001',
): Promise<Permit> {
  const permit: Permit = {
    id,
    requestId: request.id,
    scope: {
      actionClass: request.actionClass,
      target: request.target,
      issueKey: ISSUE,
      projectId: PROJECT,
    },
    holderProfileId: request.profileId,
    pilotAccountId: request.pilotAccountId,
    issuedAt: '2026-11-01T11:00:00.000Z',
    expiresAt: '2026-11-01T13:00:00.000Z',
    usesLeft: 1,
    signature: 'signature',
  };
  await repos.permits.savePermit(permit);
  await append(repos, {
    kind: 'permit-issued',
    projectId: PROJECT,
    issueId: ISSUE,
    actionClass: request.actionClass,
    target: request.target,
    permitId: permit.id,
    decision: 'issued',
    detail: { requestId: request.id },
    at: permit.issuedAt,
  });
  return permit;
}

describe('findPrecedents', () => {
  it('returns a granted precedent with its permit and the later declared action', async () => {
    const repos = createMemoryRepositories();
    const request = await seedRequest(repos, {
      id: 'RQ-2026-0001',
      status: 'granted',
      target: 'db/migrations/001_init.sql',
      approvals: [GRANT],
    });
    const permit = await seedPermit(repos, request);
    await append(repos, {
      kind: 'action-declared',
      projectId: PROJECT,
      issueId: ISSUE,
      actionClass: 'A-02',
      target: 'db/migrations/001_init.sql',
      permitId: permit.id,
      at: '2026-11-02T09:00:00.000Z',
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002_add_users.sql' },
      { now: NOW },
    );

    expect(result.precedents).toHaveLength(1);
    const precedent = result.precedents[0];
    expect(precedent.requestId).toBe('RQ-2026-0001');
    expect(precedent.issue).toBe('granted');
    expect(precedent.similarity).toBe('same-folder');
    expect(precedent.approvers[0]).toMatchObject({
      accountId: 'acc-lead', role: 'tech-lead', decision: 'grant',
    });
    expect(precedent.permit?.id).toBe('PA-2026-000001');
    expect(precedent.permit?.ttlMinutes).toBe(120);
    expect(precedent.permit?.usesLeft).toBe(1);
    expect(precedent.decisionDelayMinutes).toBe(60);
    expect(precedent.followUps.map((followUp) => followUp.kind)).toEqual(['action-declared']);
    expect(precedent.followUps[0].summary).toContain('db/migrations/001_init.sql');
  });

  it('keeps only the requests of the same class on a close target', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, { id: 'RQ-2026-0001', target: 'db/migrations/001_init.sql' });
    await seedRequest(repos, { id: 'RQ-2026-0002', target: 'frontend/src/app.tsx' });
    await seedRequest(repos, { id: 'RQ-2026-0003', target: 'db/migrations/003.sql', actionClass: 'A-09' });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
    );

    expect(result.precedents.map((precedent) => precedent.requestId)).toEqual(['RQ-2026-0001']);
  });

  it('ranks the exact target first and the glob coverage last', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, { id: 'RQ-2026-0001', target: 'db/migrations/002.sql' });
    await seedRequest(repos, { id: 'RQ-2026-0002', target: 'db/**' });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
    );

    expect(result.precedents.map((precedent) => precedent.similarity)).toEqual(['exact', 'glob-covered']);
  });

  it('sorts by proximity then recency and honours the limit', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, {
      id: 'RQ-2026-0001', target: 'db/migrations/001.sql', createdAt: '2026-10-01T10:00:00.000Z',
    });
    await seedRequest(repos, {
      id: 'RQ-2026-0002', target: 'db/migrations/009.sql', createdAt: '2026-11-05T10:00:00.000Z',
    });
    await seedRequest(repos, {
      id: 'RQ-2026-0003', target: 'db/migrations/003.sql', createdAt: '2026-11-06T10:00:00.000Z',
    });
    await seedRequest(repos, {
      id: 'RQ-2026-0004', target: 'db/migrations/002.sql', createdAt: '2026-09-01T10:00:00.000Z',
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
      { limit: 2 },
    );

    expect(result.precedents.map((precedent) => precedent.requestId)).toEqual(['RQ-2026-0004', 'RQ-2026-0003']);
    expect(result.summary.similarRequests).toBe(4);
  });

  it('excludes the request being decided', async () => {
    const repos = createMemoryRepositories();
    const current = await seedRequest(repos, {
      id: 'RQ-2026-0009', status: 'pending', target: 'db/migrations/002.sql',
    });
    await seedRequest(repos, { id: 'RQ-2026-0001', target: 'db/migrations/001.sql' });

    const listed = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
    );
    const excluded = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
      { excludeRequestId: current.id },
    );

    expect(listed.precedents.map((precedent) => precedent.requestId)).toEqual(['RQ-2026-0001']);
    expect(excluded.precedents.map((precedent) => precedent.requestId)).toEqual(['RQ-2026-0001']);
  });

  it('shows the denial reason and the role of the approver', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, {
      id: 'RQ-2026-0002',
      status: 'denied',
      target: 'db/migrations/002.sql',
      approvals: [{
        approverAccountId: 'acc-lead',
        role: 'tech-lead',
        decision: 'deny',
        reason: 'No rollback plan',
        at: '2026-11-02T09:00:00.000Z',
      }],
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
    );

    const precedent = result.precedents[0];
    expect(precedent.issue).toBe('denied');
    expect(precedent.denialReason).toBe('No rollback plan');
    expect(precedent.approvers[0].decision).toBe('deny');
    expect(precedent.approvers[0].role).toBe('tech-lead');
    expect(result.summary.grantRate).toBe(0);
  });

  it('reports the incidents that followed a similar request', async () => {
    const repos = createMemoryRepositories();
    const request = await seedRequest(repos, {
      id: 'RQ-2026-0001', status: 'granted', target: 'db/migrations/001.sql', approvals: [GRANT],
    });
    const permit = await seedPermit(repos, request);
    await append(repos, {
      kind: 'deviation',
      projectId: PROJECT,
      issueId: ISSUE,
      actionClass: 'A-02',
      target: 'db/migrations/001.sql',
      permitId: permit.id,
      decision: 'deviation',
      at: '2026-11-03T10:00:00.000Z',
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql' },
      { now: NOW },
    );

    expect(result.precedents[0].followUps.map((followUp) => followUp.kind)).toContain('deviation');
    expect(result.summary.laterIncidents).toBe(1);
    expect(result.summary.headline).toBe('1 incident followed similar requests');
  });

  it('summarises similar granted requests with no incident', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, {
      id: 'RQ-2026-0001',
      status: 'granted',
      target: 'db/migrations/001.sql',
      createdAt: '2026-11-01T10:00:00.000Z',
      approvals: [GRANT],
    });
    await seedRequest(repos, {
      id: 'RQ-2026-0002',
      status: 'granted',
      target: 'db/migrations/002.sql',
      createdAt: '2026-11-02T10:00:00.000Z',
      approvals: [{ ...GRANT, at: '2026-11-02T12:00:00.000Z' }],
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/003.sql' },
      { now: NOW },
    );

    expect(result.summary.similarRequests).toBe(2);
    expect(result.summary.granted).toBe(2);
    expect(result.summary.grantRate).toBe(1);
    expect(result.summary.medianDecisionMinutes).toBe(90);
    expect(result.summary.laterIncidents).toBe(0);
    expect(result.summary.headline).toBe('resembles 2 previously granted requests with no incident');
  });

  it('ignores the requests older than the given window', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, {
      id: 'RQ-2026-0001', target: 'db/migrations/001.sql', createdAt: '2026-01-01T10:00:00.000Z',
    });
    await seedRequest(repos, {
      id: 'RQ-2026-0002', target: 'db/migrations/002.sql', createdAt: '2026-11-09T10:00:00.000Z',
    });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/003.sql' },
      { sinceDays: 7, now: NOW },
    );

    expect(result.precedents.map((precedent) => precedent.requestId)).toEqual(['RQ-2026-0002']);
  });

  it('masks the targets and never writes to the journal', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, { id: 'RQ-2026-0001', target: 'ci/deploy.sh --password=hunter2' });
    const before = await repos.ledger.list({ projectId: PROJECT });

    const result = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'ci/deploy.sh --password=hunter2' },
    );

    const after = await repos.ledger.list({ projectId: PROJECT });
    expect(after).toHaveLength(before.length);
    expect(result.precedents[0].target).toContain('[REDACTED:password-flag]');
    expect(result.precedents[0].target).not.toContain('hunter2');
    expect(result.query.target).not.toContain('hunter2');
  });
});

describe('getPrecedents resolver', () => {
  it('answers with the same shape as the service', async () => {
    const repos = createMemoryRepositories();
    await seedRequest(repos, {
      id: 'RQ-2026-0001', status: 'granted', target: 'db/migrations/001.sql', approvals: [GRANT],
    });
    const resolver = createResolvers({
      repos,
      engine: {},
      verifyChain: () => ({ valid: true, checked: 0 }),
    });
    const payload = {
      projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql', issueKey: ISSUE, limit: 3,
    };

    const out = await callResolver(resolver, 'getPrecedents', {
      payload,
      context: { accountId: 'acc-1' },
    });
    const expected = await findPrecedents(
      repos,
      { projectId: PROJECT, actionClass: 'A-02', target: 'db/migrations/002.sql', issueKey: ISSUE },
      { limit: 3 },
    );

    expect(out).toEqual(expected);
    expect(out.precedents[0].requestId).toBe('RQ-2026-0001');
  });

  it('refuses a query without class or target', async () => {
    const repos = createMemoryRepositories();
    const resolver = createResolvers({
      repos,
      engine: {},
      verifyChain: () => ({ valid: true, checked: 0 }),
    });

    const out = await callResolver(resolver, 'getPrecedents', {
      payload: { projectId: PROJECT },
    });

    expect(out).toEqual({ error: 'MISSING_QUERY' });
  });
});
