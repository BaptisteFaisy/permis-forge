/**
 * Personal token revocation and the budget on the unauthenticated verification
 * path (src/hooks/gate.ts, src/hooks/admin.ts).
 *
 * Two properties matter here: a revoked token stops working immediately and
 * says why, and the endpoint that needs no token cannot be used to enumerate
 * permits without limit.
 */
import { handleAdmin } from '../src/hooks/admin';
import { handleGate, resetVerificationBudget, WebTriggerRequest } from '../src/hooks/gate';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { createHookToken } from '../src/services/approvals-service';
import { hashToken } from '../src/core/tokens';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';

const SECRET = resolveSigningSecret();

/** Build a Forge-shaped web trigger request (same wire format as the gate tests). */
function forgeRequest(body: unknown, token?: string): WebTriggerRequest {
  const headers: Record<string, string[]> = { 'Content-Type': ['application/json'] };
  if (token) headers.Authorization = [`Bearer ${token}`];
  return { method: 'POST', headers, body: JSON.stringify(body), path: '/public/gate', userPath: '' };
}

async function gate(body: unknown, token?: string) {
  const response = await handleGate(forgeRequest(body, token));
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

async function admin(body: unknown) {
  const response = await handleAdmin({
    method: 'POST',
    headers: { 'Content-Type': ['application/json'], 'X-Permis-Admin': [SECRET] },
    body: JSON.stringify(body),
    path: '/public/admin',
    userPath: '',
  } as never);
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

/** A readable action, so a working token is distinguishable from a refused one. */
const READ = { toolName: 'Read', args: { file_path: 'README.md' } };

beforeEach(() => {
  resetDefaultRepositories();
  resetVerificationBudget();
});

describe('token revocation', () => {
  it('refuses a revoked token immediately, and says it was revoked', async () => {
    const repos = getDefaultRepositories();
    const { token } = await createHookToken(repos, 'pilot-1', 'laptop');
    expect((await gate(READ, token)).statusCode).toBe(200);

    await repos.hookTokens.revoke(hashToken(token), 'operator', 'laptop lost', new Date().toISOString());
    const { statusCode, payload } = await gate(READ, token);

    expect(statusCode).toBe(401);
    // Not UNKNOWN_TOKEN: the pilot must look for a revocation, not for a typo.
    expect(payload.error).toBe('TOKEN_REVOKED');
  });

  it('keeps working for a token that was not revoked', async () => {
    const repos = getDefaultRepositories();
    const first = await createHookToken(repos, 'pilot-1', 'laptop');
    const second = await createHookToken(repos, 'pilot-2', 'workstation');
    await repos.hookTokens.revoke(hashToken(first.token), 'operator', undefined, new Date().toISOString());

    expect((await gate(READ, second.token)).statusCode).toBe(200);
  });

  it('revokes by plaintext token through the operator endpoint', async () => {
    const repos = getDefaultRepositories();
    const { token } = await createHookToken(repos, 'pilot-1', 'laptop');

    const { statusCode, payload } = await admin({
      action: 'revoke-token',
      token,
      by: 'operator',
      reason: 'laptop lost',
    });

    expect(statusCode).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.accountId).toBe('pilot-1');
    expect((await gate(READ, token)).statusCode).toBe(401);
  });

  it('revokes by hash, for an operator who never held the plaintext', async () => {
    const repos = getDefaultRepositories();
    const { token, hash } = await createHookToken(repos, 'pilot-1', 'laptop');

    const { statusCode } = await admin({ action: 'revoke-token', tokenHash: hash, by: 'operator' });

    expect(statusCode).toBe(200);
    expect((await gate(READ, token)).payload.error).toBe('TOKEN_REVOKED');
  });

  it('never echoes the token or its hash: a log of the call is not a credential store', async () => {
    const repos = getDefaultRepositories();
    const { token, hash } = await createHookToken(repos, 'pilot-1', 'laptop');

    const { payload } = await admin({ action: 'revoke-token', token, by: 'operator' });
    const flat = JSON.stringify(payload);

    expect(flat).not.toContain(token);
    expect(flat).not.toContain(hash);
  });

  it('answers 404 for a token that does not exist', async () => {
    const { statusCode, payload } = await admin({ action: 'revoke-token', token: 'not-a-real-token', by: 'operator' });
    expect(statusCode).toBe(404);
    expect(payload.error).toBe('UNKNOWN_TOKEN');
  });

  it('refuses to revoke nothing', async () => {
    const { statusCode, payload } = await admin({ action: 'revoke-token', by: 'operator' });
    expect(statusCode).toBe(400);
    expect(payload.error).toBe('TOKEN_OR_HASH_REQUIRED');
  });

  it('lists revoke-token among the allowed operator commands', async () => {
    const { payload } = await admin({ action: 'nope' });
    expect(payload.allowed).toContain('revoke-token');
  });
});

describe('hashToken is one implementation, shared', () => {
  it('the hash the gate authenticates with is the one the service stored', async () => {
    const repos = getDefaultRepositories();
    const { token, hash } = await createHookToken(repos, 'pilot-1', 'laptop');

    expect(hash).toBe(hashToken(token));
    expect(await repos.hookTokens.findByTokenHash(hashToken(token))).toBeDefined();
  });
});

describe('budget on the unauthenticated verification path', () => {
  it('answers verification while the window has budget', async () => {
    for (let i = 0; i < 60; i++) {
      const { statusCode } = await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' });
      expect(statusCode).toBe(200);
    }
  });

  it('answers 429 once the window is spent, so a CI check fails closed', async () => {
    for (let i = 0; i < 60; i++) await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' });

    const { statusCode, payload } = await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' });
    expect(statusCode).toBe(429);
    expect(payload.error).toBe('RATE_LIMITED');
    expect(payload.retryAfterSeconds).toBe(60);
  });

  it('does not limit authenticated decisions: the hook of a real pilot is never throttled', async () => {
    const repos = getDefaultRepositories();
    const { token } = await createHookToken(repos, 'pilot-1', 'laptop');
    for (let i = 0; i < 60; i++) await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' });

    expect((await gate(READ, token)).statusCode).toBe(200);
  });

  it('opens again with a new window', async () => {
    for (let i = 0; i < 61; i++) await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' });
    resetVerificationBudget();

    expect((await gate({ permitId: 'PA-2026-900001', projectId: 'PAY' })).statusCode).toBe(200);
  });
});
