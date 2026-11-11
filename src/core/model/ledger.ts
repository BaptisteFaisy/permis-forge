/**
 * Append-only hash-chained ledger and verification types.
 *
 * Provides cryptographic tamper-evident journaling of every governance event:
 * decisions, approvals, permits, trust updates, and kill switch toggles.
 */

export type LedgerKind =
  | 'decision'
  | 'request'
  | 'approval'
  | 'denial'
  | 'clarification'
  | 'permit-issued'
  | 'permit-used'
  | 'permit-revoked'
  | 'permit-expired'
  | 'action-declared'
  | 'trust-change'
  | 'kill-switch-on'
  | 'kill-switch-off'
  | 'plan-submitted'
  | 'deviation'
  | 'policy-changed'
  | 'correction';

/** Append-only, hash-chained journal entry (spec §11, §17). */
export interface LedgerEntry {
  seq: number;
  at: string;
  kind: LedgerKind;
  projectId: string;
  issueId?: string;
  profileId?: string;
  pilotAccountId?: string;
  actionClass?: string;
  /** Masked before storage (spec §19 Sobriété). */
  target?: string;
  ruleId?: string;
  decision?: string;
  permitId?: string;
  detail?: Record<string, unknown>;
  /** A correction is a NEW entry pointing at the old one. */
  correctsSeq?: number;
  prevHash: string;
  hash: string;
}

export interface LedgerEntryInput {
  kind: LedgerKind;
  projectId: string;
  issueId?: string;
  profileId?: string;
  pilotAccountId?: string;
  actionClass?: string;
  target?: string;
  ruleId?: string;
  decision?: string;
  permitId?: string;
  detail?: Record<string, unknown>;
  correctsSeq?: number;
  at?: string;
}

export interface LedgerFilter {
  projectId?: string;
  issueId?: string;
  profileId?: string;
  actionClass?: string;
  kind?: LedgerKind;
  since?: string;
  until?: string;
  limit?: number;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  /** First broken link, when any. */
  firstBreak?: { seq: number; expectedHash: string; actualHash: string };
}
