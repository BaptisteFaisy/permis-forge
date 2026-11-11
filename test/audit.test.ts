/**
 * Unit tests for src/ui/audit.ts — chain verification, CSV / Confluence export
 * and the 30-day observe-mode summary. Fully offline and deterministic.
 */
import {
  exportLedgerToConfluenceStorage,
  exportLedgerToCsv,
  summarize30DayObservation,
  verifyLedgerIntegrity,
} from '../src/ui/audit';
import { ChainVerification, LedgerEntry } from '../src/core/types';

const NOW_MS = Date.parse('2026-11-11T12:00:00.000Z');

/** Minimal RFC 4180 row parser so quoted commas do not shift the columns. */
function splitCsvRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < row.length; i++) {
    const char = row[i];
    if (quoted) {
      if (char === '"' && row[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function entry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    seq: 1,
    at: '2026-11-10T08:00:00.000Z',
    kind: 'decision',
    projectId: 'PROJ',
    issueId: 'PROJ-1',
    profileId: 'agent-a',
    pilotAccountId: 'pilot-1',
    actionClass: 'A-08',
    target: 'db/migrations/001_init.sql',
    ruleId: 'rule-1',
    decision: 'ask',
    permitId: 'PA-2026-000001',
    detail: { level: 2, observeOnly: true },
    prevHash: 'prev-hash',
    hash: 'hash-1',
    ...overrides,
  };
}

describe('verifyLedgerIntegrity', () => {
  it('reports a valid chain with the number of entries verified', () => {
    const entries = [entry(), entry({ seq: 2, hash: 'hash-2' })];
    const verifyChain = (list: LedgerEntry[]): ChainVerification => ({
      valid: true,
      checked: list.length,
    });

    const result = verifyLedgerIntegrity(entries, verifyChain);

    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.firstBreak).toBeUndefined();
    expect(result.summary).toBe('Chain valid: 2 entries verified');
  });

  it('reports a broken chain with the sequence and both hashes', () => {
    const entries = [entry(), entry({ seq: 2, hash: 'hash-2' })];
    const verifyChain = (): ChainVerification => ({
      valid: false,
      checked: 2,
      firstBreak: { seq: 2, expectedHash: 'hash-2', actualHash: 'tampered' },
    });

    const result = verifyLedgerIntegrity(entries, verifyChain);

    expect(result.valid).toBe(false);
    expect(result.summary).toBe('Chain broken at seq 2: expected hash-2 actual tampered');
    expect(result.firstBreak?.seq).toBe(2);
  });

  it('passes the entries through to the injected verification function', () => {
    const entries = [entry()];
    const verifyChain = jest.fn(() => ({ valid: true, checked: 1 }));

    verifyLedgerIntegrity(entries, verifyChain);

    expect(verifyChain).toHaveBeenCalledWith(entries);
  });
});

describe('exportLedgerToCsv', () => {
  it('writes the expected header row', () => {
    const csv = exportLedgerToCsv([]);

    expect(csv.split('\n')).toEqual([
      'seq,at,kind,projectId,issueId,profileId,pilotAccountId,actionClass,target,ruleId,decision,permitId,prevHash,hash',
    ]);
  });

  it('writes one row per entry with the columns in order', () => {
    const csv = exportLedgerToCsv([entry()]);

    expect(csv.split('\n')).toHaveLength(2);
    expect(csv.split('\n')[1]).toBe(
      '1,2026-11-10T08:00:00.000Z,decision,PROJ,PROJ-1,agent-a,pilot-1,A-08,' +
        'db/migrations/001_init.sql,rule-1,ask,PA-2026-000001,prev-hash,hash-1',
    );
  });

  it('quotes fields containing a comma and doubles embedded quotes', () => {
    const csv = exportLedgerToCsv([
      entry({ target: 'src/a,b.ts', decision: 'say "no"', ruleId: undefined }),
    ]);

    const row = csv.split('\n')[1];
    expect(row).toContain('"src/a,b.ts"');
    expect(row).toContain('"say ""no"""');
    const cells = splitCsvRow(row);
    expect(cells[8]).toBe('src/a,b.ts');
    expect(cells[9]).toBe('');
    expect(cells[10]).toBe('say "no"');
  });

  it('quotes fields containing a newline', () => {
    const csv = exportLedgerToCsv([entry({ target: 'line1\nline2' })]);

    expect(csv).toContain('"line1\nline2"');
  });

  it('leaves plain fields unquoted and renders missing values as empty', () => {
    const csv = exportLedgerToCsv([entry({ issueId: undefined, permitId: undefined })]);

    const cells = csv.split('\n')[1].split(',');
    expect(cells[4]).toBe('');
    expect(cells[11]).toBe('');
    expect(cells[0]).toBe('1');
  });
});

describe('exportLedgerToConfluenceStorage', () => {
  it('produces a table with a header row of th cells', () => {
    const xhtml = exportLedgerToConfluenceStorage([]);

    expect(xhtml.startsWith('<table><tr>')).toBe(true);
    expect(xhtml.endsWith('</tr></table>')).toBe(true);
    expect(xhtml).toContain('<th>Seq</th>');
    expect(xhtml).toContain('<th>Class</th>');
    expect(xhtml).toContain('<th>Hash</th>');
  });

  it('renders each entry as a tr with td cells', () => {
    const xhtml = exportLedgerToConfluenceStorage([entry(), entry({ seq: 2 })]);

    const rows = xhtml.match(/<tr>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(xhtml).toContain('<td>decision</td>');
    expect(xhtml).toContain('<td>2</td>');
  });

  it('escapes XML special characters', () => {
    const xhtml = exportLedgerToConfluenceStorage([
      entry({ target: 'a < b & c > "d"', actionClass: undefined }),
    ]);

    expect(xhtml).toContain('<td>a &lt; b &amp; c &gt; &quot;d&quot;</td>');
    expect(xhtml).not.toContain('a < b');
  });
});

describe('summarize30DayObservation', () => {
  it('counts observe-mode decisions of the last 30 days and those that would block', () => {
    const entries = [
      entry({ seq: 1, at: '2026-11-01T10:00:00.000Z', detail: { level: 2, observeOnly: true } }),
      entry({ seq: 2, at: '2026-10-20T10:00:00.000Z', detail: { level: 0, observeOnly: true } }),
      entry({ seq: 3, at: '2026-11-05T10:00:00.000Z', detail: { level: 5, observeOnly: true } }),
      entry({ seq: 4, at: '2026-11-06T10:00:00.000Z', detail: { level: 1, observeOnly: true } }),
    ];

    const summary = summarize30DayObservation(entries, NOW_MS);

    expect(summary.totalObserved).toBe(4);
    expect(summary.wouldHaveBlocked).toBe(3);
    expect(summary.byClass['A-08']).toBe(4);
  });

  it('ignores enforcing decisions, non-decision entries and entries older than 30 days', () => {
    const entries = [
      entry({ seq: 1, at: '2026-11-01T10:00:00.000Z', detail: { level: 2, observeOnly: true } }),
      entry({ seq: 2, at: '2026-11-01T10:00:00.000Z', detail: { level: 2, observeOnly: false } }),
      entry({ seq: 3, at: '2026-11-01T10:00:00.000Z', detail: { level: 0, observeOnly: true }, kind: 'permit-used' }),
      entry({ seq: 4, at: '2026-09-01T10:00:00.000Z', detail: { level: 0, observeOnly: true } }),
      entry({ seq: 5, at: '2026-11-02T10:00:00.000Z', detail: {} }),
    ];

    const summary = summarize30DayObservation(entries, NOW_MS);

    expect(summary.totalObserved).toBe(1);
    expect(summary.wouldHaveBlocked).toBe(1);
  });

  it('groups by action class and ranks the most frequent targets', () => {
    const entries = [
      entry({ seq: 1, at: '2026-11-01T10:00:00.000Z', actionClass: 'A-08', target: 'db/mig1.sql', detail: { level: 2, observeOnly: true } }),
      entry({ seq: 2, at: '2026-11-02T10:00:00.000Z', actionClass: 'A-08', target: 'db/mig1.sql', detail: { level: 2, observeOnly: true } }),
      entry({ seq: 3, at: '2026-11-03T10:00:00.000Z', actionClass: 'A-13', target: 'api/deploy.sh', detail: { level: 1, observeOnly: true } }),
      entry({ seq: 4, at: '2026-11-04T10:00:00.000Z', actionClass: undefined, target: undefined, detail: { level: 5, observeOnly: true } }),
    ];

    const summary = summarize30DayObservation(entries, NOW_MS);

    expect(summary.byClass).toEqual({ 'A-08': 2, 'A-13': 1, unknown: 1 });
    expect(summary.topTargets).toEqual([
      { target: 'db/mig1.sql', count: 2 },
      { target: 'api/deploy.sh', count: 1 },
    ]);
  });

  it('returns an empty summary for an empty journal', () => {
    const summary = summarize30DayObservation([], NOW_MS);

    expect(summary).toEqual({ totalObserved: 0, wouldHaveBlocked: 0, byClass: {}, topTargets: [] });
  });

  it('keeps at most ten top targets, highest count first', () => {
    const entries = Array.from({ length: 14 }, (_, index) =>
      entry({
        seq: index + 1,
        at: '2026-11-01T10:00:00.000Z',
        target: `target-${index}`,
        detail: { level: 2, observeOnly: true },
      }),
    );

    const summary = summarize30DayObservation(entries, NOW_MS);

    expect(summary.topTargets).toHaveLength(10);
    expect(summary.totalObserved).toBe(14);
  });
});
