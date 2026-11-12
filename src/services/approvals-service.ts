/**
 * Approval service — the write side of the approval flow (spec §8).
 *
 * Granting a request produces a signed, time-boxed permit; denying it keeps
 * the reason; both are written to the chained ledger. The pilot who drives
 * the agent can never approve their own request (spec PA-05).
 */
import { randomBytes } from 'crypto';
import { hashToken } from '../core/tokens';
import { addApproval, canApprove, resolveRequestDecision } from '../core/approvals';
import { issuePermit, newPermitId } from '../core/permits';
import { makeEntry } from '../core/ledger';
import { maskSecrets } from '../core/mask';
import { ApprovalRequest, LedgerEntry, Permit, Repositories } from '../core/types';

export interface ApproverInput {
  accountId: string;
  roles: string[];
  isPilot: boolean;
}

export interface ApprovalOutcome {
  ok: boolean;
  error?: string;
  request?: ApprovalRequest;
  permit?: Permit;
}

export interface ApprovalOptions {
  repos: Repositories;
  secret: string;
  requestId: string;
  approver: ApproverInput;
  reason?: string;
  ttlMinutes?: number;
  uses?: number;
  now?: string;
}

/** Grant an approval request; when complete, a permit is issued. */
export async function approveRequest(options: ApprovalOptions): Promise<ApprovalOutcome> {
  const { repos, requestId } = options;
  const request = await repos.requests.get(requestId);
  if (!request) return { ok: false, error: 'REQUEST_NOT_FOUND' };
  if (request.status !== 'pending' && request.status !== 'frozen') {
    return { ok: false, error: `REQUEST_NOT_PENDING (${request.status})` };
  }
  const check = canApprove(request, {
    accountId: options.approver.accountId,
    roles: options.approver.roles,
    isPilot: options.approver.isPilot,
    isAuthorizedForClass: isAuthorizedForClass(request, options.approver.roles),
  });
  if (!check.allowed) return { ok: false, error: check.reason ?? 'NOT_ALLOWED' };
  const at = options.now ?? new Date().toISOString();
  const updated = addApproval(request, {
    approverAccountId: options.approver.accountId,
    role: options.approver.roles[0] ?? 'unknown',
    decision: 'grant',
    reason: options.reason,
    at,
  });
  updated.status = resolveRequestDecision(updated) === 'granted' ? 'granted' : 'pending';
  await repos.requests.update(updated);
  await writeLedger(repos, request.projectId, {
    kind: 'approval',
    projectId: request.projectId,
    issueId: request.issueId,
    profileId: request.profileId,
    actionClass: request.actionClass,
    target: maskSecrets(request.target),
    decision: 'granted',
    detail: { requestId: request.id, approver: options.approver.accountId },
    at,
  });
  if (updated.status !== 'granted') {
    return { ok: true, request: updated };
  }
  const permit = await issuePermitForRequest(repos, options.secret, updated, options);
  return { ok: true, request: updated, permit };
}

/** Deny an approval request; the reason is mandatory. */
export async function denyRequest(options: ApprovalOptions): Promise<ApprovalOutcome> {
  const { repos, requestId } = options;
  if (!options.reason || options.reason.trim().length === 0) {
    return { ok: false, error: 'REASON_REQUIRED' };
  }
  const request = await repos.requests.get(requestId);
  if (!request) return { ok: false, error: 'REQUEST_NOT_FOUND' };
  const check = canApprove(request, {
    accountId: options.approver.accountId,
    roles: options.approver.roles,
    isPilot: options.approver.isPilot,
    isAuthorizedForClass: isAuthorizedForClass(request, options.approver.roles),
  });
  if (!check.allowed) return { ok: false, error: check.reason ?? 'NOT_ALLOWED' };
  const at = options.now ?? new Date().toISOString();
  const updated = addApproval(request, {
    approverAccountId: options.approver.accountId,
    role: options.approver.roles[0] ?? 'unknown',
    decision: 'deny',
    reason: options.reason,
    at,
  });
  updated.status = 'denied';
  await repos.requests.update(updated);
  await writeLedger(repos, request.projectId, {
    kind: 'denial',
    projectId: request.projectId,
    issueId: request.issueId,
    profileId: request.profileId,
    actionClass: request.actionClass,
    target: maskSecrets(request.target),
    decision: 'denied',
    detail: { requestId: request.id, approver: options.approver.accountId, reason: options.reason },
    at,
  });
  return { ok: true, request: updated };
}

