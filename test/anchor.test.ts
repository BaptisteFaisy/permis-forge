/**
 * Unit tests for src/services/anchor.ts — the daily Merkle anchor written to
 * the chain and published outside the app database. In-memory repositories,
 * injected publisher: fully offline and deterministic.
 */
import {
  AnchorPublication,
  anchorDay,
  anchorLeaves,
  buildAnchorPublication,
  dayOf,
} from '../src/services/anchor';
import { GENESIS_HASH, makeEntry, verifyChain } from '../src/core/ledger';
import { merkleRoot } from '../src/core/merkle';
import { createMemoryRepositories } from '../src/storage/memory';
import { LedgerEntry, Repositories } from '../src/core/types';

const PROJECT = 'PAY';
const DAY = '2026-11-11';
const AT = `${DAY}T23:50:00.000Z`;

/** Append a chain of `count` decision entries dated `day`; returns them. */
async function seedDay(repos: Repositories, day: string, count: number): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  for (let i = 0; i < count; i++) {
    const prev = await repos.ledger.lastEntry(PROJECT);
    const entry = makeEntry(
      {
        kind: 'decision',
        projectId: PROJECT,
        issueId: `PAY-${i + 1}`,
        actionClass: 'A-08',
        target: `db/migrations/00${i + 1}.sql`,
        decision: 'allow',
        at: `${day}T0${i}:00:00.000Z`,
      },
      prev,
    );
    await repos.ledger.append(entry);
    entries.push(entry);
  }
  return entries;
}

/** Publisher that records what it was asked to publish. */
function recordingPublisher(): { calls: AnchorPublication[]; publisher: (p: AnchorPublication) => Promise<void> } {
  const calls: AnchorPublication[] = [];
  return { calls, publisher: async (p) => void calls.push(p) };
}

let errorSpy: jest.SpyInstance;

beforeEach(() => {
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  errorSpy.mockRestore();
  delete process.env.PERMIS_ANCHOR_SPACE;
});

