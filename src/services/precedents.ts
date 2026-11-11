/**
 * Precedents of the approval request card (spec §8.1, PA-17).
 *
 * "Precedents: the similar requests, their outcome, what happened next."
 * A precedent is a past approval request of the same action class on a close
 * target. For each one the service reports the outcome (granted, denied,
 * frozen, expired), who decided it and why, the permit it produced, and the
 * journal entries that came afterwards (declared action, deviation, incident,
 * trust change) on the same target or the same permit.
 *
 * The service is strictly read-only: nothing is written to the journal, and
 * every target leaves the service masked (spec §19 Sobriety).
 */
import { targetCovers } from '../core/glob';
import { maskSecrets } from '../core/mask';
import {
  Approval,
  ApprovalRequest,
  LedgerEntry,
  Permit,
  Repositories,
  RequestStatus,
} from '../core/types';

/** Default number of precedents shown on the card. */
const DEFAULT_LIMIT = 5;

/** Statuses that carry a decided outcome — a precedent worth showing. */
const DECIDED_STATUSES: RequestStatus[] = ['granted', 'denied', 'frozen', 'expired'];

/** Journal kinds describing what happened after a request was decided. */
const FOLLOW_UP_KINDS: LedgerEntry['kind'][] = [
  'action-declared',
  'deviation',
  'correction',
  'trust-change',
  'permit-used',
  'permit-revoked',
  'permit-expired',
];

/** Journal kinds counted as an incident (a gap between promise and facts). */
const INCIDENT_KINDS: LedgerEntry['kind'][] = ['deviation', 'correction'];

/** Proximity ranks — the closest target comes first. */
const SIMILARITY_RANK: Record<Similarity, number> = {
  exact: 0,
  'same-folder': 1,
  'glob-covered': 2,
};

export type PrecedentIssue = 'granted' | 'denied' | 'frozen' | 'expired';

/**
 * Proximity between the target of the current request and the target of a
 * past one, deterministic and ordered: exact equality, then same parent
 * folder, then coverage by a glob pattern.
 */
export type Similarity = 'exact' | 'same-folder' | 'glob-covered';

export interface PrecedentQuery {
  projectId: string;
  actionClass: string;
  target: string;
  issueKey?: string;
}

export interface PrecedentOptions {
  /** Maximum number of precedents returned (default 5). */
  limit?: number;
  /** Only keep the requests created within the last N days. */
  sinceDays?: number;
  /** Request to leave out — the one the card is about. */
  excludeRequestId?: string;
  /** Reference time, injected for deterministic tests. */
  now?: string;
}

export interface PrecedentApprover {
  accountId: string;
  role: string;
  decision: Approval['decision'];
  reason?: string;
  at: string;
}

export interface PrecedentPermit {
  id: string;
  issuedAt: string;
  expiresAt: string;
  ttlMinutes: number;
  usesLeft: number;
}

export interface PrecedentFollowUp {
  seq: number;
  at: string;
  kind: LedgerEntry['kind'];
  target?: string;
  permitId?: string;
  summary: string;
}

export interface Precedent {
  requestId: string;
  issueId: string;
  actionClass: string;
  /** Masked target of the past request. */
  target: string;
  status: RequestStatus;
  issue: PrecedentIssue;
  similarity: Similarity;
  createdAt: string;
  decidedAt?: string;
  /** Minutes between the request and its decision. */
  decisionDelayMinutes?: number;
  denialReason?: string;
  approvers: PrecedentApprover[];
  permit?: PrecedentPermit;
  followUps: PrecedentFollowUp[];
}

export interface PrecedentsSummary {
  /** Number of similar past requests, before the limit is applied. */
  similarRequests: number;
  granted: number;
  /** Share of similar requests that were granted (0 when none). */
  grantRate: number;
  medianDecisionMinutes?: number;
  /** Incidents and deviations that followed the similar requests. */
  laterIncidents: number;
  headline: string;
}

export interface PrecedentsResult {
  query: { projectId: string; actionClass: string; target: string; issueKey?: string };
  precedents: Precedent[];
  summary: PrecedentsSummary;
}

// ------------------------------------------------------------------- matching

/** The parent folder of a target — empty when the target has no folder. */
function parentFolder(target: string): string {
  const index = target.lastIndexOf('/');
  return index > 0 ? target.slice(0, index) : '';
}

/** Proximity of a past target to the target of the current request. */
export function similarityOf(queryTarget: string, candidate: string): Similarity | undefined {
  if (candidate === queryTarget) return 'exact';
  const folder = parentFolder(queryTarget);
  if (folder && folder === parentFolder(candidate)) return 'same-folder';
  if (targetCovers(candidate, queryTarget) || targetCovers(queryTarget, candidate)) return 'glob-covered';
  return undefined;
}

// ------------------------------------------------------------------ discovery

/** Request ids referenced by the journal of the project. */
function requestIdsIn(entries: LedgerEntry[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const id = entry.detail?.requestId;
    if (typeof id === 'string' && id.length > 0) ids.add(id);
  }
  return [...ids];
}

