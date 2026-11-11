/**
 * Drift detection (spec §10, enforcement point 4 — "détection après coup").
 *
 * A tool that is merely consulted stops nobody: an agent that never asks still
 * acts. This service compares what actually changed with what was declared, and
 * reports the gaps. Each gap costs trust capital and is written to the chained
 * ledger, so the trace survives even when the agent stays silent.
 *
 * Nothing here invents a classification: changes go through the same
 * `classifyAction` the decision pipeline uses, and targets go through the same
 * glob matcher, so `./db/x.sql` and `db/x.sql` are the same target.
 */
import { classifyAction } from '../core/classify';
import { defaultLevelFor, isReadClass } from '../core/catalog';
import { targetCovers } from '../core/glob';
import { makeEntry } from '../core/ledger';
import { maskSecrets } from '../core/mask';
import { applyTrustEvent, initialTrustState } from '../core/trust';
import { LedgerEntry, PlanAction, Repositories, TrustEventKind } from '../core/types';

/** One change observed in the wild: a path, a command, or both. */
export interface ObservedChange {
  path?: string;
  command?: string;
  /** Where the change was seen: 'ci-diff', 'git-log', 'file-watch'… */
  source?: string;
}

export type DriftKind = 'undeclared' | 'out-of-plan';

export interface DriftItem {
  kind: DriftKind;
  actionClass: string;
  target: string;
  reason?: string;
  source?: string;
}

export interface DriftInput {
  projectId: string;
  issueKey?: string;
  profileId: string;
  pilotAccountId?: string;
  changes: ObservedChange[];
  /** Ledger entries of kind 'action-declared' for this ticket/profile. */
  declared: LedgerEntry[];
  /** Actions of the approved plan, when the ticket went through submit-plan. */
  planActions?: PlanAction[];
  at?: string;
}

export interface DriftReport {
  items: DriftItem[];
  checked: number;
  sensitive: number;
}

/** Normalise a path so equivalent spellings compare equal. */
export function normalizeTarget(target: string): string {
  return target.startsWith('./') ? target.slice(2) : target;
}

/** A class is sensitive when its default level is stricter than N5. */
export function isSensitiveClass(actionClass: string): boolean {
  return !isReadClass(actionClass) && defaultLevelFor(actionClass) <= 4;
}

/** Compare observed changes with declarations and the approved plan. */
export async function detectDrift(input: DriftInput): Promise<DriftReport> {
  const items: DriftItem[] = [];
  let sensitive = 0;
  for (const change of input.changes) {
    const target = change.path ?? change.command ?? '';
    if (target.length === 0) continue;
    const classification = await classifyAction({
      target,
      command: change.command,
      issueKey: input.issueKey,
      projectId: input.projectId,
    });
    if (!isSensitiveClass(classification.actionClass)) continue;
    sensitive++;
    const item = classifyGap(target, classification.actionClass, change, input);
    if (item) items.push(item);
  }
  return { items, checked: input.changes.length, sensitive };
}

/** Decide whether one sensitive change is declared, planned, or a gap. */
function classifyGap(
  target: string,
  actionClass: string,
  change: ObservedChange,
  input: DriftInput,
): DriftItem | undefined {
  const declared = input.declared.some(
    (entry) =>
      entry.actionClass === actionClass &&
      targetCovers(normalizeTarget(entry.target ?? ''), normalizeTarget(target)),
  );
  if (!declared) {
    return {
      kind: 'undeclared',
      actionClass,
      target,
      reason: classificationReason(actionClass, target),
      source: change.source,
    };
  }
  const planned = (input.planActions ?? []).some(
    (action) =>
      (action.actionClass === undefined || action.actionClass === actionClass) &&
      targetCovers(normalizeTarget(action.target), normalizeTarget(target)),
  );
  if (input.planActions && input.planActions.length > 0 && !planned) {
    return {
      kind: 'out-of-plan',
      actionClass,
      target,
      reason: 'declared but absent from the approved plan',
      source: change.source,
    };
  }
  return undefined;
}

function classificationReason(actionClass: string, target: string): string {
  return `${target} is class ${actionClass} (default N${defaultLevelFor(actionClass)}) and was never declared`;
}

export interface ApplyDriftOptions {
  issueKey?: string;
  profileId: string;
  pilotAccountId?: string;
  at?: string;
}

export interface ApplyDriftResult {
  penalized: number;
  skipped: number;
  trustScore?: number;
  entries: number;
}

/**
 * Penalise and journal each gap. Idempotent: a gap already written for the same
 * target, kind and ticket is not penalised twice — a CI run repeated on the same
 * commit must not drain the trust capital.
 */
export async function applyDrift(
  repos: Repositories,
  projectId: string,
  report: DriftReport,
  options: ApplyDriftOptions,
): Promise<ApplyDriftResult> {
  const at = options.at ?? new Date().toISOString();
  const existing = await repos.ledger.list({ projectId, issueId: options.issueKey, kind: 'deviation' });
  let penalized = 0;
  let skipped = 0;
  let entries = 0;
  let score: number | undefined;
  for (const item of report.items) {
    if (alreadyJournalized(existing, item, options.issueKey)) {
      skipped++;
      continue;
    }
    score = await penalize(repos, projectId, item, options, at);
    penalized++;
    entries += 2;
  }
  return { penalized, skipped, trustScore: score, entries };
}

function alreadyJournalized(
  existing: LedgerEntry[],
  item: DriftItem,
  issueKey: string | undefined,
): boolean {
  const target = normalizeTarget(maskSecrets(item.target));
  return existing.some(
    (entry) =>
      entry.detail?.driftKind === item.kind &&
      normalizeTarget(entry.target ?? '') === target &&
      (issueKey === undefined || entry.issueId === issueKey),
  );
}

/** One gap: trust penalty, then two chained ledger entries. */
async function penalize(
  repos: Repositories,
  projectId: string,
  item: DriftItem,
  options: ApplyDriftOptions,
  at: string,
): Promise<number> {
  const kind: TrustEventKind = item.kind === 'undeclared' ? 'undeclared-action' : 'out-of-plan';
  const previous = (await repos.trust.getState(options.profileId)) ?? initialTrustState(options.profileId);
  const state = applyTrustEvent(previous, kind, at);
  await repos.trust.saveState(state);
  await repos.trust.recordEvent({
    profileId: options.profileId,
    kind,
    delta: state.score - previous.score,
    reason: item.reason,
    at,
  });
  const target = maskSecrets(item.target);
  const deviation = await appendEntry(repos, projectId, {
    kind: 'deviation',
    projectId,
    issueId: options.issueKey,
    profileId: options.profileId,
    pilotAccountId: options.pilotAccountId,
    actionClass: item.actionClass,
    target,
    decision: item.kind,
    detail: { driftKind: item.kind, reason: item.reason, source: item.source },
    at,
  });
  await appendEntry(repos, projectId, {
    kind: 'trust-change',
    projectId,
    issueId: options.issueKey,
    profileId: options.profileId,
    pilotAccountId: options.pilotAccountId,
    actionClass: item.actionClass,
    target,
    decision: kind,
    detail: { from: previous.score, to: state.score, driftSeq: deviation.seq },
    at,
  });
  return state.score;
}

async function appendEntry(
  repos: Repositories,
  projectId: string,
  input: Parameters<typeof makeEntry>[0],
): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(projectId);
  const entry = makeEntry(input, prev);
  await repos.ledger.append(entry);
  return entry;
}