/** Issue the permit that a granted request entitles the agent to. */
export async function issuePermitForRequest(
  repos: Repositories,
  secret: string,
  request: ApprovalRequest,
  options: { ttlMinutes?: number; uses?: number; now?: string },
): Promise<Permit> {
  const issuedAt = options.now ?? new Date().toISOString();
  const year = new Date(issuedAt).getUTCFullYear();
  const sequence = await repos.permits.nextPermitSequence(year);
  const permit = issuePermit(
    {
      id: newPermitId(sequence, year),
      scope: {
        actionClass: request.actionClass,
        target: request.target,
        issueKey: request.issueId,
        projectId: request.projectId,
      },
      requestId: request.id,
      holderProfileId: request.profileId,
      pilotAccountId: request.pilotAccountId,
      issuedAt,
      ttlMinutes: options.ttlMinutes ?? 120,
      uses: options.uses ?? 1,
    },
    secret,
  );
  await repos.permits.savePermit(permit);
  await writeLedger(repos, request.projectId, {
    kind: 'permit-issued',
    projectId: request.projectId,
    issueId: request.issueId,
    profileId: request.profileId,
    actionClass: request.actionClass,
    target: maskSecrets(request.target),
    permitId: permit.id,
    decision: 'issued',
    detail: { requestId: request.id, expiresAt: permit.expiresAt, uses: permit.usesLeft },
    at: issuedAt,
  });
  return permit;
}

/** Revoke a permit; it stays in the journal, it just stops working. */
export async function revokePermit(
  repos: Repositories,
  permitId: string,
  by: string,
  reason?: string,
  now?: string,
): Promise<{ ok: boolean; permit?: Permit }> {
  const permits = await repos.permits.listPermits({});
  const permit = permits.find((item) => item.id === permitId);
  if (!permit) return { ok: false };
  permit.revokedAt = now ?? new Date().toISOString();
  await repos.permits.savePermit(permit);
  await writeLedger(repos, permit.scope.projectId, {
    kind: 'permit-revoked',
    projectId: permit.scope.projectId,
    issueId: permit.scope.issueKey,
    actionClass: permit.scope.actionClass,
    target: maskSecrets(permit.scope.target),
    permitId: permit.id,
    decision: 'revoked',
    detail: { by, reason },
    at: permit.revokedAt,
  });
  return { ok: true, permit };
}

/** Create a personal hook token; only its hash is stored (spec §16). */
export async function createHookToken(
  repos: Repositories,
  accountId: string,
  label?: string,
): Promise<{ token: string; hash: string }> {
  const token = randomBytes(24).toString('base64url');
  const hash = hashToken(token);
  await repos.hookTokens.save({
    accountId,
    tokenHash: hash,
    label,
    createdAt: new Date().toISOString(),
  });
  return { token, hash };
}

/** A role is authorized when the request names it or when it is generic. */
function isAuthorizedForClass(request: ApprovalRequest, roles: string[]): boolean {
  const allowed = request.approverRoles ?? [];
  if (allowed.length === 0) return true;
  return roles.some((role) => allowed.includes(role));
}

/** Append one entry to the chained ledger of the project. */
async function writeLedger(
  repos: Repositories,
  projectId: string,
  input: Parameters<typeof makeEntry>[0],
): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(projectId);
  const entry = makeEntry(input, prev);
  await repos.ledger.append(entry);
  return entry;
}