/** Oldest date a request may have been created on, given the window. */
function sinceThreshold(options: PrecedentOptions): string | undefined {
  if (!options.sinceDays || options.sinceDays <= 0) return undefined;
  const now = Date.parse(options.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) return undefined;
  return new Date(now - options.sinceDays * 86_400_000).toISOString();
}

/** Past requests of the same class, in the same project, already decided. */
async function loadCandidates(
  repos: Repositories,
  entries: LedgerEntry[],
  query: PrecedentQuery,
  options: PrecedentOptions,
): Promise<ApprovalRequest[]> {
  const found = await Promise.all(requestIdsIn(entries).map((id) => repos.requests.get(id)));
  const since = sinceThreshold(options);
  return found.filter(
    (request): request is ApprovalRequest =>
      request !== undefined &&
      request.projectId === query.projectId &&
      request.actionClass === query.actionClass &&
      request.id !== options.excludeRequestId &&
      DECIDED_STATUSES.includes(request.status) &&
      (!since || request.createdAt >= since),
  );
}

/** The permit a request produced, if any. */
function permitFor(permits: Permit[], request: ApprovalRequest): Permit | undefined {
  return permits.find((permit) => permit.requestId === request.id);
}

/** Closest first, then most recent, then id — a stable deterministic order. */
function compareCandidates(
  a: { request: ApprovalRequest; similarity: Similarity },
  b: { request: ApprovalRequest; similarity: Similarity },
): number {
  const bySimilarity = SIMILARITY_RANK[a.similarity] - SIMILARITY_RANK[b.similarity];
  if (bySimilarity !== 0) return bySimilarity;
  const byRecency = b.request.createdAt.localeCompare(a.request.createdAt);
  if (byRecency !== 0) return byRecency;
  return a.request.id.localeCompare(b.request.id);
}

// ------------------------------------------------------------------- evidence

/** When the request was decided: last approval, else the journal decision. */
function decisionTime(request: ApprovalRequest, entries: LedgerEntry[]): string | undefined {
  const approvals = (request.approvals ?? []).map((approval) => approval.at).filter(Boolean);
  const lastApproval = approvals.sort().pop();
  if (lastApproval) return lastApproval;
  const journal = entries
    .filter((entry) => entry.detail?.requestId === request.id
      && (entry.decision === 'expired' || entry.decision === 'frozen'))
    .map((entry) => entry.at);
  return journal.sort().pop();
}

/** Minutes between the creation of the request and its decision. */
function delayMinutes(createdAt: string, decidedAt?: string): number | undefined {
  if (!decidedAt) return undefined;
  const delta = Date.parse(decidedAt) - Date.parse(createdAt);
  if (!Number.isFinite(delta)) return undefined;
  return Math.max(0, Math.round(delta / 60_000));
}

/** The reason given by the approver who denied the request. */
function denialReason(request: ApprovalRequest): string | undefined {
  const denial = (request.approvals ?? []).find((approval) => approval.decision === 'deny' && approval.reason);
  return denial?.reason ? maskSecrets(denial.reason) : undefined;
}

/** One approver, with their role and their decision. */
function toApprover(approval: Approval): PrecedentApprover {
  return {
    accountId: approval.approverAccountId,
    role: approval.role,
    decision: approval.decision,
    reason: approval.reason ? maskSecrets(approval.reason) : undefined,
    at: approval.at,
  };
}

/** The permit, with the duration it was granted for and its remaining uses. */
function toPermit(permit: Permit): PrecedentPermit {
  const ttl = (Date.parse(permit.expiresAt) - Date.parse(permit.issuedAt)) / 60_000;
  return {
    id: permit.id,
    issuedAt: permit.issuedAt,
    expiresAt: permit.expiresAt,
    ttlMinutes: Number.isFinite(ttl) ? Math.max(0, Math.round(ttl)) : 0,
    usesLeft: permit.usesLeft,
  };
}

/** True when a journal entry concerns the same target or the same permit. */
function isRelated(
  entry: LedgerEntry,
  request: ApprovalRequest,
  permit: Permit | undefined,
  maskedTarget: string,
): boolean {
  if (permit && entry.permitId === permit.id) return true;
  if (!entry.target) return false;
  if (entry.target === maskedTarget) return true;
  return targetCovers(entry.target, request.target) || targetCovers(request.target, entry.target);
}

/** One journal entry, with a one-line readable summary. */
function toFollowUp(entry: LedgerEntry): PrecedentFollowUp {
  const target = entry.target ? maskSecrets(entry.target) : undefined;
  const where = target ? ` on ${target}` : '';
  const permit = entry.permitId ? ` (permit ${entry.permitId})` : '';
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    target,
    permitId: entry.permitId,
    summary: `${entry.kind}${where}${permit}`,
  };
}

/** What happened after the request was decided, on the same target or permit. */
function collectFollowUps(
  request: ApprovalRequest,
  permit: Permit | undefined,
  entries: LedgerEntry[],
  decidedAt: string | undefined,
): PrecedentFollowUp[] {
  const after = decidedAt ?? request.createdAt;
  const maskedTarget = maskSecrets(request.target);
  return entries
    .filter((entry) => entry.at > after && FOLLOW_UP_KINDS.includes(entry.kind))
    .filter((entry) => isRelated(entry, request, permit, maskedTarget))
    .map((entry) => toFollowUp(entry));
}

