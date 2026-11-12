/**
 * The delegation chain rebuilt from the journal (spec §26).
 *
 * The tree is the answer to "who could have authorised this, and by
 * delegation of whom?" — the image that makes the delegation rule visible.
 */
import { buildDelegationTree, delegationChain, delegationDepth } from '../src/services/delegation-tree';
import { makeEntry } from '../src/core/ledger';
import { LedgerEntry } from '../src/core/types';

const PROJECT = 'PAY';
const ISSUE = 'PAY-42';

/** A permit issued from an approval: a root of the chain. */
function rootPermit(permitId: string): LedgerEntry {
  return makeEntry(
    {
      kind: 'permit-issued',
      projectId: PROJECT,
      issueId: ISSUE,
      profileId: 'parent-agent',
      pilotAccountId: 'pilot-1',
      actionClass: 'A-08',
      target: 'db/migrations/*',
      permitId,
      decision: 'granted',
      at: '2026-11-12T10:00:00.000Z',
    },
    undefined,
  );
}

/** A permit delegated from another one. */
function delegatedPermit(permitId: string, parentPermitId: string, holder: string): LedgerEntry {
  return makeEntry(
    {
      kind: 'permit-issued',
      projectId: PROJECT,
      issueId: ISSUE,
      profileId: holder,
      pilotAccountId: 'pilot-1',
      actionClass: 'A-08',
      target: 'db/migrations/001.sql',
      permitId,
      decision: 'delegated',
      detail: {
        parentPermitId,
        parentHolder: 'parent-agent',
        childProfileId: holder,
        expiresAt: '2026-11-12T12:00:00.000Z',
        uses: 1,
      },
      at: '2026-11-12T10:05:00.000Z',
    },
    undefined,
  );
}

describe('buildDelegationTree', () => {
  it('is empty when nothing was delegated', () => {
    expect(buildDelegationTree([])).toEqual([]);
  });

  it('nests a delegated permit under the permit it came from', () => {
    const tree = buildDelegationTree([rootPermit('PA-2026-000001'), delegatedPermit('PA-2026-000002', 'PA-2026-000001', 'child-agent')]);

    expect(tree).toHaveLength(1);
    expect(tree[0].permitId).toBe('PA-2026-000001');
    expect(tree[0].children).toHaveLength(1);
    expect(tree[0].children[0].permitId).toBe('PA-2026-000002');
    expect(tree[0].children[0].childProfileId).toBe('child-agent');
    expect(tree[0].children[0].depth).toBe(1);
    expect(delegationDepth(tree)).toBe(1);
  });

  it('counts the depth of a chain of delegations', () => {
    const tree = buildDelegationTree([
      rootPermit('PA-2026-000001'),
      delegatedPermit('PA-2026-000002', 'PA-2026-000001', 'child-agent'),
      delegatedPermit('PA-2026-000003', 'PA-2026-000002', 'grandchild-agent'),
    ]);

    expect(delegationDepth(tree)).toBe(2);
    expect(tree[0].children[0].children[0].permitId).toBe('PA-2026-000003');
  });

  it('treats a permit whose parent is unknown as a root', () => {
    const tree = buildDelegationTree([delegatedPermit('PA-2026-000009', 'PA-2026-000001', 'child-agent')]);

    expect(tree).toHaveLength(1);
    expect(tree[0].permitId).toBe('PA-2026-000009');
    expect(tree[0].parentPermitId).toBe('PA-2026-000001');
  });

  it('ignores the entries that are not permits', () => {
    const decision = makeEntry(
      { kind: 'decision', projectId: PROJECT, issueId: ISSUE, decision: 'deny', at: '2026-11-12T10:00:00.000Z' },
      undefined,
    );
    expect(buildDelegationTree([decision])).toEqual([]);
  });
});

describe('delegationChain', () => {
  it('walks from the root to the permit asked for', () => {
    const entries = [
      rootPermit('PA-2026-000001'),
      delegatedPermit('PA-2026-000002', 'PA-2026-000001', 'child-agent'),
      delegatedPermit('PA-2026-000003', 'PA-2026-000002', 'grandchild-agent'),
    ];

    const chain = delegationChain(entries, 'PA-2026-000003');

    expect(chain.map((node) => node.permitId)).toEqual([
      'PA-2026-000001',
      'PA-2026-000002',
      'PA-2026-000003',
    ]);
  });

  it('returns the permit alone when it has no parent', () => {
    const chain = delegationChain([rootPermit('PA-2026-000001')], 'PA-2026-000001');
    expect(chain.map((node) => node.permitId)).toEqual(['PA-2026-000001']);
  });

  it('is empty for a permit nobody issued', () => {
    expect(delegationChain([rootPermit('PA-2026-000001')], 'PA-2026-999999')).toEqual([]);
  });
});
