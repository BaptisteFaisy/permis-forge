/**
 * Approval SLA and escalation (spec §8.2, and the roadmap risk "too many
 * interruptions, therefore workarounds").
 *
 * A request nobody answers is worse than a refusal: the pilot waits, then
 * routes around the policy. So a pending request has a deadline, and the
 * nightly sweep acts on it — a reminder on the ticket, an escalation to the
 * project administrators, then an expiry that returns the agent to a known
 * state instead of an indefinite wait.
 *
 * The transport is injected, exactly like notify.ts: the ageing logic is pure
 * and tested offline, and a delivery failure never blocks a state change.
 */
import { makeEntry } from '../core/ledger';
import { ApprovalRequest, LedgerEntry, Repositories } from '../core/types';
import { AdfNode, bullet, bulletList, doc, paragraph, text } from './adf';
import { CommentPoster, defaultPoster } from './notify';

export type SlaState = 'on-time' | 'due' | 'late' | 'stale';

export interface SlaPolicy {
  /** Minutes before the approvers are reminded on the ticket. */
  remindAfterMinutes: number;
  /** Minutes before the request is escalated to the project administrators. */
  escalateAfterMinutes: number;
  /** Minutes before the request expires: an open-ended wait helps nobody. */
  expireAfterMinutes: number;
}

/**
 * Defaults are deliberately loose: four hours before a reminder, twelve before
 * an escalation, seven days before an expiry. A policy that nags is a policy
 * people mute.
 */
export const DEFAULT_SLA: SlaPolicy = {
  remindAfterMinutes: 4 * 60,
  escalateAfterMinutes: 12 * 60,
  expireAfterMinutes: 7 * 24 * 60,
};

/** How long a request has been waiting, in minutes; never negative. */
export function ageMinutes(request: ApprovalRequest, now: string): number {
  const created = Date.parse(request.createdAt);
  const current = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor((current - created) / 60_000));
}

/** Where a pending request stands against the SLA. */
export function slaState(
  request: ApprovalRequest,
  now: string,
  policy: SlaPolicy = DEFAULT_SLA,
): SlaState {
  const age = ageMinutes(request, now);
  if (age >= policy.expireAfterMinutes) return 'stale';
  if (age >= policy.escalateAfterMinutes) return 'late';
  if (age >= policy.remindAfterMinutes) return 'due';
  return 'on-time';
}

