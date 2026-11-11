/**
 * Approval requests (spec §8).
 *
 * A request is opened when no permit covers an action. It is granted when
 * the required number of approvals is reached — and, at N1, when those
 * approvals come from different roles (N1: two people, two roles).
 *
 * Two hard rules:
 * - the pilot who drives the agent never approves their own request (PA-05);
 * - a frozen request (kill switch) is never granted by an approval.
 */
import { Approval, ApprovalRequest, ApproverIdentity, AutonomyLevel, RequestStatus } from './types';

/** The request is not pending anymore (already granted, denied, expired...). */
export const REASON_REQUEST_NOT_PENDING = 'REQUEST_NOT_PENDING';
/** The pilot driving the agent cannot approve their own request (PA-05). */
export const REASON_PILOT_CANNOT_APPROVE = 'PILOT_CANNOT_APPROVE';
/** The approver has no mandate for this action class in this project. */
export const REASON_NOT_AUTHORIZED_FOR_CLASS = 'NOT_AUTHORIZED_FOR_CLASS';
/** N1: a second approval would come from the same role as an existing one. */
export const REASON_SAME_ROLE_AS_EXISTING_APPROVAL = 'SAME_ROLE_AS_EXISTING_APPROVAL';

/** Outcome of the approval workflow on a request. */
export type RequestDecision = 'granted' | 'denied' | 'clarification' | 'pending';

/**
 * How many approvals a level demands: N1 (dual approval) needs two, N2
 * (third-party approval) needs one, every other level needs none.
 */
export function requiredApprovals(level: AutonomyLevel): number {
  if (level === 1) return 2;
  if (level === 2) return 1;
  return 0;
}

/**
 * Can this approver decide on this request?
 *
 * Checks are evaluated in order: the first failing one explains the refusal.
 */
export function canApprove(
  request: ApprovalRequest,
  approver: ApproverIdentity,
): { allowed: boolean; reason?: string } {
  if (request.status !== 'pending') {
    return { allowed: false, reason: REASON_REQUEST_NOT_PENDING };
  }
  if (approver.isPilot) {
    return { allowed: false, reason: REASON_PILOT_CANNOT_APPROVE };
  }
  if (!approver.isAuthorizedForClass) {
    return { allowed: false, reason: REASON_NOT_AUTHORIZED_FOR_CLASS };
  }
  if (request.level === 1 && hasGrantFromSameRole(request, approver)) {
    return { allowed: false, reason: REASON_SAME_ROLE_AS_EXISTING_APPROVAL };
  }
  return { allowed: true };
}

/** True when an existing grant was signed by someone holding one of the roles of the approver. */
function hasGrantFromSameRole(request: ApprovalRequest, approver: ApproverIdentity): boolean {
  return request.approvals.some(
    (approval) => approval.decision === 'grant' && approver.roles.includes(approval.role),
  );
}

/**
 * A request is complete when it holds the required number of grants. At N1
 * those grants must come from at least two different roles.
 */
export function isRequestComplete(request: ApprovalRequest): boolean {
  const grants = request.approvals.filter((approval) => approval.decision === 'grant');
  if (grants.length < requiredApprovals(request.level)) return false;
  if (request.level === 1) return distinctRoles(grants) >= 2;
  return true;
}

/** Number of distinct roles among the given approvals. */
function distinctRoles(approvals: Approval[]): number {
  return new Set(approvals.map((approval) => approval.role)).size;
}

/**
 * Resolve the request from its approvals:
 * a single denial denies it, a complete set of grants grants it, an explicit
 * clarification asks for more information, otherwise it stays pending.
 */
export function resolveRequestDecision(request: ApprovalRequest): RequestDecision {
  if (request.approvals.some((approval) => approval.decision === 'deny')) return 'denied';
  if (isRequestComplete(request)) return 'granted';
  if (request.approvals.some((approval) => approval.decision === 'clarify')) return 'clarification';
  return 'pending';
}

/**
 * Append an approval to a request and refresh its status.
 *
 * The request is never mutated: a new object is returned. A frozen request
 * stays frozen — a kill switch is not lifted by an approval, only a denial
 * resolves a frozen request on the spot.
 */
export function addApproval(request: ApprovalRequest, approval: Approval): ApprovalRequest {
  const approvals = [...request.approvals, approval];
  const decision = resolveRequestDecision({ ...request, approvals });
  return { ...request, approvals, status: mapDecisionToStatus(decision, request.status) };
}

/** Translate a workflow decision into the stored request status. */
function mapDecisionToStatus(decision: RequestDecision, current: RequestStatus): RequestStatus {
  if (decision === 'denied') return 'denied';
  if (current === 'frozen') return 'frozen';
  if (decision === 'granted') return 'granted';
  if (decision === 'clarification') return 'clarification';
  return 'pending';
}
