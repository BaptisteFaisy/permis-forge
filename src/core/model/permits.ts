/**
 * Permits and permit issuance contracts.
 *
 * Defines cryptographic execution permits (HMAC-signed tokens with TTL and limited uses)
 * and the payload needed to issue a new permit.
 */

export interface PermitScope {
  actionClass: string;
  /** Exact target, or glob for plan-wide permits. */
  target: string;
  issueKey?: string;
  projectId: string;
}

export interface Permit {
  /** e.g. "PA-2026-000417". */
  id: string;
  requestId?: string;
  scope: PermitScope;
  holderProfileId: string;
  pilotAccountId: string;
  issuedAt: string;
  expiresAt: string;
  usesLeft: number;
  /** HMAC-SHA256 over the canonical signed fields, hex. */
  signature: string;
  revokedAt?: string;
  /** Kill switch suspends permits without destroying them (spec §12). */
  suspended?: boolean;
}

export interface IssuePermitInput {
  id: string;
  scope: PermitScope;
  requestId?: string;
  holderProfileId: string;
  pilotAccountId: string;
  /** ISO. */
  issuedAt: string;
  ttlMinutes: number;
  uses: number;
}
