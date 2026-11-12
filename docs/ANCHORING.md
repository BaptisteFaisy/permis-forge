# Daily ledger anchoring — third-party verification

The hash chain (`verifyChain`) proves the journal was not rewritten **inside**
the app. Anchoring makes that proof verifiable **from outside**: every night
the `nightly-maintenance` trigger computes a Merkle root of the day's ledger
entry hashes and publishes it where the application cannot silently edit it.

## What is anchored

For each project and each UTC day:

- **Leaves**: the `hash` field (SHA-256, lowercase hex) of every ledger entry
  whose `at` timestamp falls on that day, ordered by `seq`, **excluding**
  previous `anchor` entries (an anchor never anchors itself).
- **Root**: a Merkle tree where an internal node is `sha256(left + right)` —
  the concatenation of the two children's **hex strings** — and a level with
  an odd node count duplicates its last node. An empty day roots to the
  genesis constant: 64 zeros.
- **Record**: an `anchor` ledger entry is appended to the chain itself, with
  `detail = { root, count, day }`. Anchoring a day twice is impossible
  (idempotent).

## Where it is published

Two transports, both **outside** the app's Forge SQL database, where the app
cannot rewrite what it has already written:

| Transport | Configured by | Needs | Carries |
|---|---|---|---|
| **Jira comment** (default) | `PERMIS_ANCHOR_ISSUE` = the audit ticket key | nothing beyond `write:jira-work`, already granted | the root, the day, the entry count |
| Confluence page | `PERMIS_ANCHOR_SPACE` = the space key | the `write:confluence-content` scope, which `manifest.yml` does **not** request by default | the root and the full table of the day's entries |

The Jira comment is the default because it needs no permission the app does not
already hold — it reuses the comment poster of the approver notifications —
and because a comment lives in Jira's own storage, where the app has no edit
or delete path. The Confluence transport is richer (it carries the whole table
of entries) but opt-in: without the scope it is refused and the failure is
logged, and the root stays in the chain either way.

Publication is **best effort**: if it fails, the `anchor` entry is still
written to the chain and the failure is logged — it never propagates (same
contract as approver notifications).

Set the variable on the installation:

```bash
forge variables set PERMIS_ANCHOR_ISSUE PAY-1 --environment development
```

## How to verify a root by hand

1. Get the day's hashes in `seq` order (from the published page, or from a
   CSV export), one per line, into `hashes.txt`.

2. Recompute the root:

   ```bash
   python3 - <<'EOF'
   import hashlib
   level = [l.strip() for l in open('hashes.txt') if l.strip()]
   while len(level) > 1:
       level = [hashlib.sha256((level[i] + (level[i+1] if i+1 < len(level) else level[i])).encode()).hexdigest()
                for i in range(0, len(level), 2)]
   print(level[0] if level else '0' * 64)
   EOF
   ```

   The output must equal the published root. (With zero hashes the root is 64
   zeros; with one hash the root **is** that hash.)

3. Verify a single entry against the root with its inclusion proof (the
   sibling hash at each level, bottom-up — `merkleProof` in
   `src/core/merkle.ts`):

   ```bash
   # current = the entry hash; for each sibling, left-to-right (index parity
   # decides the side), then index = index / 2 (integer):
   printf '%s' "<left><right>" | sha256sum
   ```

   The final value must equal the published root. Any entry added, removed,
   reordered, or rewritten changes the root — the page published outside the
   database then no longer matches, and the `anchor` entry inside the chain
   (itself hash-chained to the day) records the root that was true that night.
