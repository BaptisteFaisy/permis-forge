/**
 * Unit tests for the operator entry point (src/hooks/admin.ts).
 *
 * The endpoint is protected by the installation secret; these tests check that
 * protection, the Forge wire format, and that approvals still obey the service
 * guard rails (the pilot of a request cannot approve it).
 */
import { handleAdmin } from '../src/hooks/admin';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { makeEntry } from '../src/core/ledger';
import { ApprovalRequest } from '../src/core/types';

const SECRET = resolveSigningSecret();
const PROJECT = 'PAY';

function request(body: unknown, secret: string | null) {
  const headers: Record<string, string[]> = { 'Content-Type': ['application/json'] };
  if (secret !== null) headers['X-Permis-Admin'] = [secret];
  return { method: 'POST', headers, body: JSON.stringify(body), path: '/public/admin', userPath: '' };
}

// `null` means "no admin header"; undefined would silently fall back to SECRET.
async function call(body: unknown, secret: string | null = SECRET) {
  const response = await handleAdmin(request(body, secret));
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

async function pendingRequest(id: string, pilot = 'pilot-1'): Promise<ApprovalRequest> {
  const repos = getDefaultRepositories();
  const entry: ApprovalRequest = {
    id,
    issueId: 'PAY-1',
    projectId: PROJECT,
    profileId: 'default',
    pilotAccountId: pilot,
    actionClass: 'A-08',
    target: 'db/migrations/001_init.sql',
    level: 2,
    status: 'pending',
    createdAt: '2026-11-11T10:00:00.000Z',
    approvals: [],
    approverRoles: ['tech-lead'],
  };
  await repos.requests.create(entry);
  return entry;
}

describe('handleAdmin authentication', () => {
  beforeEach(() => resetDefaultRepositories());

  it('refuses a call without the installation secret', async () => {
    const { statusCode, payload } = await call({ action: 'status', projectId: PROJECT }, null);
    expect(statusCode).toBe(401);
    expect(payload.error).toBe('ADMIN_SECRET_REQUIRED');
  });

  it('refuses a wrong secret', async () => {
    const { statusCode, payload } = await call({ action: 'status', projectId: PROJECT }, 'wrong-secret');
    expect(statusCode).toBe(401);
    expect(payload.error).toBe('ADMIN_SECRET_INVALID');
  });

  it('answers an unknown action with the allowed list', async () => {
    const { statusCode, payload } = await call({ action: 'drop-everything' });
    expect(statusCode).toBe(400);
    expect(payload.error).toBe('UNKNOWN_ACTION');
    expect(payload.allowed).toContain('mint-token');
  });
});

describe('handleAdmin operations', () => {
  beforeEach(() => resetDefaultRepositories());

  it('reports the installation state and verifies the chain', async () => {
    const repos = getDefaultRepositories();
    await repos.ledger.append(makeEntry({ kind: 'decision', projectId: PROJECT, at: '2026-11-11T10:00:00.000Z' }));

    const { statusCode, payload } = await call({ action: 'status', projectId: PROJECT });
    expect(statusCode).toBe(200);
    expect(payload.ledgerEntries).toBe(1);
    expect(payload.chainValid).toBe(true);
  });

  it('mints a personal token once and stores only its hash', async () => {
    const { statusCode, payload } = await call({
      action: 'mint-token',
      accountId: 'pilot-1',
      label: 'laptop',
    });

    expect(statusCode).toBe(200);
    expect(String(payload.token).length).toBeGreaterThan(20);
    expect(payload.tokenHash).not.toBe(payload.token);

    const stored = await getDefaultRepositories().hookTokens.listForAccount('pilot-1');
    expect(stored).toHaveLength(1);
    expect(stored[0].tokenHash).toBe(payload.tokenHash);
  });

  it('refuses to mint a token without an account id', async () => {
    const { statusCode, payload } = await call({ action: 'mint-token' });
    expect(statusCode).toBe(400);
    expect(payload.error).toBe('ACCOUNT_ID_REQUIRED');
  });

  it('approves a pending request and issues the permit', async () => {
    await pendingRequest('RQ-2026-000001');

    const { statusCode, payload } = await call({
      action: 'approve-request',
      projectId: PROJECT,
      requestId: 'RQ-2026-000001',
      approverAccountId: 'tech-lead-2',
      roles: ['tech-lead'],
      reason: 'Demo approval',
      ttlMinutes: 30,
      uses: 1,
    });

    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.status).toBe('granted');
    expect(String(payload.permit)).toMatch(/^PA-\d{4}-\d{6}$/);
    expect(payload.usesLeft).toBe(1);
  });

  it('still refuses self-approval through the operator route', async () => {
    await pendingRequest('RQ-2026-000002', 'pilot-1');

    const { statusCode, payload } = await call({
      action: 'approve-request',
      requestId: 'RQ-2026-000002',
      approverAccountId: 'pilot-1',
      roles: ['tech-lead'],
      reason: 'I am the pilot',
    });

    expect(statusCode).toBe(403);
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('PILOT_CANNOT_APPROVE');
  });

  it('denies only with a written reason', async () => {
    await pendingRequest('RQ-2026-000003');

    const withoutReason = await call({
      action: 'deny-request',
      requestId: 'RQ-2026-000003',
      approverAccountId: 'tech-lead-2',
      roles: ['tech-lead'],
    });
    expect(withoutReason.payload.error).toBe('REASON_REQUIRED');

    const denied = await call({
      action: 'deny-request',
      requestId: 'RQ-2026-000003',
      approverAccountId: 'tech-lead-2',
      roles: ['tech-lead'],
      reason: 'Not this sprint',
    });
    expect(denied.payload.status).toBe('denied');
  });

  it('reports an unknown request as not found', async () => {
    const { statusCode, payload } = await call({ action: 'approve-request', requestId: 'RQ-2026-999999' });
    expect(statusCode).toBe(404);
    expect(payload.error).toBe('REQUEST_NOT_FOUND');
  });
});
