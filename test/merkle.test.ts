/**
 * Unit tests for the Merkle tree used by the daily ledger anchoring
 * (docs/ANCHORING.md). Pure module: no storage, no network.
 */
import { merkleProof, merkleRoot, verifyMerkleProof } from '../src/core/merkle';
import { GENESIS_HASH, entryHash } from '../src/core/ledger';

/** Deterministic pseudo-hash: 64 hex chars derived from a seed string. */
function hash(seed: string): string {
  return entryHash({ seed } as never);
}

const ONE = hash('one');
const TWO = hash('two');
const THREE = hash('three');
const FOUR = hash('four');

describe('merkleRoot', () => {
  it('returns the genesis constant for an empty input', () => {
    expect(merkleRoot([])).toBe(GENESIS_HASH);
    expect(GENESIS_HASH).toBe('0'.repeat(64));
  });

  it('returns the single hash itself for one leaf', () => {
    expect(merkleRoot([ONE])).toBe(ONE);
  });

  it('pairs two leaves with sha256(left + right)', () => {
    const { createHash } = require('crypto');
    const expected = createHash('sha256').update(ONE + TWO, 'utf8').digest('hex');
    expect(merkleRoot([ONE, TWO])).toBe(expected);
  });

  it('handles an odd leaf count by duplicating the last node', () => {
    const { createHash } = require('crypto');
    const sha = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
    // Level 1: [sha(ONE+TWO), sha(THREE+THREE)] — the lone node pairs with itself.
    const left = sha(ONE + TWO);
    const right = sha(THREE + THREE);
    expect(merkleRoot([ONE, TWO, THREE])).toBe(sha(left + right));
  });

  it('is deterministic: same order, same root; other order, other root', () => {
    expect(merkleRoot([ONE, TWO, THREE, FOUR])).toBe(merkleRoot([ONE, TWO, THREE, FOUR]));
    expect(merkleRoot([ONE, TWO, THREE, FOUR])).not.toBe(merkleRoot([TWO, ONE, THREE, FOUR]));
  });

  it('changes when a single leaf is tampered with', () => {
    const honest = merkleRoot([ONE, TWO, THREE, FOUR]);
    const tampered = merkleRoot([ONE, hash('twO'), THREE, FOUR]);
    expect(tampered).not.toBe(honest);
  });
});

describe('merkleProof / verifyMerkleProof round-trip', () => {
  const leaves = [ONE, TWO, THREE, FOUR, hash('five')]; // odd count on purpose

  it('round-trips every leaf of an odd-sized tree', () => {
    const root = merkleRoot(leaves);
    for (let index = 0; index < leaves.length; index++) {
      const proof = merkleProof(leaves, index);
      expect(verifyMerkleProof(root, leaves[index], index, proof)).toBe(true);
    }
  });

  it('uses an empty proof for a single-leaf tree', () => {
    expect(merkleProof([ONE], 0)).toEqual([]);
    expect(verifyMerkleProof(ONE, ONE, 0, [])).toBe(true);
  });

  it('rejects a proof computed for a different leaf', () => {
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 1);
    expect(verifyMerkleProof(root, TWO, 0, proof)).toBe(false);
  });

  it('rejects a corrupted proof element', () => {
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 2);
    proof[0] = hash('corrupted');
    expect(verifyMerkleProof(root, THREE, 2, proof)).toBe(false);
  });

  it('rejects a tampered leaf against the honest root', () => {
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 3);
    expect(verifyMerkleProof(root, hash('FOUR'), 3, proof)).toBe(false);
  });

  it('rejects a proof against a different root', () => {
    const proof = merkleProof(leaves, 0);
    const otherRoot = merkleRoot([ONE, TWO]);
    expect(verifyMerkleProof(otherRoot, ONE, 0, proof)).toBe(false);
  });

  it('refuses an index outside the tree', () => {
    expect(() => merkleProof(leaves, leaves.length)).toThrow(RangeError);
    expect(() => merkleProof(leaves, -1)).toThrow(RangeError);
    expect(verifyMerkleProof(ONE, ONE, -1, [])).toBe(false);
  });
});
