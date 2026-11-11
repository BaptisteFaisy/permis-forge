/**
 * Permit delegation (spec §26 "Chaîne de délégation", requirement PA-22).
 *
 * An agent that spawns sub-agents hands them a permit **narrower** than its own,
 * never wider: same or stricter class, target inside the parent's scope, same
 * ticket and project, expiry no later, uses no more than what is left. The
 * journal keeps the whole tree, so an auditor can follow a decision from the
 * human approval down to the sub-agent that acted.
 *
 * No cryptography is reimplemented here: signing and verification come from
 * src/core/permits, so a child permit is verifiable with the same secret.
 */
import { defaultLevelFor, isLockedClass } from '../core/catalog';
import { targetCovers } from '../core/glob';
import { makeEntry } from '../core/ledger';
import { isPermitActive, issuePermit, verifyPermit } from '../core/permits';
import { LedgerEntry, Permit, Repositories } from '../core/types';

export type DelegationError =
  | 'PARENT_SIGNATURE_INVALID'
  | 'PARENT_NOT_ACTIVE'
  | 'CLASS_NOT_ALLOWED'
  | 'TARGET_TOO_WIDE'
  | 'EXPIRY_TOO_LATE'
  | 'USES_TOO_MANY';

export interface DelegationRequest {
  /** Permit id of the child, allocated by the caller (repository sequence). */
  id: string;
  childProfileId: string;
  /** Defaults to the parent's class; a stricter class is allowed. */
  actionClass?: string;
  target: string;
  issuedAt: string;
  /** Minutes; must not push the expiry past the parent's. */
  ttlMinutes: number;
  uses: number;
}

export interface DelegationResult {
  permit?: Permit;
  error?: DelegationError;
}

/** Build a child permit, refusing any widening of the parent's grant. */
export function delegatePermit(
  parent: Permit,
  request: DelegationRequest,
  secret: string,
  nowIso?: string,
): DelegationResult {
  if (!verifyPermit(parent, secret)) return { error: 'PARENT_SIGNATURE_INVALID' };
  const now = nowIso ?? new Date().toISOString();
  if (!isPermitActive(parent, now, false)) return { error: 'PARENT_NOT_ACTIVE' };

  const childClass = request.actionClass ?? parent.scope.actionClass;
  if (!isClassAllowed(parent.scope.actionClass, childClass)) return { error: 'CLASS_NOT_ALLOWED' };
  if (!targetCovers(parent.scope.target, request.target)) return { error: 'TARGET_TOO_WIDE' };
  if (request.uses > parent.usesLeft) return { error: 'USES_TOO_MANY' };

  const child = issuePermit(
    {
      id: request.id,
      scope: {
        actionClass: childClass,
        target: request.target,
        issueKey: parent.scope.issueKey,
        projectId: parent.scope.projectId,
      },
      holderProfileId: request.childProfileId,
      pilotAccountId: parent.pilotAccountId,
      issuedAt: request.issuedAt,
      ttlMinutes: request.ttlMinutes,
      uses: request.uses,
    },
    secret,
  );
  if (child.expiresAt > parent.expiresAt) return { error: 'EXPIRY_TOO_LATE' };
  return { permit: child };
}

/** Same class, or a strictly more restrictive one; locked classes never open. */
function isClassAllowed(parentClass: string, childClass: string): boolean {
  if (isLockedClass(childClass) && childClass !== parentClass) return false;
  if (childClass === parentClass) return true;
  return defaultLevelFor(childClass) < defaultLevelFor(parentClass);
}

export interface ChainBreak {
  permitId: string;
  reason: DelegationError | 'PARENT_MISSING';
}

/**
 * Walk a delegation chain and report every link that does not hold: missing
 * parent, invalid signature, or a child wider than its parent.
 */
export function verifyDelegationChain(permits: Permit[], secret: string): {
  valid: boolean;
  breaks: ChainBreak[];
} {
  const byId = new Map(permits.map((permit) => [permit.id, permit]));
  const breaks: ChainBreak[] = [];
  for (const permit of permits) {
    const parentId = parentOf(permit);
    if (!parentId) continue;
    const parent = byId.get(parentId);
    if (!parent) {
      breaks.push({ permitId: permit.id, reason: 'PARENT_MISSING' });
      continue;
    }
    const widened = wideningOf(parent, permit);
    if (widened) breaks.push({ permitId: permit.id, reason: widened });
    if (!verifyPermit(permit, secret)) breaks.push({ permitId: permit.id, reason: 'PARENT_SIGNATURE_INVALID' });
  }
  return { valid: breaks.length === 0, breaks };
}

/** Parent id is carried in the permit's request field by convention. */
function parentOf(permit: Permit): string | undefined {
  const detail = (permit as Permit & { parentPermitId?: string }).parentPermitId;
  return detail ?? permit.requestId;
}

/** Which widening, if any, a child introduces over its parent. */
function wideningOf(parent: Permit, child: Permit): DelegationError | undefined {
  if (!isClassAllowed(parent.scope.actionClass, child.scope.actionClass)) return 'CLASS_NOT_ALLOWED';
  if (!targetCovers(parent.scope.target, child.scope.target)) return 'TARGET_TOO_WIDE';
  if (child.expiresAt > parent.expiresAt) return 'EXPIRY_TOO_LATE';
  if (child.scope.issueKey !== parent.scope.issueKey) return 'TARGET_TOO_WIDE';
  if (child.scope.projectId !== parent.scope.projectId) return 'TARGET_TOO_WIDE';
  return undefined;
}

export interface RecordDelegationOptions {
  projectId: string;
  at?: string;
  childProfileId: string;
  pilotAccountId: string;
}

/** Journalise the delegation so the tree is auditable. */
export async function recordDelegation(
  repos: Repositories,
  parent: Permit,
  child: Permit,
  options: RecordDelegationOptions,
): Promise<LedgerEntry> {
  const at = options.at ?? new Date().toISOString();
  const prev = await repos.ledger.lastEntry(options.projectId);
  const entry = makeEntry(
    {
      kind: 'permit-issued',
      projectId: options.projectId,
      issueId: child.scope.issueKey,
      profileId: options.childProfileId,
      pilotAccountId: options.pilotAccountId,
      actionClass: child.scope.actionClass,
      target: child.scope.target,
      permitId: child.id,
      decision: 'delegated',
      detail: {
        parentPermitId: parent.id,
        parentHolder: parent.holderProfileId,
        childProfileId: options.childProfileId,
        expiresAt: child.expiresAt,
        uses: child.usesLeft,
      },
      at,
    },
    prev,
  );
  await repos.ledger.append(entry);
  return entry;
}

/** Attach the parent id to a child permit so the chain can be walked back. */
export function withParent(permit: Permit, parentPermitId: string): Permit & { parentPermitId: string } {
  return { ...permit, parentPermitId };
}
