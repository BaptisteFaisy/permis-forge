/**
 * The local MCP server speaks stdio MCP and answers through the gate.
 *
 * opencode and ZeroClaw consume MCP tools; the Atlassian MCP endpoint needs an
 * administrator OAuth activation, so `scripts/permis-mcp-server.mjs` serves
 * `check-permission` / `declare-action` locally by calling the gate web
 * trigger. This test spawns the server against a stub gate and checks that
 * `tools/list` and a refused `check-permission` round-trip.
 */
import { spawn } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { join } from 'node:path';

const SERVER = join(__dirname, '..', 'scripts', 'permis-mcp-server.mjs');

interface Line {
  id?: number;
  method?: string;
  result?: unknown;
  error?: unknown;
}

function stubGate(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: 'test rule: N2, no permit',
          },
        }),
      );
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function port(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : 0;
}

function exchange(server: Server, messages: unknown[]): Promise<Line[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SERVER], {
      env: {
        ...process.env,
        PERMIS_GATE_URL: `http://127.0.0.1:${port(server)}`,
        PERMIS_AGENT_TOKEN: 'test-token',
        PERMIS_AGENT_ISSUE: 'PAY-42',
      },
    });
    const lines: Line[] = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buffer.slice(0, newline)));
        buffer = buffer.slice(newline + 1);
      }
      if (lines.length >= messages.filter((m) => (m as Line).id !== undefined).length) {
        child.kill();
      }
    });
    child.on('error', reject);
    child.on('close', () => resolve(lines));
    for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdin.end();
  });
}

describe('permis-mcp-server — the gate behind a stdio MCP', () => {
  it('lists check-permission and answers a refusal through the gate', async () => {
    const gate = await stubGate();
    try {
      const responses = await exchange(gate, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'check-permission', arguments: { action: 'Edit', target: 'db/migrations/x.sql' } },
        },
      ]);
      const list = responses.find((r) => r.id === 2)?.result as { tools: Array<{ name: string }> };
      expect(list.tools.map((tool) => tool.name)).toContain('check-permission');

      const call = responses.find((r) => r.id === 3)?.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(call.content[0].text).toContain('"permissionDecision": "deny"');
    } finally {
      gate.close();
    }
  });
});