describe('dayOf', () => {
  it('extracts the UTC day of an ISO-8601 timestamp', () => {
    expect(dayOf('2026-11-11T23:59:59.999Z')).toBe('2026-11-11');
    expect(dayOf('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
  });
});

describe('anchorLeaves', () => {
  it('keeps only the day entries, in seq order, without previous anchors', () => {
    const entries: LedgerEntry[] = [
      { seq: 1, at: '2026-11-10T10:00:00.000Z', kind: 'decision', projectId: PROJECT, prevHash: GENESIS_HASH, hash: 'h1' },
      { seq: 2, at: `${DAY}T10:00:00.000Z`, kind: 'decision', projectId: PROJECT, prevHash: 'h1', hash: 'h2' },
      { seq: 3, at: `${DAY}T11:00:00.000Z`, kind: 'anchor', projectId: PROJECT, prevHash: 'h2', hash: 'h3' },
      { seq: 4, at: `${DAY}T12:00:00.000Z`, kind: 'decision', projectId: PROJECT, prevHash: 'h3', hash: 'h4' },
    ];
    const leaves = anchorLeaves(entries, DAY);
    expect(leaves.map((entry) => entry.hash)).toEqual(['h2', 'h4']);
  });
});

describe('anchorDay', () => {
  it('writes a chained anchor entry carrying the Merkle root of the day', async () => {
    const repos = createMemoryRepositories();
    const seeded = await seedDay(repos, DAY, 3);
    const { publisher } = recordingPublisher();

    const result = await anchorDay(repos, { projectId: PROJECT, at: AT, publisher });

    expect(result.anchored).toBe(true);
    expect(result.published).toBe(true);
    expect(result.count).toBe(3);
    expect(result.root).toBe(merkleRoot(seeded.map((entry) => entry.hash)));

    const anchors = await repos.ledger.list({ projectId: PROJECT, kind: 'anchor' });
    expect(anchors).toHaveLength(1);
    expect(anchors[0].detail?.root).toBe(result.root);
    expect(anchors[0].detail?.count).toBe(3);
    expect(anchors[0].detail?.day).toBe(DAY);
    // The anchor is part of the chain: its prevHash links to the last entry.
    expect(anchors[0].prevHash).toBe(seeded[2].hash);
    const all = await repos.ledger.list({ projectId: PROJECT });
    expect(verifyChain(all).valid).toBe(true);
  });

  it('anchors an empty day to the genesis constant', async () => {
    const repos = createMemoryRepositories();
    const result = await anchorDay(repos, { projectId: PROJECT, at: AT });
    expect(result.anchored).toBe(true);
    expect(result.root).toBe(GENESIS_HASH);
    expect(result.count).toBe(0);
  });

  it('excludes other days and previous anchors from the leaves', async () => {
    const repos = createMemoryRepositories();
    await seedDay(repos, '2026-11-10', 2);
    const today = await seedDay(repos, DAY, 2);

    await anchorDay(repos, { projectId: PROJECT, day: '2026-11-10', at: '2026-11-10T23:50:00.000Z' });
    const result = await anchorDay(repos, { projectId: PROJECT, at: AT });

    expect(result.count).toBe(2);
    expect(result.root).toBe(merkleRoot(today.map((entry) => entry.hash)));
  });

  it('is idempotent: the same day is not anchored twice', async () => {
    const repos = createMemoryRepositories();
    await seedDay(repos, DAY, 1);
    const first = await anchorDay(repos, { projectId: PROJECT, at: AT });
    const second = await anchorDay(repos, { projectId: PROJECT, at: AT });

    expect(first.anchored).toBe(true);
    expect(second.anchored).toBe(false);
    expect(second.error).toBe('ALREADY_ANCHORED');
    const anchors = await repos.ledger.list({ projectId: PROJECT, kind: 'anchor' });
    expect(anchors).toHaveLength(1);
  });

  it('publishes the root and the day table outside the database', async () => {
    const repos = createMemoryRepositories();
    const seeded = await seedDay(repos, DAY, 2);
    const { calls, publisher } = recordingPublisher();

    const result = await anchorDay(repos, { projectId: PROJECT, at: AT, publisher });

    expect(result.published).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].title).toContain(DAY);
    expect(calls[0].title).toContain(PROJECT);
    expect(calls[0].storage).toContain(result.root as string);
    // Reuses the existing Confluence export: the anchored hashes are in the page.
    for (const entry of seeded) {
      expect(calls[0].storage).toContain(entry.hash);
    }
  });

  it('keeps the anchor entry when the publication fails, and never throws', async () => {
    const repos = createMemoryRepositories();
    await seedDay(repos, DAY, 2);
    const failing = async () => {
      throw new Error('Confluence page failed: HTTP 500 boom');
    };

    const result = await anchorDay(repos, { projectId: PROJECT, at: AT, publisher: failing });

    expect(result.anchored).toBe(true);
    expect(result.published).toBe(false);
    expect(result.error).toBe('PUBLICATION_FAILED');
    // The entry is in the chain either way, and the failure is only logged.
    const anchors = await repos.ledger.list({ projectId: PROJECT, kind: 'anchor' });
    expect(anchors).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('survives a missing transport: root stays in the ledger, failure logged', async () => {
    const repos = createMemoryRepositories();
    await seedDay(repos, DAY, 1);

    const result = await anchorDay(repos, { projectId: PROJECT, at: AT });

    expect(result.anchored).toBe(true);
    expect(result.published).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    const anchors = await repos.ledger.list({ projectId: PROJECT, kind: 'anchor' });
    expect(anchors).toHaveLength(1);
  });
});

describe('buildAnchorPublication', () => {
  it('produces Confluence storage format with the root and the table', () => {
    const publication = buildAnchorPublication(PROJECT, DAY, 'abc123', []);
    expect(publication.storage).toContain('<table>');
    expect(publication.storage).toContain('abc123');
    expect(publication.storage).toContain(DAY);
  });
});
