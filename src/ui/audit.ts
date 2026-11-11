/**
 * Audit verification, export, and 30-day observation summary (spec §7.4, §11, §13, §15).
 *
 * Provides pure functions for verifying ledger hash-chain integrity, exporting
 * ledger entries to RFC 4180 CSV and Confluence XHTML storage format, and
 * summarizing observe-mode decisions over the last 30 days (PA-13).
 */
import { ChainVerification, LedgerEntry } from '../core/types';

const CSV_COLUMNS = [
  'seq',
  'at',
  'kind',
  'projectId',
  'issueId',
  'profileId',
  'pilotAccountId',
  'actionClass',
  'target',
  'ruleId',
  'decision',
  'permitId',
  'prevHash',
  'hash',
] as const;

const CONFLUENCE_HEADERS = [
  'Seq',
  'At',
  'Kind',
  'Project',
  'Issue',
  'Profile',
  'Pilot',
  'Class',
  'Target',
  'Rule',
  'Decision',
  'Permit',
  'Prev Hash',
  'Hash',
] as const;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const TOP_TARGETS_LIMIT = 10;

export interface ObservationSummary {
  totalObserved: number;
  wouldHaveBlocked: number;
  byClass: Record<string, number>;
  topTargets: { target: string; count: number }[];
}

/** Verify hash-chain integrity of ledger entries and attach a readable summary. */
export function verifyLedgerIntegrity(
  entries: LedgerEntry[],
  verifyChainFn: (entries: LedgerEntry[]) => ChainVerification,
): ChainVerification & { summary: string } {
  const result = verifyChainFn(entries);
  if (result.valid) {
    return {
      ...result,
      summary: `Chain valid: ${result.checked} entries verified`,
    };
  }
  const brk = result.firstBreak;
  const summary = brk
    ? `Chain broken at seq ${brk.seq}: expected ${brk.expectedHash} actual ${brk.actualHash}`
    : `Chain broken: ${result.checked} entries checked`;
  return { ...result, summary };
}

/** Escape a single cell value according to RFC 4180 CSV rules. */
function escapeCsvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** Map a ledger entry to an ordered row of raw field values. */
function entryRowValues(entry: LedgerEntry): unknown[] {
  return CSV_COLUMNS.map((col) => entry[col]);
}

/** Export ledger entries to RFC 4180 CSV format. */
export function exportLedgerToCsv(entries: LedgerEntry[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = entries.map((entry) =>
    entryRowValues(entry).map(escapeCsvCell).join(','),
  );
  return [header, ...rows].join('\n');
}

/** Escape XML/XHTML special characters for Confluence storage format. */
function escapeXml(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Export ledger entries as an XHTML table in Atlassian Confluence storage format. */
export function exportLedgerToConfluenceStorage(entries: LedgerEntry[]): string {
  const headerCells = CONFLUENCE_HEADERS.map((h) => `<th>${escapeXml(h)}</th>`).join('');
  const bodyRows = entries
    .map((entry) => {
      const cells = entryRowValues(entry)
        .map((val) => `<td>${escapeXml(val)}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return `<table><tr>${headerCells}</tr>${bodyRows}</table>`;
}

/** Increment a string counter map in place. */
function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/** Summarize observe-only decision entries over the last 30 days (spec §7.4, PA-13). */
export function summarize30DayObservation(
  entries: LedgerEntry[],
  nowMs: number = Date.now(),
): ObservationSummary {
  const cutoffMs = nowMs - THIRTY_DAYS_MS;
  const byClass: Record<string, number> = {};
  const targetCounts: Record<string, number> = {};
  let totalObserved = 0;
  let wouldHaveBlocked = 0;

  for (const entry of entries) {
    if (entry.kind !== 'decision' || entry.detail?.observeOnly !== true) continue;
    const timestamp = Date.parse(entry.at);
    if (!Number.isFinite(timestamp) || timestamp < cutoffMs) continue;

    totalObserved += 1;
    const level = entry.detail?.level;
    if (typeof level === 'number' && level < 4) {
      wouldHaveBlocked += 1;
    }
    incrementCount(byClass, entry.actionClass ?? 'unknown');
    if (entry.target) {
      incrementCount(targetCounts, entry.target);
    }
  }

  const topTargets = Object.entries(targetCounts)
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
    .slice(0, TOP_TARGETS_LIMIT);

  return { totalObserved, wouldHaveBlocked, byClass, topTargets };
}
