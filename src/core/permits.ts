/**
 * Signed permits (spec §8.3).
 *
 * A permit is what an approval produces: a scope (class + exact target +
 * ticket), a duration, a number of uses and a signature computed with the
 * installation secret. The signature covers the fields that define what was
 * granted — not `usesLeft`, which decreases on every use.
 */
import { createHmac } from 'crypto';
import { canonicalJson } from './ledger';
import { targetCovers } from './glob';
import { ActionRequest, Classification, IssuePermitInput, Permit } from './types';

const ID_PATTERN = /^PA-(\d{4})-(\d{6})$/;

/** Format a permit id: PA-<year>-<6 digits> (spec §8.3). */
export function newPermitId(sequence: number, year: number): string {
  if (!Number.isFinite(sequence) || sequence < 0) {
    throw new Error('PERMIT_SEQUENCE_INVALID');
  }
  return `PA-${year}-${String(sequence).padStart(6, '0')}`;
}

export function parsePermitId(id: string): { year: number; sequence: number } | undefined {
  const match = ID_PATTERN.exec(id ?? '');
  if (!match) return undefined;
  return { year: Number(match[1]), sequence: Number(match[2]) };
}

/** Fields covered by the signature: what was granted, when, to whom. */
function signedFields(permit: Permit): Record<string, unknown> {
  return {
    id: permit.id,
    scope: permit.scope,
    holderProfileId: permit.holderProfileId,
    pilotAccountId: permit.pilotAccountId,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
  };
}

export function signPermit(permit: Permit, secret: string): string {
  return createHmac('sha256', secret).update(canonicalJson(signedFields(permit))).digest('hex');
}

/** Build a signed permit from its inputs. */
export function issuePermit(input: IssuePermitInput, secret: string): Permit {
  const issuedAtMs = Date.parse(input.issuedAt);
  if (!Number.isFinite(issuedAtMs)) throw new Error('PERMIT_ISSUED_AT_INVALID');
  const ttl = input.ttlMinutes > 0 ? input.ttlMinutes : 120;
  const expiresAt = new Date(issuedAtMs + ttl * 60_000).toISOString();
  const permit: Permit = {
    id: input.id,
    requestId: input.requestId,
    scope: input.scope,
    holderProfileId: input.holderProfileId,
    pilotAccountId: input.pilotAccountId,
    issuedAt: input.issuedAt,
    expiresAt,
    usesLeft: input.uses > 0 ? input.uses : 1,
    signature: '',
  };
  return { ...permit, signature: signPermit(permit, secret) };
}

/** True when the signature still matches the granted scope. */
export function verifyPermit(permit: Permit, secret: string): boolean {
  if (!permit || typeof permit.signature !== 'string') return false;
  const expected = signPermit(permit, secret);
  return expected.length === permit.signature.length && expected === permit.signature;
}

/** A permit works only while it is unexpired, unrevoked, unsuspended and has uses. */
export function isPermitActive(permit: Permit, nowIso: string, killSwitchActive: boolean): boolean {
  if (!permit) return false;
  if (killSwitchActive) return false;
  if (permit.suspended) return false;
  if (permit.revokedAt) return false;
  if (permit.usesLeft <= 0) return false;
  const expires = Date.parse(permit.expiresAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(expires) || !Number.isFinite(now)) return false;
  return now < expires;
}

/** Does the permit cover exactly this action? */
export function permitCovers(
  permit: Permit,
  action: ActionRequest,
  classification: Classification,
): boolean {
  if (!permit) return false;
  if (permit.scope.actionClass !== classification.actionClass) return false;
  if (!targetCovers(permit.scope.target, action.target)) return false;
  if (permit.scope.issueKey && permit.scope.issueKey !== action.issueKey) return false;
  if (action.projectId && permit.scope.projectId !== action.projectId) return false;
  return true;
}

/** Immutable decrement of the remaining uses. */
export function consumePermitUse(permit: Permit): Permit {
  return { ...permit, usesLeft: Math.max(0, permit.usesLeft - 1) };
}

/** Revoke a permit; it stays in the journal. */
export function revokePermit(permit: Permit, at: string): Permit {
  return { ...permit, revokedAt: at };
}

/** Suspend (kill switch) or release every permit of a list. */
export function setSuspended(permits: Permit[], suspended: boolean): Permit[] {
  return permits.map((permit) => ({ ...permit, suspended }));
}
