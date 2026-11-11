/**
 * Offline deterministic tests for src/storage/queue.ts — the chained ledger
 * under concurrent writes (spec §18: seq attributed by a single-consumer
 * queue). Uses createMemoryRepositories only; no network, no timers.
 */
import { makeEntry, verifyChain } from '../src/core/ledger';
import type { LedgerEntry, Repositories } from '../src/core/types';
import { createMemoryRepositories } from '../src/storage/memory';
import { DEFAULT_MAX_RETRIES, LedgerConflictError, createLedgerWriter } from '../src/storage/queue';

/** Seed a valid chain of `count` entries, written one by one (no writer). */
async function seedChain(repos: Repositories, projectId: string, count: number): Promise<LedgerEntry[]> {
  const seeded: LedgerEntry[] = [];
  let prev: LedgerEntry | undefined;
  for (let index = 0; index < count; index++) {
    prev = makeEntry(
      { kind: 'decision', projectId, target: `seed-${index}`, at: `2026-11-10T08:00:0${index}.000Z` },
      prev,
    );
    await repos.ledger.append(prev);
    seeded.push(prev);
  }
  return seeded;
}

/** Repos whose ledger.lastEntry keeps returning a stale entry. */
function staleReadStub(repos: Repositories, stale: LedgerEntry, appendSpy: jest.Mock): Repositories {
  return {
    ...repos,
    ledger: {
      ...repos.ledger,
      lastEntry: jest.fn(async () => stale),
      append: appendSpy,
    },
  };
}

/** Seq numbers of a project journal, sorted, as read back from storage. */
async function seqsOf(repos: Repositories, projectId: string): Promise<number[]> {
  const entries = await repos.ledger.list({ projectId });
  return [...entries].sort((a, b) => a.seq - b.seq).map((entry) => entry.seq);
}

describe('ledger writer — 25 concurrent appends on one project', () => {
  it('produces 25 unique, contiguous seq 1..25 and a valid chain', async () => {
    const repos = createMemoryRepositories();
    const writer = createLedgerWriter(repos);
    const written = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        writer.append('PROJ', { kind: 'decision', target: `task-${index}` }),
      ),
    );

    expect(written).toHaveLength(25);
    const seqs = written.map((entry) => entry.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    expect(new Set(seqs).size).toBe(25);

    expect(await seqsOf(repos, 'PROJ')).toEqual(seqs);
    const verification = await writer.verifyProjectChain('PROJ');
    expect(verification).toEqual({ valid: true, checked: 25 });
  });
});

describe('ledger writer — two projects fed in parallel', () => {
  it('keeps two independent chains, both valid', async () => {
    const repos = createMemoryRepositories();
    const writer = createLedgerWriter(repos);
    const tasks: Promise<LedgerEntry>[] = [];
    for (let index = 0; index < 12; index++) {
      tasks.push(writer.append('ALPHA', { kind: 'decision', target: `a-${index}` }));
      tasks.push(writer.append('BETA', { kind: 'decision', target: `b-${index}` }));
    }
    await Promise.all(tasks);

    expect(await seqsOf(repos, 'ALPHA')).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await seqsOf(repos, 'BETA')).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect((await writer.verifyProjectChain('ALPHA')).valid).toBe(true);
    expect((await writer.verifyProjectChain('BETA')).valid).toBe(true);
    // Independence: each project chain starts at genesis, not at the other's tail.
    const alphaFirst = (await repos.ledger.list({ projectId: 'ALPHA' }))[0];
    const betaFirst = (await repos.ledger.list({ projectId: 'BETA' }))[0];
    expect(alphaFirst.prevHash).not.toBe(betaFirst.hash);
    expect(betaFirst.seq).toBe(1);
  });
});

describe('ledger writer — forced seq conflict (stale tail read)', () => {
  it('raises LEDGER_CONFLICT after the bounded retries, writing nothing', async () => {
    const repos = createMemoryRepositories();
    const seeded = await seedChain(repos, 'PROJ', 2);
    const appendSpy = jest.fn();
    const stubbed = staleReadStub(repos, seeded[0], appendSpy);
    const writer = createLedgerWriter(stubbed, { maxRetries: 2 });

    await expect(writer.append('PROJ', { kind: 'decision', target: 'doomed' })).rejects.toThrow(LedgerConflictError);
    await expect(writer.append('PROJ', { kind: 'decision', target: 'doomed' })).rejects.toThrow(/LEDGER_CONFLICT/);

    // Bounded: 3 attempts (maxRetries + 1) per call, and NO broken entry written.
    expect(stubbed.ledger.lastEntry).toHaveBeenCalledTimes(6);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(await seqsOf(repos, 'PROJ')).toEqual([1, 2]);
    expect((await writer.verifyProjectChain('PROJ')).valid).toBe(true);
  });

  it('defaults to 3 retries (4 attempts) before LEDGER_CONFLICT', async () => {
    const repos = createMemoryRepositories();
    const seeded = await seedChain(repos, 'PROJ', 2);
    const appendSpy = jest.fn();
    const stubbed = staleReadStub(repos, seeded[0], appendSpy);
    const writer = createLedgerWriter(stubbed);

    const error = await writer.append('PROJ', { kind: 'decision' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(LedgerConflictError);
    expect((error as LedgerConflictError).code).toBe('LEDGER_CONFLICT');
    expect(stubbed.ledger.lastEntry).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
    expect(appendSpy).not.toHaveBeenCalled();
    expect(verifyChain(await repos.ledger.list({ projectId: 'PROJ' })).valid).toBe(true);
  });
});

describe('ledger writer — real serialisation within one tick', () => {
  it('never duplicates a seq when all promises start in the same tick', async () => {
    const repos = createMemoryRepositories();
    const writer = createLedgerWriter(repos);
    // Same synchronous tick: no await between the calls.
    const bursts = [
      writer.append('TICK', { kind: 'decision', target: 'x-1' }),
      writer.append('TICK', { kind: 'decision', target: 'x-2' }),
      writer.append('TICK', { kind: 'decision', target: 'x-3' }),
      writer.append('TICK', { kind: 'decision', target: 'x-4' }),
      writer.append('TICK', { kind: 'decision', target: 'x-5' }),
    ];
    const written = await Promise.all(bursts);

    const seqs = written.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(5);
    // FIFO single consumer: completions come out strictly ordered.
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    expect((await writer.verifyProjectChain('TICK')).valid).toBe(true);
  });
});
