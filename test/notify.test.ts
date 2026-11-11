/**
 * Unit tests for approver notification (spec §8.1 card, §18 validation 6).
 */
import { buildApprovalNotice, notifyApprovers, precedentSummary } from '../src/services/notify';
import { classifyAction } from '../src/core/classify';
import { makeEntry } from '../src/core/ledger';
import { maskSecrets } from '../src/core/mask';
import { consumePermitUse, isPermitActive, permitCovers } from '../src/core/permits';
import { createDecisionEngine } from '../src/core/pipeline';
import { resolvePolicy } from '../src/core/policy';
import { trustAdjustLevel } from '../src/core/trust';
import { createMemoryRepositories } from '../src/storage/memory';
import { ApprovalRequest, Classification, LedgerEntry } from '../src/core/types';

const NOW = '2026-11-11T12:00:00.000Z';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: 'RQ-2026-000042',
    issueId: 'PAY-42',
    projectId: 'PAY',
    profileId: 'claude-payments',
    pilotAccountId: 'pilot-1',
    actionClass: 'A-08',
    target: 'db/migrations/001_init.sql',
    justification: 'Add the missing index',
    plan: 'CREATE INDEX … ; rollback: DROP INDEX …',
    level: 2,
    status: 'pending',
    createdAt: NOW,
    approvals: [],
    approverRoles: ['data-owner'],
    ...overrides,
  };
}

/** Flatten an ADF tree into readable text. */
function flatten(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return String(node.text ?? '');
  return (node.content ?? []).map(flatten).join(' ');
}

describe('buildApprovalNotice', () => {
  it('carries the six fields of the approval card', () => {
    const notice = buildApprovalNotice({ request: request(), levelName: 'N2 — Third-party approval' });
    const body = flatten(notice.body);

    expect(notice.title).toContain('RQ-2026-000042');
    expect(body).toContain('What:');
    expect(body).toContain('db/migrations/001_init.sql');
    expect(body).toContain('Why:');
    expect(body).toContain('Add the missing index');
    expect(body).toContain('How:');
    expect(body).toContain('rollback');
    expect(body).toContain('Risk:');
    expect(body).toContain('N2 — Third-party approval');
    expect(body).toContain('Who:');
    expect(body).toContain('pilot-1');
    expect(body).toContain('Approvers:');
    expect(body).toContain('data-owner');
  });

  it('states that the pilot cannot approve and that a denial needs a reason', () => {
    const body = flatten(buildApprovalNotice({ request: request() }).body);
    expect(body).toContain('cannot approve');
    expect(body).toContain('written reason');
  });

  it('produces valid ADF: a doc with version and content', () => {
    const notice = buildApprovalNotice({ request: request() });
    expect(notice.body.type).toBe('doc');
    expect(notice.body.version).toBe(1);
    expect(Array.isArray(notice.body.content)).toBe(true);
    const kinds = (notice.body.content ?? []).map((node: any) => node.type);
    expect(kinds).toContain('paragraph');
    expect(kinds).toContain('bulletList');
  });

  it('keeps a bulletList made only of listItem nodes (Jira rejects anything else)', () => {
    const notice = buildApprovalNotice({
      request: request(),
      reclassified: 'target under migrations/',
      precedents: '3 similar requests',
    });

    const lists = (notice.body.content ?? []).filter((node) => node.type === 'bulletList');
    expect(lists).toHaveLength(1);
    for (const list of lists) {
      for (const child of list.content ?? []) {
        expect(child.type).toBe('listItem');
      }
    }
    // Every block node holds a paragraph, and every leaf holds text.
    const check = (node: any): void => {
      if (node.type === 'text') {
        expect(typeof node.text).toBe('string');
        expect(node.text.length).toBeGreaterThan(0);
        return;
      }
      expect(Array.isArray(node.content)).toBe(true);
      for (const child of node.content ?? []) check(child);
    };
    for (const block of notice.body.content ?? []) check(block);
  });

  it('mentions a reclassification and the precedents when given', () => {
    const body = flatten(
      buildApprovalNotice({
        request: request(),
        reclassified: 'target under migrations/ is A-08',
        precedents: '3 similar requests, all granted',
      }).body,
    );
    expect(body).toContain('Reclassified:');
    expect(body).toContain('target under migrations/ is A-08');
    expect(body).toContain('Precedents:');
    expect(body).toContain('all granted');
  });

  it('falls back to a generic approver when no role is configured', () => {
    const body = flatten(buildApprovalNotice({ request: request({ approverRoles: [] }) }).body);
    expect(body).toContain('project administrator');
  });

  it('says when the agent gave no justification or plan', () => {
    const body = flatten(
      buildApprovalNotice({ request: request({ justification: undefined, plan: undefined }) }).body,
    );
    expect(body).toContain('not provided by the agent');
    expect(body).toContain('no plan supplied');
  });
});

