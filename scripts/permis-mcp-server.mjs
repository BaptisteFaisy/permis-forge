#!/usr/bin/env node
/**
 * Permis d'agir — serveur MCP local (transport stdio, zéro dépendance).
 *
 * Pourquoi ce fichier : la seule façon d'interroger le moteur de décision sans
 * passer par le point d'entrée MCP d'Atlassian (OAuth administrateur) est le
 * web trigger `gate`. Les clients qui consomment du MCP — opencode, ZeroClaw,
 * Claude Code, tout client stdio — peuvent donc appeler les outils du produit
 * quand un process local leur sert ces outils en parlant au gate. Ce fichier
 * est ce process.
 *
 * Outils servis :
 *   check-permission   décider AVANT d'agir (c'est la demande de permis) ;
 *   declare-action     déclarer une action déjà exécutée (PostToolUse / drift) ;
 *   status             état du projet — seulement si le serveur tourne en
 *                      « opérateur » (PERMIS_ADMIN_URL + secret fournis),
 *                      car un agent ne détient pas le secret d'installation.
 *
 * Environnement :
 *   PERMIS_GATE_URL       URL du gate (forge webtrigger create -f gate)
 *   PERMIS_AGENT_TOKEN    jeton personnel du pilote
 *   PERMIS_AGENT_ISSUE    clé de ticket envoyée en X-Permis-Issue
 *   PERMIS_ADMIN_URL      (optionnel) URL operateur pour l'outil status
 *   PERMIS_SIGNING_SECRET (optionnel) secret d'installation
 *
 * Protocole : MCP stdio, JSON-RPC 2.0 délimité par des fins de ligne.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.0.0';
const TOOL_LIST = [
  {
    name: 'check-permission',
    description:
      'Ask the Permis d\'agir gate whether an intended action is allowed, before executing it. Returns allow/deny/ask with the reason, and creates an approval request when the policy requires one.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The tool/action, e.g. Edit, Write, Bash.' },
        target: { type: 'string', description: 'The file path or command the action touches.' },
        command: { type: 'string', description: 'For Bash: the exact command.' },
        justification: { type: 'string', description: 'Why the agent wants to do it.' },
      },
      required: ['action', 'target'],
    },
  },
  {
    name: 'declare-action',
    description:
      'Declare an action that already ran (PostToolUse). Recorded in the journal, never blocks; feeds drift detection.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'The tool/action that ran.' },
        target: { type: 'string', description: 'The file path or command it touched.' },
        outcome: { type: 'string', description: 'What happened, in one line.' },
      },
      required: ['action', 'target'],
    },
  },
  ...(operatorConfigured()
    ? [
        {
          name: 'status',
          description: 'Installation status for the project: rules, zones, permits, ledger chain.',
          inputSchema: { type: 'object', properties: { projectId: { type: 'string' } } },
        },
      ]
    : []),
];

function env(name) {
  return process.env[name] ?? '';
}

function fileEnv(name, file) {
  try {
    return readFileSync(join(homedir(), '.atlassian', file), 'utf8').trim();
  } catch {
    return '';
  }
}

function operatorConfigured() {
  return Boolean(
    (process.env.PERMIS_ADMIN_URL || fileEnv('PERMIS_ADMIN_URL', 'permis-admin-url.txt')) &&
      (process.env.PERMIS_SIGNING_SECRET || fileEnv('PERMIS_SIGNING_SECRET', 'permis-signing-secret')),
  );
}

async function gatePost(payload, opts = {}) {
  const url = env('PERMIS_GATE_URL') || fileEnv('PERMIS_GATE_URL', 'permis-gate-url.txt');
  const token = env('PERMIS_AGENT_TOKEN') || fileEnv('PERMIS_AGENT_TOKEN', 'permis-agent-token.txt');
  if (!url || !token) {
    return { error: 'PERMIS_GATE_URL and PERMIS_AGENT_TOKEN are both required.' };
  }
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const issue = env('PERMIS_AGENT_ISSUE') || fileEnv('PERMIS_AGENT_ISSUE', 'permis-agent-issue.txt');
  if (issue) headers['X-Permis-Issue'] = issue;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return response.json();
  } catch (err) {
    return { error: `gate unreachable: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

async function adminPost(payload) {
  const url = env('PERMIS_ADMIN_URL') || fileEnv('PERMIS_ADMIN_URL', 'permis-admin-url.txt');
  const secret = env('PERMIS_SIGNING_SECRET') || fileEnv('PERMIS_SIGNING_SECRET', 'permis-signing-secret');
  if (!url || !secret) return { error: 'status needs PERMIS_ADMIN_URL and PERMIS_SIGNING_SECRET.' };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Permis-Admin': secret,
    },
    body: JSON.stringify(payload),
  });
  return response.json();
}

async function callTool(name, args) {
  const a = args ?? {};
  if (name === 'check-permission') {
    const payload = {
      toolName: String(a.action ?? ''),
      args: { file_path: String(a.target ?? ''), command: a.command },
      cwd: process.cwd(),
    };
    const answer = await gatePost(payload);
    const decision = answer?.hookSpecificOutput ?? answer;
    return JSON.stringify(decision, null, 2);
  }
  if (name === 'declare-action') {
    const answer = await gatePost(
      {
        mode: 'declare',
        toolName: String(a.action ?? ''),
        args: { file_path: String(a.target ?? '') },
        outcome: a.outcome,
      },
    );
    return JSON.stringify(answer, null, 2);
  }
  if (name === 'status') {
    if (!operatorConfigured()) return JSON.stringify({ error: 'operator credentials not set.' });
    const answer = await adminPost({ action: 'status', projectId: String(a.projectId ?? 'PAY') });
    return JSON.stringify(answer, null, 2);
  }
  return JSON.stringify({ error: `unknown tool: ${name}` });
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

const INIT_RESULT = {
  protocolVersion: '2024-11-05',
  capabilities: { tools: {} },
  serverInfo: { name: 'permis-d-agir-mcp', version: VERSION },
};

async function main() {
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      handleLine(line);
    }
  });
  process.stdin.on('end', () => {
    if (buffer.trim()) handleLine(buffer);
  });
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return respondError(null, -32700, 'Parse error');
  }
  if (message.method === 'initialize') {
    return respond(message.id, INIT_RESULT);
  }
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') {
    return;
  }
  if (message.method === 'ping') {
    return respond(message.id, {});
  }
  if (message.method === 'tools/list') {
    return respond(message.id, { tools: TOOL_LIST });
  }
  if (message.method === 'tools/call') {
    const result = await callTool(message.params?.name, message.params?.arguments);
    return respond(message.id, { content: [{ type: 'text', text: result }] });
  }
  return respondError(message.id ?? null, -32601, `Method not found: ${message.method}`);
}

main();