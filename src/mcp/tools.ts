/**
 * Runtime description of the eight MCP tools.
 *
 * The manifest (manifest.yml) is the source of truth for Forge; this file is
 * the runtime mirror used by the handlers, the docs and the CI manifest check
 * (scripts/check-manifest.mjs) which fails when the two drift apart.
 */

export type ToolVerb = 'GET' | 'CREATE' | 'UPDATE';

export interface ToolInput {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean';
  required: boolean;
  description: string;
}

export interface ToolDefinition {
  /** Action key in manifest.yml (also the MCP tool name). */
  key: string;
  name: string;
  verb: ToolVerb;
  description: string;
  inputs: ToolInput[];
}

export const TOOLS: ToolDefinition[] = [
  {
    key: 'check-permission',
    name: 'Check permission',
    verb: 'GET',
    description:
      'Decide whether an action is allowed for a class and a target. The target is reclassified when it must be (a file under migrations/ is a migration whatever the announced class).',
    inputs: [
      { name: 'issueKey', type: 'string', required: false, description: 'Jira issue key, e.g. PAY-123.' },
      { name: 'actionClass', type: 'string', required: false, description: 'Announced class, e.g. A-02.' },
      { name: 'target', type: 'string', required: true, description: 'Exact target: file path, table, command or description.' },
      { name: 'description', type: 'string', required: false, description: 'Free description of the action.' },
      { name: 'command', type: 'string', required: false, description: 'Raw command text when the action is a shell call.' },
    ],
  },
  {
    key: 'get-policy',
    name: 'Get policy',
    verb: 'GET',
    description: 'Return the policy in force for a project: action classes, zones, rules and effective levels.',
    inputs: [
      { name: 'projectKey', type: 'string', required: false, description: 'Jira project key, e.g. PAY.' },
    ],
  },
  {
    key: 'request-approval',
    name: 'Request approval',
    verb: 'CREATE',
    description: 'Create an approval request on the ticket with class, target, justification and plan.',
    inputs: [
      { name: 'issueKey', type: 'string', required: true, description: 'Jira issue key, e.g. PAY-123.' },
      { name: 'actionClass', type: 'string', required: true, description: 'Action class, e.g. A-08.' },
      { name: 'target', type: 'string', required: true, description: 'Exact target of the proposed action.' },
      { name: 'justification', type: 'string', required: false, description: 'Why the action is needed.' },
      { name: 'plan', type: 'string', required: false, description: 'Execution plan and rollback if any.' },
    ],
  },
  {
    key: 'get-request-status',
    name: 'Get request status',
    verb: 'GET',
    description: 'State of an approval request: pending, granted with a permit, denied with its reason, or frozen.',
    inputs: [
      { name: 'requestId', type: 'string', required: true, description: 'Request number, e.g. RQ-2026-000417.' },
    ],
  },
  {
    key: 'list-permits',
    name: 'List permits',
    verb: 'GET',
    description: 'Valid permits on a ticket: scope, expiry, remaining uses and signature.',
    inputs: [
      { name: 'issueKey', type: 'string', required: true, description: 'Jira issue key, e.g. PAY-123.' },
    ],
  },
  {
    key: 'declare-action',
    name: 'Declare action',
    verb: 'CREATE',
    description: 'Declare an executed action: class, target, outcome and permit used. Writes a ledger entry.',
    inputs: [
      { name: 'issueKey', type: 'string', required: true, description: 'Jira issue key, e.g. PAY-123.' },
      { name: 'actionClass', type: 'string', required: true, description: 'Class of the executed action, e.g. A-08.' },
      { name: 'target', type: 'string', required: true, description: 'Exact target of the executed action.' },
      { name: 'outcome', type: 'string', required: true, description: 'What happened, in one sentence. No secrets.' },
      { name: 'permitId', type: 'string', required: false, description: 'Permit used, e.g. PA-2026-000417.' },
    ],
  },
  {
    key: 'submit-plan',
    name: 'Submit plan',
    verb: 'CREATE',
    description: 'Submit the whole plan of a complex ticket; it is split into actions and approvals are grouped.',
    inputs: [
      { name: 'issueKey', type: 'string', required: true, description: 'Jira issue key, e.g. PAY-123.' },
      { name: 'plan', type: 'string', required: true, description: 'Plan as JSON (array of actions) or Markdown bullets.' },
    ],
  },
  {
    key: 'get-agent-standing',
    name: 'Get agent standing',
    verb: 'GET',
    description: 'Trust capital of an agent profile: score, status and current effects on autonomy levels.',
    inputs: [
      { name: 'agentProfile', type: 'string', required: true, description: 'Agent profile id, e.g. claude-code-payments.' },
    ],
  },
];

export function findTool(key: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.key === key);
}
