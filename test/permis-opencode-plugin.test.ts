/**
 * Le plugin opencode branche le crochet de permission sur le gate.
 *
 * opencode v2 n'a plus de hook « avant outil » à la Claude Code : il a
 * `permission.hook("evaluate")`, qui tourne avant l'action et peut la refuser.
 * Ce test exerce la logique pure du plugin (`examples/opencode-plugin/permis/
 * decide.ts`) contre une fausse gate : mapping des actions, serrage seulement,
 * et refus quand la gate est injoignable.
 */
import { createServer, Server } from 'node:http';

import {
  askGate,
  decidePermission,
  gatePayload,
  tighten,
  type GateConfig,
  type PermissionCheck,
} from '../examples/opencode-plugin/permis/decide';

interface RunningGate {
  config: GateConfig;
  close(): Promise<void>;
}

function answer(decision: 'allow' | 'ask' | 'deny', reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  });
}

function startGate(body: string, status = 200): Promise<RunningGate> {
  return new Promise((resolve) => {
    let calls = 0;
    const server: Server = createServer((_req, res) => {
      calls += 1;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        config: { url: `http://127.0.0.1:${port}`, token: 'test-token', issue: 'PAY-42', timeoutMs: 2_000 },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function check(overrides: Partial<PermissionCheck> = {}): PermissionCheck {
  return {
    action: 'edit',
    resources: ['db/migrations/911_probe.sql'],
    cwd: '/work',
    current: 'allow',
    ...overrides,
  };
}

describe('permis opencode plugin — la décision vient du gate, pas de l’agent', () => {
  it('maps edit and shell onto the same PreToolUse payload as the bridge', () => {
    expect(gatePayload('edit', 'src/a.ts', '/w')).toEqual({
      toolName: 'Edit',
      args: { file_path: 'src/a.ts' },
      cwd: '/w',
    });
    expect(gatePayload('shell', 'git push', '/w')).toEqual({
      toolName: 'Bash',
      args: { command: 'git push' },
      cwd: '/w',
    });
    expect(gatePayload('read', 'src/a.ts', '/w')).toBeUndefined();
  });

  it('only ever tightens a decision (never loosens it)', () => {
    expect(tighten('allow', 'deny')).toBe('deny');
    expect(tighten('allow', 'ask')).toBe('ask');
    expect(tighten('ask', 'allow')).toBe('ask');
    expect(tighten('deny', 'allow')).toBe('deny');
    expect(tighten('allow', 'allow')).toBe('allow');
  });

  it('carries the gate refusal and its reason', async () => {
    const gate = await startGate(answer('deny', 'pay-migrations-approval: N2, no permit (RQ-2026-000088)'));
    try {
      const verdict = await askGate(gatePayload('edit', 'db/migrations/911.sql', '/w')!, gate.config);
      expect(verdict.decision).toBe('deny');
      expect(verdict.reason).toContain('RQ-2026-000088');
    } finally {
      await gate.close();
    }
  });

  it('fails closed when the gate is unreachable', async () => {
    const verdict = await askGate(
      gatePayload('shell', 'rm -rf /', '/w')!,
      { url: 'http://127.0.0.1:9', token: 't', timeoutMs: 500 },
    );
    expect(verdict.decision).toBe('deny');
    expect(verdict.reason).toContain('failing closed');
  });

  it('fails closed on an HTTP error or an unreadable answer', async () => {
    const failing = await startGate('{"error":"boom"}', 500);
    const garbled = await startGate('{"nothing":true}');
    try {
      expect((await askGate(gatePayload('edit', 'a.ts', '/w')!, failing.config)).decision).toBe('deny');
      expect((await askGate(gatePayload('edit', 'a.ts', '/w')!, garbled.config)).decision).toBe('deny');
    } finally {
      await failing.close();
      await garbled.close();
    }
  });

  it('blocks an edit the gate denies, and says why', async () => {
    const gate = await startGate(answer('deny', 'pay-migrations-approval: N2, no permit'));
    try {
      const verdict = await decidePermission(check(), gate.config);
      expect(verdict?.effect).toBe('deny');
      expect(verdict?.message).toContain('pay-migrations-approval');
    } finally {
      await gate.close();
    }
  });

  it('leaves an allowed edit alone and ignores untouched actions', async () => {
    const gate = await startGate(answer('allow', 'no rule matched: N5'));
    try {
      expect(await decidePermission(check(), gate.config)).toBeUndefined();
      expect(await decidePermission(check({ action: 'read' }), gate.config)).toBeUndefined();
    } finally {
      await gate.close();
    }
  });

  it('refuses everything when no credentials are configured', async () => {
    const verdict = await decidePermission(check(), null);
    expect(verdict?.effect).toBe('deny');
    expect(verdict?.message).toContain('PERMIS_GATE_URL');
  });

  it('denies a compound shell command if any subcommand is denied', async () => {
    const gate = await startGate(answer('deny', 'pay-migrations-approval: N2'));
    try {
      const verdict = await decidePermission(
        check({ action: 'shell', resources: ['git status', 'rm -rf db'] }),
        gate.config,
      );
      expect(verdict?.effect).toBe('deny');
    } finally {
      await gate.close();
    }
  });
});