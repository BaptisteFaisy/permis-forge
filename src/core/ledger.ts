/**
 * Chained ledger (spec §11) — append-only journal where every entry carries
 * the hash of the previous one. Rewriting or deleting an entry breaks the
 * chain, and the verification screen shows the first broken link.
 *
 * Hashing is deterministic: entries are serialised through canonicalJson
 * (sorted keys, no whitespace) and hashed with SHA-256, so the same decision
 * produces the same hash on any machine.
 */
import { createHash } from 'crypto';
import { ChainVerification, LedgerEntry, LedgerEntryInput } from './types';

/** Hash of the imaginary entry before the first one. */
export const GENESIS_HASH = '0'.repeat(64);

/** Stable JSON: object keys sorted recursively, arrays kept in order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(',')}}`;
}

/** SHA-256 of the canonical form of an entry without its own hash. */
export function entryHash(entry: Omit<LedgerEntry, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

/** Build the next entry of the chain, linked to the previous one. */
export function makeEntry(input: LedgerEntryInput, prev?: LedgerEntry): LedgerEntry {
  const at = input.at ?? new Date().toISOString();
  const draft: Omit<LedgerEntry, 'hash'> = {
    seq: (prev?.seq ?? 0) + 1,
    at,
    kind: input.kind,
    projectId: input.projectId,
    issueId: input.issueId,
    profileId: input.profileId,
    pilotAccountId: input.pilotAccountId,
    actionClass: input.actionClass,
    target: input.target,
    ruleId: input.ruleId,
    decision: input.decision,
    permitId: input.permitId,
    detail: input.detail,
    correctsSeq: input.correctsSeq,
    prevHash: prev?.hash ?? GENESIS_HASH,
  };
  return { ...draft, hash: entryHash(draft) };
}

/** Recompute the hash of one entry (used by the verifier). */
function recompute(entry: LedgerEntry): string {
  const { hash: _hash, ...rest } = entry;
  return entryHash(rest);
}

/** Verify a chain of entries ordered by seq; stop at the first break. */
export function verifyChain(entries: LedgerEntry[]): ChainVerification {
  let checked = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const previous = index > 0 ? entries[index - 1] : undefined;
    const actualHash = recompute(entry);
    if (actualHash !== entry.hash) {
      return {
        valid: false,
        checked,
        firstBreak: { seq: entry.seq, expectedHash: actualHash, actualHash: entry.hash },
      };
    }
    if (previous) {
      if (entry.prevHash !== previous.hash) {
        return {
          valid: false,
          checked,
          firstBreak: { seq: entry.seq, expectedHash: previous.hash, actualHash: entry.prevHash },
        };
      }
      if (entry.seq !== previous.seq + 1) {
        return {
          valid: false,
          checked,
          firstBreak: {
            seq: entry.seq,
            expectedHash: `seq ${previous.seq + 1}`,
            actualHash: `seq ${entry.seq}`,
          },
        };
      }
    } else if (entry.prevHash !== GENESIS_HASH && entry.seq === 1) {
      return {
        valid: false,
        checked,
        firstBreak: { seq: entry.seq, expectedHash: GENESIS_HASH, actualHash: entry.prevHash },
      };
    }
    checked++;
  }
  return { valid: true, checked };
}

/** A correction is a new entry pointing at the one it corrects. */
export function makeCorrection(
  input: LedgerEntryInput,
  correctedSeq: number,
  prev?: LedgerEntry,
): LedgerEntry {
  return makeEntry({ ...input, kind: 'correction', correctsSeq: correctedSeq }, prev);
}
