/**
 * Unit tests for the hook gate (web trigger) and the CI verification point.
 *
 * The gate speaks the Forge web trigger wire format: the request is a plain
 * object whose `body` is a string and whose header values are arrays, and the
 * answer is `{ statusCode, headers, body }`. A Fetch `Request` is also accepted
 * so the gate can be exercised offline.
 */
import { handleGate, WebTriggerRequest } from '../src/hooks/gate';
import { issuePermit, newPermitId } from '../src/core/permits';
import type { Permit } from '../src/core/types';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { createHookToken } from '../src/services/approvals-service';

/** Build a Forge-shaped web trigger request. */
function forgeRequest(body: unknown, options: { token?: string; issueKey?: string } = {}): WebTriggerRequest {
  const headers: Record<string, string[]> = { 'Content-Type': ['application/json'] };
  if (options.token) headers.Authorization = [`Bearer ${options.token}`];
  if (options.issueKey) headers['X-Permis-Issue'] = [options.issueKey];
  return { method: 'POST', headers, body: JSON.stringify(body), path: '/public/gate', userPath: '' };
}

async function call(body: unknown, options: { token?: string; issueKey?: string } = {}) {
  const response = await handleGate(forgeRequest(body, options));
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

describe('handleGate', () => {
  let token: string;

  beforeEach(async () => {
    resetDefaultRepositories();
    const repos = getDefaultRepositories();
    const created = await createHookToken(repos, 'pilot-123', 'unit test');
    token = created.token;
  });

  it('answers in the Forge web trigger format', async () => {
    const response = await handleGate(forgeRequest({ toolName: 'Read', args: { file_path: 'a.ts' } }, { token }));

    expect(response.statusCode).toBe(200);
    expect(response.headers['Content-Type']).toEqual(['application/json']);
    expect(typeof response.body).toBe('string');
    expect(JSON.parse(response.body).hookSpecificOutput.hookEventName).toBe('PreToolUse');
  });

  it('rejects a request without a personal token with a 401', async () => {
    const { statusCode, payload } = await call({ toolName: 'Bash', args: { command: 'ls' } });
    expect(statusCode).toBe(401);
    expect(payload.error).toBe('PERSONAL_TOKEN_REQUIRED');
  });

  it('rejects an unknown personal token', async () => {
    const { statusCode, payload } = await call(
      { toolName: 'Bash', args: { command: 'ls' } },
      { token: 'wrong-token' },
    );
    expect(statusCode).toBe(401);
    expect(payload.error).toBe('UNKNOWN_TOKEN');
  });

  interface PermitFixture {
    /** Exact target or glob of the permit scope; defaults to one migration file. */
    target?: string;
    /** Fields outside the signature (usesLeft, suspended, revokedAt). */
    mutate?: (permit: Permit) => void;
  }

  /** Issue a signed permit and persist it, for the CI verification mode below. */
  async function savedPermit(sequence: number, fixture: PermitFixture = {}): Promise<Permit> {
    const repos = getDefaultRepositories();
    const permit = issuePermit(
      {
        id: newPermitId(sequence, 2026),
        scope: {
          actionClass: 'A-08',
          target: fixture.target ?? 'db/migrations/001.sql',
          issueKey: 'PAY-1',
          projectId: 'PAY',
        },
        holderProfileId: 'default',
        pilotAccountId: 'pilot-123',
        issuedAt: new Date().toISOString(),
        ttlMinutes: 60,
        uses: 1,
      },
      resolveSigningSecret(),
    );
    // `mutate` only touches fields outside the signature (usesLeft, suspended, revokedAt).
    if (fixture.mutate) fixture.mutate(permit);
    await repos.permits.savePermit(permit);
    return permit;
  }

  it('allows safe reads without creating an approval request', async () => {
    const { statusCode, payload } = await call(
      { toolName: 'Read', args: { file_path: 'src/index.ts' } },
      { token, issueKey: 'PAY-1' },
    );
    expect(statusCode).toBe(200);
    expect(payload.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('blocks a data deletion when no permit exists (acceptance #7)', async () => {
    const { payload } = await call(
      { toolName: 'Bash', args: { command: 'psql -c "DELETE FROM sessions"' } },
      { token, issueKey: 'PAY-1' },
    );
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('lets the same deletion through once a permit covers it', async () => {
    const repos = getDefaultRepositories();
    const command = 'psql -c "DELETE FROM sessions"';
    const permit = issuePermit(
      {
        id: newPermitId(900, 2026),
        scope: { actionClass: 'A-09', target: command, issueKey: 'PAY-1', projectId: 'PAY' },
        holderProfileId: 'default',
        pilotAccountId: 'pilot-123',
        issuedAt: new Date().toISOString(),
        ttlMinutes: 60,
        uses: 1,
      },
      resolveSigningSecret(),
    );
    await repos.permits.savePermit(permit);

    const { payload } = await call({ toolName: 'Bash', args: { command } }, { token, issueKey: 'PAY-1' });
    expect(payload.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('refuses an action beyond N4 that carries no ticket (spec §20)', async () => {
    const { payload } = await call(
      { toolName: 'Bash', args: { command: 'psql -c "DELETE FROM sessions"' } },
      { token },
    );
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('Ticket reference required');
  });

  it('verifies a signed permit from a CI step (enforcement point 3)', async () => {
    const permit = await savedPermit(417);

    const { statusCode, payload } = await call({ permitId: permit.id });
    expect(statusCode).toBe(200);
    expect(payload.found).toBe(true);
    expect(payload.valid).toBe(true);
    expect(payload.usesLeft).toBe(1);
  });

  it('does not disclose a permit scope to an unauthenticated caller', async () => {
    const permit = await savedPermit(418);

    // Verification mode needs no token, so a caller holding only the gate URL can
    // enumerate sequential permit ids: the answer says whether the permit is valid and
    // why, never which target it authorises.
    const { payload } = await call({ permitId: permit.id });
    expect(payload.valid).toBe(true);
    expect('scope' in payload).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('db/migrations');
  });

  it('reports a suspended permit as invalid, and says so', async () => {
    const permit = await savedPermit(419, {
      mutate: (item) => {
        item.suspended = true;
      },
    });

    const { payload } = await call({ permitId: permit.id });
    expect(payload.valid).toBe(false);
    expect(payload.suspended).toBe(true);
    expect(payload.expired).toBe(false);
    expect(payload.signatureValid).toBe(true);
  });

  it('reports an unknown permit as invalid rather than as an error', async () => {
    const { payload } = await call({ permitId: 'PA-2026-999999' });
    expect(payload).toEqual({ permitId: 'PA-2026-999999', found: false, valid: false, covers: false });
  });

  it('covers every changed path of a pull request inside the permit scope', async () => {
    const permit = await savedPermit(420, { target: 'db/migrations/*' });

    const { payload } = await call({
      permitId: permit.id,
      paths: ['db/migrations/001.sql', 'db/migrations/002.sql'],
    });
    expect(payload.valid).toBe(true);
    expect(payload.covers).toBe(true);
    expect(payload.uncovered).toEqual([]);
  });

  it('refuses a pull request beyond the permit scope, and names the paths', async () => {
    const permit = await savedPermit(421, { target: 'db/migrations/*' });

    const { payload } = await call({
      permitId: permit.id,
      paths: ['db/migrations/001.sql', 'secrets/prod.env'],
    });
    expect(payload.valid).toBe(true);
    expect(payload.covers).toBe(false);
    expect(payload.uncovered).toEqual(['secrets/prod.env']);
    // The scope itself is still not disclosed.
    expect('scope' in payload).toBe(false);
  });

  it('accepts a newline separated list of paths, as a CI step produces', async () => {
    const permit = await savedPermit(422, { target: 'db/migrations/*' });

    const { payload } = await call({
      permitId: permit.id,
      paths: 'db/migrations/001.sql\ndb/migrations/002.sql',
    });
    expect(payload.covers).toBe(true);
  });

  it('still answers covers: true with no path, so existing callers are unaffected', async () => {
    const permit = await savedPermit(423);

    const { payload } = await call({ permitId: permit.id });
    expect(payload.valid).toBe(true);
    expect(payload.covers).toBe(true);
    expect(payload.uncovered).toEqual([]);
  });

  it('reports an unknown permit as covering nothing', async () => {
    const { payload } = await call({ permitId: 'PA-2026-888888', paths: ['db/migrations/001.sql'] });
    expect(payload.found).toBe(false);
    expect(payload.valid).toBe(false);
    expect(payload.covers).toBe(false);
  });

  it('still accepts a Fetch Request, for offline testing', async () => {
    const headers = new Headers({ 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
    const request = new Request('https://install.webtrigger.atlassian.app/public/gate', {
      method: 'POST',
      headers,
      body: JSON.stringify({ toolName: 'Read', args: { file_path: 'src/index.ts' } }),
    });

    const response = await handleGate(request as unknown as WebTriggerRequest);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).hookSpecificOutput.permissionDecision).toBe('allow');
  });
});

describe('a malformed hook payload is refused, not interpreted', () => {
  let token: string;

  beforeEach(async () => {
    resetDefaultRepositories();
    const repos = getDefaultRepositories();
    token = (await createHookToken(repos, 'pilot-123', 'unit test')).token;
  });

  /** The ledger size, to prove a refusal here writes nothing. */
  async function entries(): Promise<number> {
    const repos = getDefaultRepositories();
    return (await repos.ledger.list({ projectId: 'PAY' })).length;
  }

  it.each([
    ['a boolean', true],
    ['a number', 42],
    ['an object', { toolName: 'Bash' }],
    ['null', null],
    ['missing', undefined],
    ['an empty string', '   '],
  ])('refuses a tool name that is %s', async (_label, toolName) => {
    const { statusCode, payload } = await call(
      { toolName, args: { file_path: 'README.md' } },
      { token, issueKey: 'PAY-1' },
    );

    expect(statusCode).toBe(200);
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('Malformed hook payload');
  });

  it('refuses a dangerous command even when the tool name is the only thing wrong', async () => {
    const { payload } = await call(
      { toolName: true, args: { command: 'rm -rf /var/lib/prod' } },
      { token, issueKey: 'PAY-1' },
    );
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('still allows a well-formed tool the app does not know: an unknown name is not a malformed one', async () => {
    const { statusCode, payload } = await call(
      { toolName: 'SomeBrandNewClientTool', args: { file_path: 'README.md' } },
      { token, issueKey: 'PAY-1' },
    );

    expect(statusCode).toBe(200);
    expect(payload.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  it('classifies a well-formed unknown tool from its arguments', async () => {
    const { payload } = await call(
      { toolName: 'SomeBrandNewClientTool', args: { command: 'rm -rf /var/lib/prod' } },
      { token, issueKey: 'PAY-1' },
    );
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('writes nothing to the ledger: a transport defect is logged, not journalled', async () => {
    const before = await entries();
    await call({ toolName: 42, args: { command: 'rm -rf /' } }, { token, issueKey: 'PAY-1' });
    expect(await entries()).toBe(before);
  });
});
