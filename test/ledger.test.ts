/**
 * Unit tests for src/core/ledger.ts — chained journal integrity (spec §11).
 */
import { GENESIS_HASH, canonicalJson, entryHash, makeCorrection, makeEntry, verifyChain } from '../src/core/ledger';
import { LedgerEntry } from '../src/core/types';

function chain(count: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  let prev: LedgerEntry | undefined;
  for (let index = 0; index < count; index++) {
    const entry = makeEntry(
      {
        kind: 'decision',
        projectId: 'PROJ',
        issueId: 'PROJ-1',
        target: `file-${index}.ts`,
        at: `2026-11-10T08:0${index}:00.000Z`,
      },
      prev,
    );
    entries.push(entry);
    prev = entry;
  }
  return entries;
}

describe('canonicalJson', () => {
  it('sorts object keys so the hash is stable', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('drops undefined values and keeps array order', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});

describe('makeEntry', () => {
  it('starts the chain at seq 1 with the genesis hash', () => {
    const entry = makeEntry({ kind: 'decision', projectId: 'PROJ' });
    expect(entry.seq).toBe(1);
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(entry.hash).toHaveLength(64);
  });

  it('links each entry to the previous hash and increments seq', () => {
    const entries = chain(3);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(entries[1].prevHash).toBe(entries[0].hash);
    expect(entries[2].prevHash).toBe(entries[1].hash);
  });

  it('honours an explicit timestamp', () => {
    const entry = makeEntry({ kind: 'decision', projectId: 'PROJ', at: '2026-01-01T00:00:00.000Z' });
    expect(entry.at).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('verifyChain', () => {
  it('accepts an intact chain', () => {
    const result = verifyChain(chain(5));
    expect(result).toEqual({ valid: true, checked: 5 });
  });

  it('detects a rewritten entry and points at it', () => {
    const entries = chain(4);
    entries[2] = { ...entries[2], target: 'tampered.ts' };
    const result = verifyChain(entries);
    expect(result.valid).toBe(false);
    expect(result.firstBreak?.seq).toBe(3);
    expect(result.checked).toBe(2);
  });

  it('detects a deleted entry through the broken link', () => {
    const entries = chain(4);
    const withGap = [entries[0], entries[1], entries[3]];
    const result = verifyChain(withGap);
    expect(result.valid).toBe(false);
    expect(result.firstBreak?.seq).toBe(4);
  });

  it('flags a first entry that does not start from genesis', () => {
    const entry = { ...makeEntry({ kind: 'decision', projectId: 'PROJ' }), prevHash: 'deadbeef' };
    const result = verifyChain([entry]);
    expect(result.valid).toBe(false);
    expect(result.firstBreak?.seq).toBe(1);
  });

  it('accepts a first entry that starts from genesis', () => {
    const entry = makeEntry({ kind: 'decision', projectId: 'PROJ' });
    expect(entry.prevHash).toBe(GENESIS_HASH);
    expect(verifyChain([entry]).valid).toBe(true);
  });

  it('accepts an empty journal', () => {
    expect(verifyChain([])).toEqual({ valid: true, checked: 0 });
  });
});

describe('entryHash', () => {
  it('is reproducible for the same entry', () => {
    const entry = makeEntry({ kind: 'decision', projectId: 'PROJ', at: '2026-11-10T08:00:00.000Z' });
    const { hash: _hash, ...rest } = entry;
    expect(entryHash(rest)).toBe(entry.hash);
  });
});

describe('makeCorrection', () => {
  it('appends a new entry pointing at the corrected one', () => {
    const entries = chain(2);
    const correction = makeCorrection(
      { kind: 'decision', projectId: 'PROJ', detail: { note: 'target was wrong' } },
      entries[1].seq,
      entries[1],
    );
    expect(correction.kind).toBe('correction');
    expect(correction.correctsSeq).toBe(2);
    expect(correction.seq).toBe(3);
    expect(verifyChain([...entries, correction]).valid).toBe(true);
  });
});
