/**
 * Unit tests for src/services/sla.ts — the approval deadline, the reminder,
 * the escalation and the expiry. In-memory repositories and an injected
 * poster: fully offline and deterministic.
 */
import {
  DEFAULT_SLA,
  SlaPolicy,
  ageMinutes,
  buildSlaNotice,
  formatAge,
  slaState,
  sweepApprovals,
} from '../src/services/sla';
import { ApprovalRequest } from '../src/core/types';
import { createMemoryRepositories } from '../src/storage/memory';

const PROJECT = 'PAY';
const ISSUE = 'PAY-42';
/** A fixed "now", so every age in these tests is exact. */
const NOW = '2026-11-12T12:00:00.000Z';
const FAST: SlaPolicy = { remindAfterMinutes: 60, escalateAfterMinutes: 120, expireAfterMinutes: 1440 };

/** Minutes before NOW, as an ISO timestamp. */
function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

function pendingRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'RQ-2026-000001',
    issueId: ISSUE,
    projectId: PROJECT,
    profileId: 'default',
    pilotAccountId: 'pilot-1',
    actionClass: 'A-08',
    target: 'db/migrations/001.sql',
    level: 2,
    status: 'pending',
    createdAt: minutesAgo(10),
    approvals: [],
    approverRoles: ['tech-lead'],
    ...overrides,
  };
}

/** Poster that records the tickets it was asked to comment on. */
function recordingPoster() {
  const tickets: string[] = [];
  return { tickets, poster: async (issueKey: string) => void tickets.push(issueKey) };
}

describe('ageMinutes and slaState', () => {
  it('measures how long a request has been waiting', () => {
    expect(ageMinutes(pendingRequest({ createdAt: minutesAgo(90) }), NOW)).toBe(90);
  });

  it('is never negative, whatever the clocks say', () => {
    expect(ageMinutes(pendingRequest({ createdAt: minutesAgo(-30) }), NOW)).toBe(0);
  });

  it('answers 0 on an unparsable timestamp rather than NaN', () => {
    expect(ageMinutes(pendingRequest({ createdAt: 'not a date' }), NOW)).toBe(0);
  });

  it('walks the four SLA states at their boundaries', () => {
    const at = (minutes: number) => slaState(pendingRequest({ createdAt: minutesAgo(minutes) }), NOW, FAST);
    expect(at(59)).toBe('on-time');
    expect(at(60)).toBe('due');
    expect(at(119)).toBe('due');
    expect(at(120)).toBe('late');
    expect(at(1439)).toBe('late');
    expect(at(1440)).toBe('stale');
  });

  it('formats an age a human reads as a deadline', () => {
    expect(formatAge(45)).toBe('45 min');
    expect(formatAge(90)).toBe('1 h');
    expect(formatAge(600)).toBe('10 h');
    expect(formatAge(60 * 72)).toBe('3 d');
  });

  it('defaults are looser than the test policy: four hours, twelve hours, seven days', () => {
    expect(DEFAULT_SLA.remindAfterMinutes).toBe(240);
    expect(DEFAULT_SLA.escalateAfterMinutes).toBe(720);
    expect(DEFAULT_SLA.expireAfterMinutes).toBe(7 * 24 * 60);
  });
});

describe('buildSlaNotice', () => {
  it('builds valid ADF: every bulletList child is a listItem', () => {
    const { body } = buildSlaNotice(pendingRequest(), 'reminder', 90);
    const lists = (body.content ?? []).filter((node) => node.type === 'bulletList');
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      for (const child of list.content ?? []) expect(child.type).toBe('listItem');
    }
  });

  it('names the request, how long it waited, and a different closing per action', () => {
    const reminder = JSON.stringify(buildSlaNotice(pendingRequest(), 'reminder', 900).body);
    const escalation = JSON.stringify(buildSlaNotice(pendingRequest(), 'escalation', 900).body);
    const expired = JSON.stringify(buildSlaNotice(pendingRequest(), 'expired', 20_000).body);

    expect(reminder).toContain('RQ-2026-000001');
    expect(reminder).toContain('15 h');
    expect(reminder).toContain('Refusing is a valid answer');
    expect(escalation).toContain('Escalated');
    expect(expired).toContain('expired');
  });
});