describe('notifyApprovers', () => {
  it('posts one comment on the ticket of the request', async () => {
    const calls: { issueKey: string; body: any }[] = [];
    const result = await notifyApprovers(request(), {
      poster: async (issueKey, body) => {
        calls.push({ issueKey, body });
      },
    });

    expect(result.notified).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].issueKey).toBe('PAY-42');
    expect(calls[0].body.type).toBe('doc');
  });

  it('reports a missing ticket instead of guessing one', async () => {
    const result = await notifyApprovers(request({ issueId: '' }), { poster: async () => undefined });
    expect(result).toEqual({ notified: false, error: 'NO_ISSUE_ON_REQUEST' });
  });

  it('never throws when the delivery fails', async () => {
    const result = await notifyApprovers(request(), {
      poster: async () => {
        throw new Error('Jira comment failed: HTTP 403');
      },
    });
    expect(result.notified).toBe(false);
    expect(result.error).toContain('403');
  });
});

describe('precedentSummary', () => {
  it('counts grants, denials and later incidents', () => {
    const entries: LedgerEntry[] = [
      makeEntry({ kind: 'approval', projectId: 'PAY', actionClass: 'A-08', at: NOW }),
      makeEntry({ kind: 'approval', projectId: 'PAY', actionClass: 'A-08', at: NOW }),
      makeEntry({ kind: 'denial', projectId: 'PAY', actionClass: 'A-08', at: NOW }),
      makeEntry({ kind: 'trust-change', projectId: 'PAY', actionClass: 'A-08', detail: { trustKind: 'incident' }, at: NOW }),
    ];
    expect(precedentSummary(entries)).toBe('4 similar request(s): 2 granted, 1 denied, 1 incident(s) afterwards');
    expect(precedentSummary([])).toBeUndefined();
  });
});

describe('the pipeline notifies approvers when it creates a request', () => {
  function engine(repos: ReturnType<typeof createMemoryRepositories>, notify: jest.Mock) {
    return createDecisionEngine({
      repos,
      secret: 'notify-secret',
      classify: classifyAction,
      resolve: resolvePolicy,
      isPermitActive,
      permitCovers,
      consumePermitUse,
      maskSecrets,
      makeEntry,
      adjustLevel: trustAdjustLevel,
      notify,
      now: () => NOW,
    });
  }

  it('notifies once for a refused migration, and not for an allowed read', async () => {
    const repos = createMemoryRepositories();
    const notify = jest.fn(async (_request: ApprovalRequest, _classification: Classification) => undefined);
    const decide = engine(repos, notify);

    await decide.evaluateAction(
      { target: 'db/migrations/001_init.sql', issueKey: 'PAY-42', projectId: 'PAY', at: NOW },
      { projectId: 'PAY', issueKey: 'PAY-42', profileId: 'claude', pilot: { accountId: 'pilot-1', roles: [] }, via: 'mcp' },
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const notified = notify.mock.calls[0][0] as ApprovalRequest;
    expect(notified.actionClass).toBe('A-08');
    expect(notified.id).toMatch(/^RQ-2026-\d{6}$/);

    await decide.evaluateAction(
      { target: 'src/index.ts', declaredClass: 'A-01', issueKey: 'PAY-42', projectId: 'PAY', at: NOW },
      { projectId: 'PAY', issueKey: 'PAY-42', profileId: 'claude', pilot: { accountId: 'pilot-1', roles: [] }, via: 'mcp' },
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('still refuses the action when the notification fails', async () => {
    const repos = createMemoryRepositories();
    const notify = jest.fn(async (_request: ApprovalRequest, _classification: Classification) => {
      throw new Error('Jira unreachable');
    });
    const decide = engine(repos, notify);

    const decision = await decide.evaluateAction(
      { target: 'db/migrations/002_index.sql', issueKey: 'PAY-42', projectId: 'PAY', at: NOW },
      { projectId: 'PAY', issueKey: 'PAY-42', profileId: 'claude', pilot: { accountId: 'pilot-1', roles: [] }, via: 'mcp' },
    );

    expect(decision.decision).toBe('deny');
    expect(decision.requestId).toMatch(/^RQ-2026-\d{6}$/);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not notify for a request frozen by the emergency stop', async () => {
    const repos = createMemoryRepositories();
    await repos.killSwitches.save({ scope: 'project', projectId: 'PAY', active: true, by: 'sec', reason: 'Drill', at: NOW });
    const notify = jest.fn(async (_request: ApprovalRequest, _classification: Classification) => undefined);
    const decide = engine(repos, notify);

    await decide.evaluateAction(
      { target: 'db/migrations/003.sql', issueKey: 'PAY-42', projectId: 'PAY', at: NOW },
      { projectId: 'PAY', issueKey: 'PAY-42', profileId: 'claude', pilot: { accountId: 'pilot-1', roles: [] }, via: 'mcp' },
    );

    expect(notify).not.toHaveBeenCalled();
  });
});
