/**
 * Merkle tree over ledger entry hashes (spec §11 — third-party verifiability).
 *
 * The hash chain proves the journal was not rewritten *inside* the app; a
 * daily Merkle root published outside the database lets a third party verify
 * a single entry without trusting the application at all.
 *
 * Deterministic conventions (documented in docs/ANCHORING.md so anyone can
 * recompute a root by hand):
 * - leaves are the entry hashes as given, in input order (no re-hashing);
 * - an internal node is SHA-256 of the lowercase-hex concatenation of its two
 *   children's hex strings: `sha256(left + right)`;
 * - a level with an odd number of nodes duplicates its LAST node (the lone
 *   node is paired with itself) — the classic Bitcoin-style choice, which
 *   keeps the tree shape a pure function of the leaf count;
 * - an empty input yields GENESIS_HASH (the same 64-zero constant the chain
 *   starts from, imported from ledger.ts — never redefined here).
 *
 * Pure module: no Atlassian SDK import, unit-testable anywhere.
 */
import { createHash } from 'crypto';
import { GENESIS_HASH } from './ledger';

/** SHA-256 hex digest of an ASCII string. */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Hash of one internal node: the concatenation of both children's hexes. */
function nodeHash(left: string, right: string): string {
  return sha256Hex(left + right);
}

/** Build one level from the previous one, duplicating a lone last node. */
function nextLevel(level: string[]): string[] {
  const parent: string[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const left = level[i];
    const right = i + 1 < level.length ? level[i + 1] : left;
    parent.push(nodeHash(left, right));
  }
  return parent;
}

/** Merkle root of the given hashes; GENESIS_HASH when the list is empty. */
export function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return GENESIS_HASH;
  let level = [...hashes];
  while (level.length > 1) {
    level = nextLevel(level);
  }
  return level[0];
}

/**
 * Inclusion proof for the leaf at `index`: the sibling hash at each level,
 * bottom-up. An empty proof means the leaf is the root (single-hash tree).
 */
export function merkleProof(hashes: string[], index: number): string[] {
  if (index < 0 || index >= hashes.length) {
    throw new RangeError(`index ${index} outside of ${hashes.length} hash(es)`);
  }
  const proof: string[] = [];
  let level = [...hashes];
  let position = index;
  while (level.length > 1) {
    const sibling = position % 2 === 0 ? position + 1 : position - 1;
    // Odd level: the lone last node is its own sibling (duplication rule).
    proof.push(level[sibling] ?? level[position]);
    level = nextLevel(level);
    position = Math.floor(position / 2);
  }
  return proof;
}

/** Recompute the root from one leaf and its proof. */
export function verifyMerkleProof(
  root: string,
  hash: string,
  index: number,
  proof: string[],
): boolean {
  if (index < 0) return false;
  let current = hash;
  let position = index;
  for (const sibling of proof) {
    current = position % 2 === 0 ? nodeHash(current, sibling) : nodeHash(sibling, current);
    position = Math.floor(position / 2);
  }
  return current === root;
}