/** Human duration, because "847 minutes" is not a deadline anybody feels. */
export function formatAge(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** The three SLA actions, journalled so a reminder is never sent twice. */
export type SlaAction = 'reminder' | 'escalation' | 'expired';

/** Build the ticket comment for one SLA action (no network, no side effect). */
export function buildSlaNotice(
  request: ApprovalRequest,
  action: SlaAction,
  age: number,
): { title: string; body: AdfNode } {
  const roles = (request.approverRoles ?? []).join(', ') || 'project administrator';
  const waited = formatAge(age);
  const title = `Approval waiting — ${request.id}`;
  const items: AdfNode[] = [
    bullet(text('Request: ', true), text(`${request.id} — ${request.actionClass} on ${request.target}`)),
    bullet(text('Waiting for: ', true), text(waited)),
    bullet(text('Level: ', true), text(`N${request.level}`)),
    bullet(text('Approvers: ', true), text(roles)),
  ];
  const closing =
    action === 'expired'
      ? 'This request expired: nothing was granted and nothing was refused. The agent must ask again.'
      : action === 'escalation'
        ? 'Escalated: nobody answered. Grant it, or refuse it with a written reason — silence leaves the agent blocked indefinitely.'
        : 'Still waiting for a decision. Refusing is a valid answer and only requires a reason.';
  return { title, body: doc(paragraph(text(title, true)), bulletList(items), paragraph(text(closing))) };
}

export interface SweepOptions {
  projectId: string;
  now?: string;
  policy?: SlaPolicy;
  poster?: CommentPoster;
  /** Requests to sweep; defaults to every pending request of the project. */
  pending?: ApprovalRequest[];
}

export interface SweepResult {
  scanned: number;
  reminded: number;
  escalated: number;
  expired: number;
  /** Actions taken but not announced: the state change still stands. */
  undelivered: number;
}

/**
 * Act on every pending request past its deadline. Idempotent: an action
 * already journalled for a request is not repeated, so a daily sweep reminds
 * once and escalates once rather than nagging every night.
 */
export async function sweepApprovals(
  repos: Repositories,
  options: SweepOptions,
): Promise<SweepResult> {
  const now = options.now ?? new Date().toISOString();
  const policy = options.policy ?? DEFAULT_SLA;
  const projectId = options.projectId;
  const pending = options.pending ?? (await repos.requests.listPending()).filter(
    (request) => request.projectId === projectId,
  );
  const done = await slaActionsTaken(repos, projectId);
  const result: SweepResult = { scanned: pending.length, reminded: 0, escalated: 0, expired: 0, undelivered: 0 };

  for (const request of pending) {
    const age = ageMinutes(request, now);
    const outcome = await actOnRequest(repos, request, slaState(request, now, policy), age, done, options);
    result.reminded += outcome.reminder ? 1 : 0;
    result.escalated += outcome.escalation ? 1 : 0;
    result.expired += outcome.expired ? 1 : 0;
    result.undelivered += outcome.undelivered ? 1 : 0;
  }
  return result;
}

/** The SLA actions already journalled, keyed `requestId:action`. */
async function slaActionsTaken(repos: Repositories, projectId: string): Promise<Set<string>> {
  const entries = await repos.ledger.list({ projectId, kind: 'sla' });
  return new Set(
    entries
      .map((entry) => entry.detail as Record<string, unknown> | undefined)
      .filter((detail): detail is Record<string, unknown> => typeof detail?.action === 'string')
      .map((detail) => `${detail.requestId}:${detail.action}`),
  );
}

interface RequestOutcome {
  reminder: boolean;
  escalation: boolean;
  expired: boolean;
  undelivered: boolean;
}

/** One request: expire it if stale, otherwise announce the step it reached. */
async function actOnRequest(
  repos: Repositories,
  request: ApprovalRequest,
  state: SlaState,
  age: number,
  done: Set<string>,
  options: SweepOptions,
): Promise<RequestOutcome> {
  const outcome: RequestOutcome = { reminder: false, escalation: false, expired: false, undelivered: false };
  if (state === 'on-time') return outcome;

  if (state === 'stale') {
    if (done.has(`${request.id}:expired`)) return outcome;
    await expireRequest(repos, request, options.projectId, age, options.now);
    outcome.expired = true;
    outcome.undelivered = !(await announce(request, 'expired', age, options));
    return outcome;
  }

  const action: SlaAction = state === 'late' ? 'escalation' : 'reminder';
  if (done.has(`${request.id}:${action}`)) return outcome;
  await journal(repos, request, options.projectId, action, age, options.now);
  if (action === 'escalation') outcome.escalation = true;
  else outcome.reminder = true;
  outcome.undelivered = !(await announce(request, action, age, options));
  return outcome;
}

/** Expire the request and journal it: the agent is told rather than left waiting. */
async function expireRequest(
  repos: Repositories,
  request: ApprovalRequest,
  projectId: string,
  age: number,
  now?: string,
): Promise<void> {
  request.status = 'expired';
  await repos.requests.update(request);
  await journal(repos, request, projectId, 'expired', age, now);
}

/** Write the SLA event into the chained ledger. */
async function journal(
  repos: Repositories,
  request: ApprovalRequest,
  projectId: string,
  action: SlaAction,
  age: number,
  now?: string,
): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    {
      kind: 'sla',
      projectId,
      issueId: request.issueId,
      profileId: request.profileId,
      pilotAccountId: request.pilotAccountId,
      actionClass: request.actionClass,
      target: request.target,
      decision: action === 'expired' ? 'expired' : 'notified',
      detail: { action, requestId: request.id, ageMinutes: age, level: request.level },
      at: now ?? new Date().toISOString(),
    },
    prev,
  );
  await repos.ledger.append(entry);
  return entry;
}

/** Post the notice on the ticket; a failure is logged and never thrown. */
async function announce(
  request: ApprovalRequest,
  action: SlaAction,
  age: number,
  options: SweepOptions,
): Promise<boolean> {
  if (!request.issueId) return false;
  const poster = options.poster ?? defaultPoster();
  if (!poster) {
    console.error('[permis-sla] no Jira transport; the SLA step is journalled but not announced');
    return false;
  }
  try {
    await poster(request.issueId, buildSlaNotice(request, action, age).body);
    return true;
  } catch (error) {
    console.error('[permis-sla] comment failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}
