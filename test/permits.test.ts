/**
 * Unit tests for src/core/permits.ts — signed, scoped, time-boxed permits
 * (spec §8.3, acceptance scenarios 3 and 4 of spec §21).
 */
import {
  consumePermitUse,
  isPermitActive,
  issuePermit,
  newPermitId,
  parsePermitId,
  permitCovers,
  revokePermit,
  setSuspended,
  signPermit,
  verifyPermit,
} from '../src/core/permits';
import { ActionRequest, Classification, IssuePermitInput, Permit } from '../src/core/types';

const SECRET = 'installation-secret';
const ISSUED_AT = '2026-11-11T08:00:00.000Z';

function permit(overrides: Partial<IssuePermitInput> = {}): Permit {
  return issuePermit(
    {
      id: newPermitId(417, 2026),
      scope: { actionClass: 'A-08', target: 'db/migrations/001_init.sql', issueKey: 'PAY-12', projectId: 'PAY' },
      requestId: 'RQ-2026-000001',
      holderProfileId: 'claude-payments',
      pilotAccountId: 'pilot-1',
      issuedAt: ISSUED_AT,
      ttlMinutes: 120,
      uses: 1,
      ...overrides,
    },
    SECRET,
  );
}

function action(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    issueKey: 'PAY-12',
    target: 'db/migrations/001_init.sql',
    projectId: 'PAY',
    ...overrides,
  };
}

function classification(actionClass: string): Classification {
  return { actionClass, declaredClass: actionClass, reclassified: false, confidence: 'deterministic' };
}

describe('permit ids', () => {
  it('formats PA-<year>-<6 digits>', () => {
    expect(newPermitId(417, 2026)).toBe('PA-2026-000417');
    expect(newPermitId(1, 2026)).toBe('PA-2026-000001');
  });

  it('parses back a permit id', () => {
    expect(parsePermitId('PA-2026-000417')).toEqual({ year: 2026, sequence: 417 });
    expect(parsePermitId('nope')).toBeUndefined();
  });

  it('rejects a negative sequence', () => {
    expect(() => newPermitId(-1, 2026)).toThrow('PERMIT_SEQUENCE_INVALID');
  });
});

describe('signature', () => {
  it('verifies a freshly issued permit', () => {
    const issued = permit();
    expect(verifyPermit(issued, SECRET)).toBe(true);
  });

  it('expires two hours after issuance by default', () => {
    expect(permit().expiresAt).toBe('2026-11-11T10:00:00.000Z');
  });

  it('fails when the scope is tampered with', () => {
    const issued = permit();
    const tampered = { ...issued, scope: { ...issued.scope, target: 'db/migrations/999_drop.sql' } };
    expect(verifyPermit(tampered, SECRET)).toBe(false);
  });

  it('fails with another secret', () => {
    expect(verifyPermit(permit(), 'other-secret')).toBe(false);
  });

  it('ignores usesLeft, which is not signed', () => {
    const issued = permit({ uses: 3 });
    expect(verifyPermit(consumePermitUse(issued), SECRET)).toBe(true);
  });

  it('is stable for the same fields', () => {
    expect(signPermit(permit(), SECRET)).toBe(signPermit(permit(), SECRET));
  });
});

describe('isPermitActive', () => {
  const issued = permit();

  it('is active inside its window', () => {
    expect(isPermitActive(issued, '2026-11-11T09:00:00.000Z', false)).toBe(true);
  });

  it('is inactive once expired', () => {
    expect(isPermitActive(issued, '2026-11-11T10:00:00.000Z', false)).toBe(false);
  });

  it('is inactive when every use is spent', () => {
    expect(isPermitActive({ ...issued, usesLeft: 0 }, '2026-11-11T09:00:00.000Z', false)).toBe(false);
  });

  it('is inactive when revoked', () => {
    const revoked = revokePermit(issued, '2026-11-11T08:30:00.000Z');
    expect(isPermitActive(revoked, '2026-11-11T09:00:00.000Z', false)).toBe(false);
  });

  it('is suspended while the kill switch is on', () => {
    expect(isPermitActive(issued, '2026-11-11T09:00:00.000Z', true)).toBe(false);
  });

  it('is inactive when flagged suspended', () => {
    expect(isPermitActive({ ...issued, suspended: true }, '2026-11-11T09:00:00.000Z', false)).toBe(false);
  });

  it('rejects an unparsable expiry', () => {
    expect(isPermitActive({ ...issued, expiresAt: 'not-a-date' }, '2026-11-11T09:00:00.000Z', false)).toBe(false);
  });
});

describe('permitCovers', () => {
  const issued = permit();

  it('covers the exact target and class', () => {
    expect(permitCovers(issued, action(), classification('A-08'))).toBe(true);
  });

  it('does not cover another file (spec §20)', () => {
    expect(permitCovers(issued, action({ target: 'db/migrations/002_add_index.sql' }), classification('A-08'))).toBe(false);
  });

  it('does not cover another class', () => {
    expect(permitCovers(issued, action(), classification('A-09'))).toBe(false);
  });

  it('does not cover another ticket', () => {
    expect(permitCovers(issued, action({ issueKey: 'PAY-13' }), classification('A-08'))).toBe(false);
  });

  it('does not cover another project', () => {
    expect(permitCovers(issued, action({ projectId: 'OTHER' }), classification('A-08'))).toBe(false);
  });

  it('covers a glob scope used by plan permits', () => {
    const glob = permit({
      scope: { actionClass: 'A-08', target: 'db/migrations/**', issueKey: 'PAY-12', projectId: 'PAY' },
    });
    expect(permitCovers(glob, action({ target: 'db/migrations/002_add_index.sql' }), classification('A-08'))).toBe(true);
  });
});

describe('use accounting', () => {
  it('decrements immutably and never goes below zero', () => {
    const issued = permit({ uses: 2 });
    const after = consumePermitUse(issued);
    expect(issued.usesLeft).toBe(2);
    expect(after.usesLeft).toBe(1);
    expect(consumePermitUse({ ...after, usesLeft: 0 }).usesLeft).toBe(0);
  });

  it('lets one action through then refuses the second (spec §21.3)', () => {
    const single = permit({ uses: 1 });
    expect(isPermitActive(single, '2026-11-11T09:00:00.000Z', false)).toBe(true);
    const spent = consumePermitUse(single);
    expect(isPermitActive(spent, '2026-11-11T09:00:00.000Z', false)).toBe(false);
  });

  it('suspends and releases a batch of permits', () => {
    const batch = [permit(), permit({ id: newPermitId(418, 2026) })];
    expect(setSuspended(batch, true).every((item) => item.suspended)).toBe(true);
    expect(setSuspended(batch, false).every((item) => !item.suspended)).toBe(true);
  });
});
