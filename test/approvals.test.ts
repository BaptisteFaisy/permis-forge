import {
  REASON_NOT_AUTHORIZED_FOR_CLASS,
  REASON_PILOT_CANNOT_APPROVE,
  REASON_REQUEST_NOT_PENDING,
  REASON_SAME_ROLE_AS_EXISTING_APPROVAL,
  addApproval,
  canApprove,
  isRequestComplete,
  requiredApprovals,
  resolveRequestDecision,
} from '../src/core/approvals';
import { Approval, ApprovalRequest, ApproverIdentity, RequestStatus } from '../src/core/types';

/** Build a pending request at a given level. */
function request(level: ApprovalRequest['level'], approvals: Approval[] = [], status: RequestStatus = 'pending'): ApprovalRequest {
  return {
    id: 'RQ-2026-0001',
    issueId: 'PROJ-A-1',
    projectId: 'PROJ-A',
    profileId: 'prof-1',
    pilotAccountId: 'pilot-1',
    actionClass: 'A-09',
    target: 'db/users',
    level,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    approvals,
  };
}

/** Build an approval signed by someone holding a role. */
function approval(accountId: string, role: string, decision: Approval['decision'] = 'grant'): Approval {
  return { approverAccountId: accountId, role, decision, at: '2026-01-02T00:00:00.000Z' };
}

/** Build an approver identity. */
function approver(overrides: Partial<ApproverIdentity> = {}): ApproverIdentity {
  return {
    accountId: 'alice',
    roles: ['security'],
    isPilot: false,
    isAuthorizedForClass: true,
    ...overrides,
  };
}

describe('approvals', () => {
  it('asks two approvals at N1 and one at N2', () => {
    expect(requiredApprovals(1)).toBe(2);
    expect(requiredApprovals(2)).toBe(1);
    expect(requiredApprovals(0)).toBe(0);
    expect(requiredApprovals(3)).toBe(0);
    expect(requiredApprovals(4)).toBe(0);
    expect(requiredApprovals(5)).toBe(0);
  });

  it('never lets the pilot approve their own request (PA-05)', () => {
    const result = canApprove(request(2), approver({ isPilot: true }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(REASON_PILOT_CANNOT_APPROVE);
  });

  it('refuses an approver without mandate for the class', () => {
    const result = canApprove(request(2), approver({ isAuthorizedForClass: false }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(REASON_NOT_AUTHORIZED_FOR_CLASS);
  });

  it('refuses an approver on a request that is not pending anymore', () => {
    const result = canApprove(request(2, [], 'granted'), approver());
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe(REASON_REQUEST_NOT_PENDING);
  });

  it('checks the status before anything else', () => {
    const result = canApprove(request(2, [], 'frozen'), approver({ isPilot: true }));
    expect(result.reason).toBe(REASON_REQUEST_NOT_PENDING);
  });

  it('refuses a second grant coming from the same role at N1', () => {
    const withGrant = request(1, [approval('alice', 'security')]);
    const sameRole = canApprove(withGrant, approver({ accountId: 'carol', roles: ['security'] }));
    expect(sameRole.allowed).toBe(false);
    expect(sameRole.reason).toBe(REASON_SAME_ROLE_AS_EXISTING_APPROVAL);
  });

  it('accepts a grant from a different role at N1', () => {
    const withGrant = request(1, [approval('alice', 'security')]);
    const otherRole = canApprove(withGrant, approver({ accountId: 'bob', roles: ['dba'] }));
    expect(otherRole.allowed).toBe(true);
    expect(otherRole.reason).toBeUndefined();
  });

  it('accepts a plain approver on a pending request', () => {
    expect(canApprove(request(2), approver())).toEqual({ allowed: true });
  });

  it('needs two grants from two distinct roles at N1', () => {
    expect(isRequestComplete(request(1, []))).toBe(false);
    expect(isRequestComplete(request(1, [approval('alice', 'security')]))).toBe(false);
    expect(isRequestComplete(request(1, [approval('alice', 'security'), approval('bob', 'security')]))).toBe(false);
    expect(isRequestComplete(request(1, [approval('alice', 'security'), approval('bob', 'dba')]))).toBe(true);
  });

  it('needs a single grant at N2', () => {
    expect(isRequestComplete(request(2, []))).toBe(false);
    expect(isRequestComplete(request(2, [approval('alice', 'security')]))).toBe(true);
  });

  it('denies on the first denial, even with grants around', () => {
    const denied = request(1, [approval('alice', 'security'), approval('bob', 'dba'), approval('eve', 'cto', 'deny')]);
    expect(resolveRequestDecision(denied)).toBe('denied');
    expect(isRequestComplete(denied)).toBe(true);
  });

  it('asks for clarification when an approver clarifies', () => {
    expect(resolveRequestDecision(request(2, [approval('alice', 'security', 'clarify')]))).toBe('clarification');
  });

  it('stays pending without any decision', () => {
    expect(resolveRequestDecision(request(1, []))).toBe('pending');
    expect(resolveRequestDecision(request(2, [approval('alice', 'security')]))).toBe('granted');
  });

  it('appends an approval without mutating the request', () => {
    const before = request(2);
    const after = addApproval(before, approval('alice', 'security'));
    expect(before.approvals).toHaveLength(0);
    expect(before.status).toBe('pending');
    expect(after.approvals).toHaveLength(1);
    expect(after.status).toBe('granted');
    expect(after).not.toBe(before);
  });

  it('refreshes the status after each approval', () => {
    let current = request(1);
    current = addApproval(current, approval('alice', 'security'));
    expect(current.status).toBe('pending');
    current = addApproval(current, approval('bob', 'dba'));
    expect(current.status).toBe('granted');
    expect(current.approvals).toHaveLength(2);
  });

  it('denies the request as soon as somebody denies', () => {
    const denied = addApproval(request(2, [approval('alice', 'security')]), approval('bob', 'dba', 'deny'));
    expect(denied.status).toBe('denied');
  });

  it('flags a request asking for clarification', () => {
    const clarified = addApproval(request(2), approval('bob', 'dba', 'clarify'));
    expect(clarified.status).toBe('clarification');
  });

  it('never lifts a freeze with an approval', () => {
    const frozen = request(2, [], 'frozen');
    const approved = addApproval(frozen, approval('alice', 'security'));
    expect(approved.status).toBe('frozen');
    expect(approved.approvals).toHaveLength(1);
  });
});
