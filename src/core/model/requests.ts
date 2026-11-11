/**
 * Human approvals, approval requests, and approver identity.
 *
 * Covers requests created when an action requires human approval, the multi-role
 * approval lifecycle, and the identity validation of approving users.
 */

import type { AutonomyLevel } from './levels';

export type RequestStatus =
  | 'pending'
  | 'frozen'
  | 'granted'
  | 'denied'
  | 'clarification'
  | 'expired';

export interface Approval {
  approverAccountId: string;
  role: string;
  decision: 'grant' | 'deny' | 'clarify';
  /** Mandatory for denials and long durations (spec §25). */
  reason?: string;
  at: string;
}

export interface ApprovalRequest {
  /** e.g. "PA-2026-000417" style display id is on permits; requests get "RQ-<year>-<seq>". */
  id: string;
  issueId: string;
  projectId: string;
  profileId: string;
  pilotAccountId: string;
  actionClass: string;
  target: string;
  justification?: string;
  plan?: string;
  level: AutonomyLevel;
  status: RequestStatus;
  createdAt: string;
  approvals: Approval[];
  /** Roles allowed to approve this request (spec §8.2). */
  approverRoles?: string[];
}

export interface ApproverIdentity {
  accountId: string;
  roles: string[];
  /** True when this user is the pilot driving the agent. */
  isPilot: boolean;
  /** Role authorized for this action class in this project. */
  isAuthorizedForClass: boolean;
}
