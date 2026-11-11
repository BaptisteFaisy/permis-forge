/**
 * Unit tests for the hook gate (web trigger) and the CI verification point.
 */
import { handleGate } from '../src';
import { issuePermit, newPermitId } from '../src/core/permits';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { createHookToken } from '../src/services/approvals-service';

function buildRequest(body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://install.webtrigger.atlassian.app/gate', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('handleGate', () => {
  let token: string;

  beforeEach(async () => {
    resetDefaultRepositories();
    const repos = getDefaultRepositories();
    const created = await createHookToken(repos, 'pilot-123', 'unit test');
    token = created.token;
  });

  it('rejects a request without a personal token with a 401', async () => {
    const response = await handleGate(buildRequest({ toolName: 'Bash', args: { command: 'ls' } }));
    expect(response.status).toBe(401);
  });

  it('rejects an unknown personal token', async () => {
    const response = await handleGate(buildRequest({ toolName: 'Bash', args: { command: 'ls' } }, 'wrong-token'));
    expect(response.status).toBe(401);
  });

  it('allows safe reads without creating an approval request', async () => {
    const response = await handleGate(
      buildRequest({ toolName: 'Read', args: { file_path: 'src/index.ts' } }, token),
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.hookSpecificOutput?.permissionDecision).toBe('allow');
  });

  it('blocks sensitive bash commands when no permit exists (acceptance #7)', async () => {
    const response = await handleGate(
      buildRequest({ toolName: 'Bash', args: { command: 'DROP TABLE users;' } }, token),
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('verifies a signed permit from a CI step (point d’application n°3)', async () => {
    const repos = getDefaultRepositories();
    const permit = issuePermit(
      {
        id: newPermitId(417, 2026),
        scope: { actionClass: 'A-08', target: 'db/migrations/001.sql', issueKey: 'PAY-1', projectId: 'PAY' },
        holderProfileId: 'default',
        pilotAccountId: 'pilot-123',
        issuedAt: new Date().toISOString(),
        ttlMinutes: 60,
        uses: 1,
      },
      resolveSigningSecret(),
    );
    await repos.permits.savePermit(permit);

    const response = await handleGate(buildRequest({ permitId: permit.id }));
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.found).toBe(true);
    expect(body.valid).toBe(true);
  });
});
