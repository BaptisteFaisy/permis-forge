/**
 * Unit tests for permit delegation (PA-22, spec §26).
 */
import {
  delegatePermit,
  recordDelegation,
  verifyDelegationChain,
  withParent,
} from '../src/services/delegation';
import { issuePermit, newPermitId, revokePermit } from '../src/core/permits';
import { createMemoryRepositories } from '../src/storage/memory';
import { Permit } from '../src/core/types';

const SECRET = 'delegation-secret';
const ISSUED = '2026-11-11T10:00:00.000Z';
const PROJECT = 'PAY';
const ISSUE = 'PAY-42';

function parent(overrides: Partial<Parameters<typeof issuePermit>[0]> = {}): Permit {
  return issuePermit(
    {
      id: newPermitId(1, 2026),
      scope: { actionClass: 'A-08', target: 'db/migrations/**', issueKey: ISSUE, projectId: PROJECT },
      holderProfileId: 'claude-parent',
      pilotAccountId: 'pilot-1',
      issuedAt: ISSUED,
      ttlMinutes: 120,
      uses: 3,
      ...overrides,
    },
    SECRET,
  );
}

function childRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: newPermitId(2, 2026),
    childProfileId: 'claude-child',
    target: 'db/migrations/001_init.sql',
    issuedAt: ISSUED,
    ttlMinutes: 30,
    uses: 1,
    ...overrides,
  };
}

describe('delegatePermit', () => {
  it('issues a narrower child permit with a valid signature', () => {
    const outcome = delegatePermit(parent(), childRequest(), SECRET, ISSUED);

    expect(outcome.error).toBeUndefined();
    expect(outcome.permit?.id).toBe('PA-2026-000002');
    expect(outcome.permit?.scope.actionClass).toBe('A-08');
    expect(outcome.permit?.scope.target).toBe('db/migrations/001_init.sql');
    expect(outcome.permit?.holderProfileId).toBe('claude-child');
    expect(outcome.permit?.pilotAccountId).toBe('pilot-1');
    expect(outcome.permit?.usesLeft).toBe(1);
  });

  it('refuses a target outside the parent scope', () => {
    const outcome = delegatePermit(parent(), childRequest({ target: 'src/index.ts' }), SECRET, ISSUED);
    expect(outcome.error).toBe('TARGET_TOO_WIDE');
  });

  it('refuses a longer lifetime than the parent', () => {
    const outcome = delegatePermit(parent(), childRequest({ ttlMinutes: 180 }), SECRET, ISSUED);
    expect(outcome.error).toBe('EXPIRY_TOO_LATE');
  });

  it('refuses more uses than the parent has left', () => {
    const outcome = delegatePermit(parent({ uses: 1 }), childRequest({ uses: 2 }), SECRET, ISSUED);
    expect(outcome.error).toBe('USES_TOO_MANY');
  });

  it('refuses a less restrictive class', () => {
    const outcome = delegatePermit(parent(), childRequest({ actionClass: 'A-02' }), SECRET, ISSUED);
    expect(outcome.error).toBe('CLASS_NOT_ALLOWED');
  });

  it('accepts a strictly more restrictive class', () => {
    const outcome = delegatePermit(parent(), childRequest({ actionClass: 'A-09' }), SECRET, ISSUED);
    expect(outcome.error).toBeUndefined();
    expect(outcome.permit?.scope.actionClass).toBe('A-09');
  });

  it('refuses an expired, revoked or suspended parent', () => {
    expect(delegatePermit(parent(), childRequest(), SECRET, '2026-11-11T13:00:00.000Z').error)
      .toBe('PARENT_NOT_ACTIVE');
    const revoked = revokePermit(parent(), '2026-11-11T10:30:00.000Z');
    expect(delegatePermit(revoked, childRequest(), SECRET, ISSUED).error).toBe('PARENT_NOT_ACTIVE');
    const suspended = { ...parent(), suspended: true };
    expect(delegatePermit(suspended, childRequest(), SECRET, ISSUED).error).toBe('PARENT_NOT_ACTIVE');
  });

  it('refuses a tampered parent', () => {
    const tampered = { ...parent(), scope: { ...parent().scope, target: '**' } };
    expect(delegatePermit(tampered, childRequest(), SECRET, ISSUED).error).toBe('PARENT_SIGNATURE_INVALID');
  });
});

describe('verifyDelegationChain', () => {
  it('accepts a chain of narrowing permits', () => {
    const root = parent();
    const child = withParent(delegatePermit(root, childRequest(), SECRET, ISSUED).permit!, root.id);
    const grandChild = withParent(
      delegatePermit(child, childRequest({ id: newPermitId(3, 2026), target: 'db/migrations/001_init.sql', uses: 1 }), SECRET, ISSUED).permit!,
      child.id,
    );

    const verification = verifyDelegationChain([root, child, grandChild], SECRET);
    expect(verification.valid).toBe(true);
    expect(verification.breaks).toEqual([]);
  });

  it('reports a child widened after issuance', () => {
    const root = parent();
    const child = withParent(delegatePermit(root, childRequest(), SECRET, ISSUED).permit!, root.id);
    const widened = { ...child, expiresAt: '2026-11-12T10:00:00.000Z' };

    const verification = verifyDelegationChain([root, widened], SECRET);
    expect(verification.valid).toBe(false);
    expect(verification.breaks[0]).toEqual({ permitId: widened.id, reason: 'EXPIRY_TOO_LATE' });
  });

  it('reports a missing parent', () => {
    const orphan = withParent(parent(), 'PA-2026-999999');
    const verification = verifyDelegationChain([orphan], SECRET);
    expect(verification.valid).toBe(false);
    expect(verification.breaks[0].reason).toBe('PARENT_MISSING');
  });
});

describe('recordDelegation', () => {
  it('writes the filiation into the chained ledger', async () => {
    const repos = createMemoryRepositories();
    const root = parent();
    const child = delegatePermit(root, childRequest(), SECRET, ISSUED).permit!;

    const entry = await recordDelegation(repos, root, child, {
      projectId: PROJECT,
      childProfileId: 'claude-child',
      pilotAccountId: 'pilot-1',
      at: ISSUED,
    });

    expect(entry.kind).toBe('permit-issued');
    expect(entry.permitId).toBe(child.id);
    expect(entry.detail?.parentPermitId).toBe(root.id);
    expect(entry.detail?.childProfileId).toBe('claude-child');
    const stored = await repos.ledger.list({ projectId: PROJECT });
    expect(stored).toHaveLength(1);
  });
});