describe('sweepApprovals', () => {
  it('leaves a fresh request alone', async () => {
    const repos = createMemoryRepositories();
    const { tickets, poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(5) }));

    const result = await sweepApprovals(repos, { projectId: PROJECT, now: NOW, policy: FAST, poster });

    expect(result).toEqual({ scanned: 1, reminded: 0, escalated: 0, expired: 0, undelivered: 0 });
    expect(tickets).toEqual([]);
  });

  it('reminds once a request is past its deadline, and journals it', async () => {
    const repos = createMemoryRepositories();
    const { tickets, poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(90) }));

    const result = await sweepApprovals(repos, { projectId: PROJECT, now: NOW, policy: FAST, poster });

    expect(result.reminded).toBe(1);
    expect(tickets).toEqual([ISSUE]);
    const entries = await repos.ledger.list({ projectId: PROJECT, kind: 'sla' });
    expect(entries).toHaveLength(1);
    expect((entries[0].detail as any).action).toBe('reminder');
    expect((entries[0].detail as any).ageMinutes).toBe(90);
  });

  it('is idempotent: a second sweep does not nag again', async () => {
    const repos = createMemoryRepositories();
    const { tickets, poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(90) }));
    const options = { projectId: PROJECT, now: NOW, policy: FAST, poster };

    await sweepApprovals(repos, options);
    const second = await sweepApprovals(repos, options);

    expect(second.reminded).toBe(0);
    expect(tickets).toHaveLength(1);
  });

  it('escalates past the second deadline, once', async () => {
    const repos = createMemoryRepositories();
    const { tickets, poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(200) }));
    const options = { projectId: PROJECT, now: NOW, policy: FAST, poster };

    const first = await sweepApprovals(repos, options);
    const second = await sweepApprovals(repos, options);

    expect(first.escalated).toBe(1);
    expect(first.reminded).toBe(0);
    expect(second.escalated).toBe(0);
    expect(tickets).toHaveLength(1);
  });

  it('expires a stale request so the agent is not left waiting for ever', async () => {
    const repos = createMemoryRepositories();
    const { poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(5000) }));

    const result = await sweepApprovals(repos, { projectId: PROJECT, now: NOW, policy: FAST, poster });

    expect(result.expired).toBe(1);
    const request = await repos.requests.get('RQ-2026-000001');
    expect(request?.status).toBe('expired');
    expect(await repos.requests.listPending()).toHaveLength(0);
  });

  it('keeps the state change when the comment cannot be delivered', async () => {
    const repos = createMemoryRepositories();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(5000) }));

    const result = await sweepApprovals(repos, {
      projectId: PROJECT,
      now: NOW,
      policy: FAST,
      poster: async () => {
        throw new Error('HTTP 500');
      },
    });

    expect(result.expired).toBe(1);
    expect(result.undelivered).toBe(1);
    const request = await repos.requests.get('RQ-2026-000001');
    expect(request?.status).toBe('expired');
    errorSpy.mockRestore();
  });

  it('survives the absence of any Jira transport', async () => {
    const repos = createMemoryRepositories();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(90) }));

    const result = await sweepApprovals(repos, {
      projectId: PROJECT,
      now: NOW,
      policy: FAST,
      poster: undefined,
    });

    expect(result.reminded).toBe(1);
    // With or without a transport, the SLA step is journalled: the chain is
    // the record of record, the comment is only the announcement.
    const entries = await repos.ledger.list({ projectId: PROJECT, kind: 'sla' });
    expect(entries).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('sweeps only the project it is asked about', async () => {
    const repos = createMemoryRepositories();
    const { tickets, poster } = recordingPoster();
    await repos.requests.create(pendingRequest({ createdAt: minutesAgo(90) }));
    await repos.requests.create(
      pendingRequest({ id: 'RQ-2026-000002', projectId: 'ENGS', issueId: 'ENGS-7', createdAt: minutesAgo(90) }),
    );

    const result = await sweepApprovals(repos, { projectId: PROJECT, now: NOW, policy: FAST, poster });

    expect(result.scanned).toBe(1);
    expect(tickets).toEqual([ISSUE]);
  });
});
