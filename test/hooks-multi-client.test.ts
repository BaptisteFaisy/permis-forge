/**
 * The hook configuration of each supported client (enforcement point 2), and
 * the declaration mode that closes the loop after a tool ran (enforcement
 * point 4).
 */
import { buildCursorHookFile, buildHookFile, buildHookFileForClient } from '../src/core/gate';
import { handleGate, resetVerificationBudget, WebTriggerRequest } from '../src/hooks/gate';
import { createHookToken } from '../src/services/approvals-service';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';

const GATE_URL = 'https://install.webtrigger.atlassian.app/public/gate';

function request(body: unknown, token?: string): WebTriggerRequest {
  const headers: Record<string, string[]> = {
    'Content-Type': ['application/json'],
    // The ticket the action serves; without it the project cannot be resolved.
    'X-Permis-Issue': ['PAY-42'],
  };
  if (token) headers.Authorization = [`Bearer ${token}`];
  return { method: 'POST', headers, body: JSON.stringify(body), path: '/public/gate', userPath: '' };
}

async function call(body: unknown, token?: string) {
  const response = await handleGate(request(body, token));
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

describe('hook configuration per client', () => {
  it('generates the Claude Code configuration with a hook before and after the tool', () => {
    const file = buildHookFile({ gateUrl: GATE_URL });

    expect(file.hooks.PreToolUse).toHaveLength(1);
    expect(file.hooks.PostToolUse).toHaveLength(1);
    expect(file.hooks.PostToolUse?.[0].matcher).toBe('Bash|Edit|Write|MultiEdit');
    // Same gate, same authentication: one URL, one token.
    const after = file.hooks.PostToolUse![0].hooks[0];
    expect(after.type).toBe('http');
    expect(after.url).toBe(GATE_URL);
    expect(after.onFailure).toBe('block');
    expect(after.headers.Authorization).toBe('Bearer $PERMIS_AGENT_TOKEN');
  });

  it('generates the Cursor configuration through the command bridge, fail closed', () => {
    const file = buildCursorHookFile({ gateUrl: GATE_URL }) as any;

    expect(file.version).toBe(1);
    expect(file.hooks.preToolUse).toHaveLength(1);
    expect(file.hooks.preToolUse[0].command).toBe('.cursor/hooks/gate-bridge.sh');
    expect(file.hooks.preToolUse[0].failClosed).toBe(true);
    // Cursor matches `Shell`, not `Bash`.
    expect(file.hooks.preToolUse[0].matcher).toBe('Shell|Write|Read');
    expect(Array.isArray(file._comment)).toBe(true);
  });

  it('dispatches on the client name', () => {
    expect((buildHookFileForClient('claude-code', { gateUrl: GATE_URL }) as any).hooks.PreToolUse).toBeDefined();
    expect((buildHookFileForClient('cursor', { gateUrl: GATE_URL }) as any).hooks.preToolUse).toBeDefined();
  });
});

describe('declaration mode — the action is declared without the agent helping', () => {
  let token: string;

  beforeEach(async () => {
    resetDefaultRepositories();
    resetVerificationBudget();
    const repos = getDefaultRepositories();
    token = (await createHookToken(repos, 'pilot-1', 'unit test')).token;
  });

  it('records the action in the ledger and answers without blocking', async () => {
    const { statusCode, payload } = await call(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls -la' },
        outcome: 'listed the directory',
      },
      token,
    );

    expect(statusCode).toBe(200);
    expect(payload.declared).toBe(true);
    expect(payload.seq).toBeGreaterThan(0);

    const repos = getDefaultRepositories();
    const entries = await repos.ledger.list({ projectId: 'PAY' });
    const declared = entries.find((entry) => entry.kind === 'action-declared');
    expect(declared).toBeDefined();
    expect(declared?.target).toBe('ls -la');
    expect(declared?.pilotAccountId).toBe('pilot-1');
  });

  it('classifies the target itself rather than trusting the client', async () => {
    const { payload } = await call(
      { mode: 'declare', toolName: 'Edit', args: { file_path: 'db/migrations/001_init.sql' } },
      token,
    );

    // A migration announced as an ordinary edit is recorded as a migration.
    expect(payload.actionClass).toBe('A-08');
  });

  it('never blocks: a declaration has nothing left to prevent', async () => {
    const { statusCode, payload } = await call(
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
      token,
    );
    // The action already happened: the gate records it, it does not refuse it.
    expect(statusCode).toBe(200);
    expect(payload.declared).toBe(true);
    expect(payload.hookSpecificOutput).toBeUndefined();
  });

  it('requires a personal token: an anonymous declaration is refused', async () => {
    const { statusCode } = await call({ mode: 'declare', toolName: 'Bash', args: { command: 'ls' } });
    expect(statusCode).toBe(401);
  });

  it('refuses a malformed declaration rather than guessing what ran', async () => {
    const { statusCode, payload } = await call({ mode: 'declare', toolName: 42, args: {} }, token);
    expect(statusCode).toBe(200);
    expect(payload.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
