/**
 * End-to-end unit tests for the MCP action handlers (spec §14).
 */
import {
  checkPermission,
  declareAction,
  getAgentStanding,
  getPolicy,
  getRequestStatus,
  listPermits,
  requestApproval,
  submitPlan,
} from '../src';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { issuePermit, newPermitId } from '../src/core/permits';
import { resolveSigningSecret } from '../src/mcp/runtime';

describe('MCP handlers (spec §14)', () => {
  beforeEach(() => {
    resetDefaultRepositories();
  });

  it('checkPermission reclassifies migrations and explains the decision', async () => {
    const raw = await checkPermission({
      payload: { target: 'db/migrations/001.sql', actionClass: 'A-02', issueKey: 'PAY-1' },
      context: { accountId: 'pilot-1' },
    });
    const result = JSON.parse(raw);

    expect(result.actionClass).toBe('A-08');
    expect(result.reclassified).toBe(true);
    expect(result.level).toBe(2);
    expect(result.decision).toBe('deny');
    expect(result.requestId).toMatch(/^RQ-2026-\d{6}$/);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.guidance).toContain('Approval required');
  });

  it('getPolicy returns action classes, zones and rules', async () => {
    const raw = await getPolicy({
      payload: { projectKey: 'PAY' },
      context: {},
    });
    const result = JSON.parse(raw);

    expect(result.classes.length).toBe(15);
    expect(result.emergencyStopActive).toBe(false);
  });

  it('requestApproval creates a pending request with instructions to pause', async () => {
    const raw = await requestApproval({
      payload: {
        issueKey: 'PAY-1',
        actionClass: 'A-08',
        target: 'db/migrations/001.sql',
        justification: 'Add users index',
      },
      context: { accountId: 'pilot-1' },
    });
    const result = JSON.parse(raw);

    expect(result.requestId).toMatch(/^RQ-2026-\d{6}$/);
    expect(result.status).toBe('pending');
    expect(result.guidance).toContain('Stop here');

    const statusRaw = await getRequestStatus({
      payload: { requestId: result.requestId },
      context: {},
    });
    const status = JSON.parse(statusRaw);
    expect(status.found).toBe(true);
    expect(status.status).toBe('pending');
  });

  it('listPermits returns valid permits covering the ticket', async () => {
    const repos = getDefaultRepositories();
    const permit = issuePermit(
      {
        id: newPermitId(1, 2026),
        scope: { actionClass: 'A-08', target: 'db/migrations/001.sql', issueKey: 'PAY-1', projectId: 'PAY' },
        holderProfileId: 'default',
        pilotAccountId: 'pilot-1',
        issuedAt: '2026-11-11T09:00:00.000Z',
        ttlMinutes: 120,
        uses: 1,
      },
      resolveSigningSecret(),
    );
    await repos.permits.savePermit(permit);

    const raw = await listPermits({
      payload: { issueKey: 'PAY-1' },
      context: {},
    });
    const result = JSON.parse(raw);

    expect(result.permits).toHaveLength(1);
    expect(result.permits[0].id).toBe(permit.id);
  });

  it('declareAction appends a hash-chained ledger entry', async () => {
    const raw = await declareAction({
      payload: {
        issueKey: 'PAY-1',
        actionClass: 'A-08',
        target: 'db/migrations/001.sql',
        outcome: 'Applied cleanly',
        permitId: 'PA-2026-000001',
      },
      context: { accountId: 'pilot-1' },
    });
    const result = JSON.parse(raw);

    expect(result.declared).toBe(true);
    expect(result.seq).toBe(1);
    expect(result.hash).toHaveLength(64);
  });

  it('submitPlan parses bullets, evaluates actions, groups approvals', async () => {
    const plan = [
      '- [A-01] src/index.ts : read context',
      '- [A-08] db/migrations/001.sql : add table',
      '- [A-08] db/migrations/002.sql : add index',
    ].join('\n');

    const raw = await submitPlan({
      payload: { issueKey: 'PAY-1', plan },
      context: { accountId: 'pilot-1' },
    });
    const result = JSON.parse(raw);

    expect(result.actions).toHaveLength(3);
    expect(result.actions[0].decision).toBe('allow');
    expect(result.actions[1].decision).toBe('deny');
    expect(result.groupedRequestId).toMatch(/^RQ-2026-\d{6}$/);
  });

  it('getAgentStanding reports the score and current effects', async () => {
    const raw = await getAgentStanding({
      payload: { agentProfile: 'claude-code-payments' },
      context: {},
    });
    const result = JSON.parse(raw);

    expect(result.score).toBe(50);
    expect(result.status).toBe('active');
    expect(result.effects.length).toBeGreaterThan(0);
  });
});