/** Build the view of one past request. */
function buildPrecedent(
  request: ApprovalRequest,
  similarity: Similarity,
  permit: Permit | undefined,
  entries: LedgerEntry[],
): Precedent {
  const decidedAt = decisionTime(request, entries);
  return {
    requestId: request.id,
    issueId: request.issueId,
    actionClass: request.actionClass,
    target: maskSecrets(request.target),
    status: request.status,
    issue: request.status as PrecedentIssue,
    similarity,
    createdAt: request.createdAt,
    decidedAt,
    decisionDelayMinutes: delayMinutes(request.createdAt, decidedAt),
    denialReason: denialReason(request),
    approvers: (request.approvals ?? []).map((approval) => toApprover(approval)),
    permit: permit ? toPermit(permit) : undefined,
    followUps: collectFollowUps(request, permit, entries, decidedAt),
  };
}

// -------------------------------------------------------------------- summary

/** True when a follow-up entry counts as an incident. */
function isIncident(followUp: PrecedentFollowUp): boolean {
  return INCIDENT_KINDS.includes(followUp.kind);
}

/** Median of the decision delays, in minutes. */
function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** The one-line sentence shown on the card. */
function headline(similar: number, granted: number, incidents: number): string {
  if (incidents > 0) {
    return `${incidents} incident${incidents > 1 ? 's' : ''} followed similar requests`;
  }
  if (granted > 0) {
    return `resembles ${granted} previously granted request${granted > 1 ? 's' : ''} with no incident`;
  }
  if (similar > 0) return 'similar requests were denied or never decided';
  return 'no similar request found';
}

/** Aggregate of the similar requests. */
function buildSummary(precedents: Precedent[]): PrecedentsSummary {
  const granted = precedents.filter((precedent) => precedent.issue === 'granted').length;
  const incidents = precedents.reduce(
    (total, precedent) => total + precedent.followUps.filter(isIncident).length,
    0,
  );
  const delays = precedents
    .map((precedent) => precedent.decisionDelayMinutes)
    .filter((value): value is number => typeof value === 'number');
  return {
    similarRequests: precedents.length,
    granted,
    grantRate: precedents.length === 0 ? 0 : Math.round((granted / precedents.length) * 100) / 100,
    medianDecisionMinutes: median(delays),
    laterIncidents: incidents,
    headline: headline(precedents.length, granted, incidents),
  };
}

// --------------------------------------------------------------------- service

/**
 * Find the past requests similar to the one being decided.
 *
 * Read-only: the journal is read, never written.
 */
export async function findPrecedents(
  repos: Repositories,
  query: PrecedentQuery,
  options: PrecedentOptions = {},
): Promise<PrecedentsResult> {
  const entries = await repos.ledger.list({ projectId: query.projectId });
  const candidates = await loadCandidates(repos, entries, query, options);
  const permits = await repos.permits.listPermits({ projectId: query.projectId });
  const matched = candidates
    .map((request) => ({ request, similarity: similarityOf(query.target, request.target) }))
    .filter((item): item is { request: ApprovalRequest; similarity: Similarity } =>
      item.similarity !== undefined)
    .sort(compareCandidates);
  const precedents = matched.map((item) =>
    buildPrecedent(item.request, item.similarity, permitFor(permits, item.request), entries));
  const limit = Math.max(0, options.limit ?? DEFAULT_LIMIT);
  return {
    query: {
      projectId: query.projectId,
      actionClass: query.actionClass,
      target: maskSecrets(query.target),
      issueKey: query.issueKey,
    },
    precedents: precedents.slice(0, limit),
    summary: buildSummary(precedents),
  };
}

// --------------------------------------------------------------------- screen

/** Read a non-empty string out of an untyped payload. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Read a positive number out of an untyped payload. */
function readPositiveNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Payload of the `getPrecedents` Forge definition.
 *
 * The Forge context parsing mirrors the other screens of the app: the project
 * comes from the payload or the context, the issue from the context first.
 */
export async function getPrecedentsScreen(
  repos: Repositories,
  payload: any,
  context: any,
): Promise<PrecedentsResult | { error: string }> {
  const issueKey = readString(context?.extension?.issue?.key) ?? readString(payload?.issueKey);
  const projectId = readString(payload?.projectId)
    ?? readString(payload?.projectKey)
    ?? readString(context?.extension?.project?.key)
    ?? (issueKey && issueKey.includes('-') ? issueKey.split('-')[0] : 'unknown');
  const actionClass = readString(payload?.actionClass);
  const target = readString(payload?.target);
  if (!actionClass || !target) return { error: 'MISSING_QUERY' };
  return findPrecedents(
    repos,
    { projectId, actionClass, target, issueKey },
    {
      limit: readPositiveNumber(payload?.limit),
      sinceDays: readPositiveNumber(payload?.sinceDays),
      excludeRequestId: readString(payload?.requestId),
    },
  );
}
