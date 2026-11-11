/**
 * Per-project serialised ledger writer (spec §18, "Chaînage d'empreintes sous
 * écritures concurrentes": the sequence number is attributed by a queue with a
 * single consumer).
 *
 * HONEST SCOPE: the queue below is an in-memory promise chain. It serialises
 * concurrent appends within ONE process instance only. In a multi-instance
 * production deployment (several Forge servers sharing one database) it does
 * NOT prevent two instances from attributing the same seq: that would require
 * a storage-level lock (SELECT ... FOR UPDATE / unique constraint on
 * (projectId, seq)) or an Atlassian-hosted queue. What this module guarantees
 * single-instance, and verifies defensively in both cases, is:
 *   - one consumer at a time per project (promise chain, FIFO);
 *   - bounded optimistic retry when a seq conflict is detected before write;
 *   - an explicit LEDGER_CONFLICT error instead of writing a broken chain.
 */
import { makeEntry, verifyChain } from '../core/ledger';
import type {
  ChainVerification,
  LedgerEntry,
  LedgerEntryInput,
  LedgerRepository,
  Repositories,
} from '../core/types';

/** Raised when a seq conflict survives the bounded optimistic retries. */
export class LedgerConflictError extends Error {
  readonly code = 'LEDGER_CONFLICT';
  constructor(projectId: string, attempts: number) {
    super(
      `LEDGER_CONFLICT: project ${projectId} still has a seq conflict after ${attempts} attempt(s); ` +
        'refusing to write a broken chain',
    );
    this.name = 'LedgerConflictError';
  }
}

export interface LedgerWriterOptions {
  /** Optimistic retries on seq conflict before LEDGER_CONFLICT (default 3). */
  maxRetries?: number;
}

/** Input of append(): a ledger entry without its projectId (given apart). */
export type LedgerWriterInput = Omit<LedgerEntryInput, 'projectId'>;

export interface LedgerWriter {
  append(projectId: string, input: LedgerWriterInput): Promise<LedgerEntry>;
  verifyProjectChain(projectId: string): Promise<ChainVerification>;
}

export const DEFAULT_MAX_RETRIES = 3;

/** Entries of a project sorted by seq (list order is storage-dependent). */
async function sortedEntries(ledger: LedgerRepository, projectId: string): Promise<LedgerEntry[]> {
  const entries = await ledger.list({ projectId });
  return [...entries].sort((a, b) => a.seq - b.seq);
}

/**
 * Pre-write conflict guard: the planned seq must be free and the entry we
 * chained onto must still be the tail. Detects the conflict BEFORE writing,
 * so a failed append never leaves a broken entry in the journal.
 */
async function hasSeqConflict(ledger: LedgerRepository, planned: LedgerEntry): Promise<boolean> {
  const entries = await sortedEntries(ledger, planned.projectId);
  if (entries.some((entry) => entry.seq === planned.seq)) return true;
  const tail = entries.length > 0 ? entries[entries.length - 1] : undefined;
  if (!tail) return false;
  return tail.seq !== planned.seq - 1 || tail.hash !== planned.prevHash;
}

/** One optimistic attempt: read tail, chain, guard, write. Null on conflict. */
async function appendOnce(
  ledger: LedgerRepository,
  projectId: string,
  input: LedgerWriterInput,
): Promise<LedgerEntry | null> {
  const prev = await ledger.lastEntry(projectId);
  const entry = makeEntry({ ...input, projectId }, prev);
  if (await hasSeqConflict(ledger, entry)) return null;
  await ledger.append(entry);
  return entry;
}

/** Bounded retry loop; raises LEDGER_CONFLICT instead of corrupting the chain. */
async function appendWithRetry(
  ledger: LedgerRepository,
  projectId: string,
  input: LedgerWriterInput,
  maxRetries: number,
): Promise<LedgerEntry> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const entry = await appendOnce(ledger, projectId, input);
    if (entry !== null) return entry;
  }
  throw new LedgerConflictError(projectId, maxRetries + 1);
}

/**
 * Writer serialised per project through an in-memory promise chain: each
 * append waits for the previous one of the SAME project, so there is a single
 * consumer per chain. A rejection never poisons the queue for the next task.
 */
function createProjectQueue(): <T>(projectId: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return function enqueue<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = tails.get(projectId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(projectId, settled);
    void settled.then(() => {
      if (tails.get(projectId) === settled) tails.delete(projectId);
    });
    return run;
  };
}

/** Build a LedgerWriter on top of any Repositories implementation. */
export function createLedgerWriter(repos: Repositories, opts?: LedgerWriterOptions): LedgerWriter {
  const maxRetries = opts?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const enqueue = createProjectQueue();
  return {
    append(projectId: string, input: LedgerWriterInput): Promise<LedgerEntry> {
      return enqueue(projectId, () => appendWithRetry(repos.ledger, projectId, input, maxRetries));
    },
    async verifyProjectChain(projectId: string): Promise<ChainVerification> {
      return verifyChain(await sortedEntries(repos.ledger, projectId));
    },
  };
}
