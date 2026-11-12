/**
 * The delegation chain (spec §26).
 *
 * A sub-agent never receives more than its parent holds, so the permits of a
 * ticket form a tree that narrows as it goes down. The tree is not a column of
 * the permit table: it is rebuilt from the ledger, which is the tamper-evident
 * place for a chain of custody — and the only place the parent link exists.
 */
import { LedgerEntry } from '../core/types';

export interface DelegationNode {
  permitId: string;
  parentPermitId?: string;
  /** Profile holding the permit. */
  profileId: string;
  /** Profile the permit was delegated to, when it is a child. */
  childProfileId?: string;
  expiresAt?: string;
  uses?: number;
  /** 0 for a root permit, 1 for its child, and so on. */
  depth: number;
  children: DelegationNode[];
}

/** The permit entries of a journal, oldest first. */
function permitEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return entries.filter((entry) => entry.kind === 'permit-issued').sort((a, b) => a.seq - b.seq);
}

/** The details of a delegation entry, read defensively. */
function detailOf(entry: LedgerEntry): Record<string, unknown> {
  return (entry.detail ?? {}) as Record<string, unknown>;
}

/**
 * Build the tree of delegated permits.
 *
 * A node is a permit that was issued; its parent link, when it has one, is
 * the permit it was derived from. A node whose parent is not in the journal is
 * a root: the link points to a permit issued before the window, or by another
 * installation.
 */
export function buildDelegationTree(entries: LedgerEntry[]): DelegationNode[] {
  const rows = permitEntries(entries);
  const nodes = new Map<string, DelegationNode>();
  for (const entry of rows) {
    if (!entry.permitId) continue;
    const detail = detailOf(entry);
    nodes.set(entry.permitId, {
      permitId: entry.permitId,
      parentPermitId: typeof detail.parentPermitId === 'string' ? detail.parentPermitId : undefined,
      profileId: entry.profileId ?? 'default',
      childProfileId: typeof detail.childProfileId === 'string' ? detail.childProfileId : undefined,
      expiresAt: typeof detail.expiresAt === 'string' ? detail.expiresAt : undefined,
      uses: typeof detail.uses === 'number' ? detail.uses : undefined,
      depth: 0,
      children: [],
    });
  }

  const roots: DelegationNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentPermitId ? nodes.get(node.parentPermitId) : undefined;
    if (parent) {
      node.depth = parent.depth + 1;
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // The depth is the distance from the root, so it has to be recomputed once
  // the parent links are known.
  const assignDepth = (node: DelegationNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

/**
 * The chain a permit belongs to, from the root to the permit itself.
 *
 * The chain of custody of an action: who could have authorised it, and by
 * delegation of whom.
 */
export function delegationChain(entries: LedgerEntry[], permitId: string): DelegationNode[] {
  const nodes = new Map<string, DelegationNode>();
  for (const root of buildDelegationTree(entries)) collect(root, nodes);

  const chain: DelegationNode[] = [];
  let current = nodes.get(permitId);
  const seen = new Set<string>();
  while (current && !seen.has(current.permitId)) {
    seen.add(current.permitId);
    chain.unshift(current);
    current = current.parentPermitId ? nodes.get(current.parentPermitId) : undefined;
  }
  return chain;
}

/** Every node of the tree, flattened. */
function collect(node: DelegationNode, into: Map<string, DelegationNode>): void {
  into.set(node.permitId, node);
  for (const child of node.children) collect(child, into);
}

/** The widest chain of the tree: how deep the delegation ever went. */
export function delegationDepth(nodes: DelegationNode[]): number {
  return nodes.reduce(
    (deepest, node) => Math.max(deepest, node.depth, delegationDepth(node.children)),
    0,
  );
}
