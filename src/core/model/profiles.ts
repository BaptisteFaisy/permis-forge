/**
 * Agent profiles and personal hook tokens.
 *
 * An agent profile binds an AI client to a project with a status; a hook token
 * authenticates the human pilot driving it from a local hook file.
 */

export interface AgentProfile {
  id: string;
  projectId: string;
  /** e.g. "Claude Code — Payments team". */
  name: string;
  client: string;
  status: 'active' | 'suspended' | 'unconstrained';
}

export interface HookToken {
  accountId: string;
  tokenHash: string;
  label?: string;
  createdAt: string;
  lastUsedAt?: string;
}
