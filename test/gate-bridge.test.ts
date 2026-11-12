/**
 * The command bridge must block a refused action, not merely describe it.
 *
 * A client that uses the bridge as a wrapper (a script, a CI step, an agent
 * running a command) reads only the exit code. If the bridge exits 0 on a
 * refusal, the action runs anyway — the exact fail-open a refusal exists to
 * prevent. The fix: exit 2 when the gate answers `deny`, while keeping the
 * full decision on stdout for the clients that parse it.
 */
import { spawn } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';

const BRIDGE = join(__dirname, '..', 'examples', 'hooks', 'gate-bridge.sh');

function gate(decision: 'deny' | 'allow'): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: 'test rule',
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Run the bridge and resolve with its exit status and stdout/stderr. */
function runBridge(url: string): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [BRIDGE], {
      env: {
        ...process.env,
        PERMIS_AGENT_GATE_URL: url,
        PERMIS_AGENT_TOKEN: 'test-token',
        PERMIS_AGENT_ISSUE: 'PAY-42',
        PERMIS_GATE_TIMEOUT: '3',
      },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status: status ?? -1, stdout }));
    child.stdin.end(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'db/migrations/x.sql' } }));
  });
}

describe('gate-bridge.sh — a refusal blocks the call', () => {
  it('exits 2 when the gate denies, and still prints the decision', async () => {
    const server = await gate('deny');
    try {
      const url = serverUrl(server);
      const result = await runBridge(url);
      expect(result.status).toBe(2);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    } finally {
      server.close();
    }
  });

  it('exits 0 when the gate allows', async () => {
    const server = await gate('allow');
    try {
      const url = serverUrl(server);
      const result = await runBridge(url);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"permissionDecision":"allow"');
    } finally {
      server.close();
    }
  });

  it('fails closed when the gate is unreachable', async () => {
    const result = await runBridge('http://127.0.0.1:1'); // nothing listens there
    expect(result.status).toBe(2);
  });
});

function serverUrl(server: Server): string {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}