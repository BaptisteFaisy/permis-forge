/**
 * Forge triggers: issue updates and nightly maintenance.
 *
 * Nightly maintenance does the recurrent jobs of the spec (spec §16):
 * expire permits, erode the trust capital of idle profiles, verify the hash
 * chain of the ledger, and anchor the day (Merkle root of the day's entry
 * hashes, written to the chain and published outside the database so a third
 * party can verify it — spec §11, docs/ANCHORING.md). A broken chain is
 * written as a deviation so the verification screen shows it.
 */
import { erodeTrust } from './core/trust';
import { makeEntry, verifyChain } from './core/ledger';
import { LedgerEntry } from './core/types';
import { getRuntimeSync } from './mcp/runtime';
import { anchorDay } from './services/anchor';
import { sweepApprovals } from './services/sla';

/** Statuses that close a ticket; pending requests on it become obsolete. */
const CLOSED_STATUSES = ['done', 'closed', 'resolved', 'terminé', 'fermé', 'resolu'];

function issueKeyFromEvent(event: any): string | undefined {
  const key = event?.issue?.key ?? event?.payload?.issueKey ?? event?.context?.issueKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

function projectKeyFromEvent(event: any): string | undefined {
  const key = event?.issue?.fields?.project?.key ?? event?.payload?.projectKey;
  return typeof key === 'string' && key.length > 0 ? key : undefined;
}

/** A closed ticket invalidates the approvals waiting on it. */
export async function onIssueUpdated(event: any): Promise<void> {
  const runtime = getRuntimeSync();
  const issueKey = issueKeyFromEvent(event);
  if (!issueKey) return;
  const statusName = String(event?.issue?.fields?.status?.name ?? '').toLowerCase();
  if (!CLOSED_STATUSES.includes(statusName)) return;
  const pending = await runtime.repos.requests.listPending(issueKey);
  if (pending.length === 0) return;
  const projectId = projectKeyFromEvent(event) ?? issueKey.split('-')[0];
  for (const request of pending) {
    request.status = 'expired';
    await runtime.repos.requests.update(request);
    const prev = await runtime.repos.ledger.lastEntry(projectId);
    const entry = makeEntry(
      {
        kind: 'request',
        projectId,
        issueId: issueKey,
        actionClass: request.actionClass,
        target: request.target,
        decision: 'expired',
        detail: { requestId: request.id, reason: 'Ticket closed before the request was decided' },
        at: runtime.now(),
      },
      prev,
    );
    await runtime.repos.ledger.append(entry);
  }
}

/** Nightly: expire permits, erode trust, verify the chain, anchor the day. */
export async function onScheduledMaintenance(): Promise<void> {
  const runtime = getRuntimeSync();
  const entries = await runtime.repos.ledger.list({});
  const projects = Array.from(new Set(entries.map((entry) => entry.projectId)));
  for (const projectId of projects) {
    await expirePermits(projectId);
    await erodeProfiles(projectId, entries);
    await verifyProjectChain(projectId, entries);
    // A request nobody answers is worse than a refusal: remind, escalate, then
    // expire it, so the agent is never left in an open-ended wait.
    await sweepApprovals(runtime.repos, { projectId, now: runtime.now() });
    // Last step: the anchor covers everything the maintenance wrote today.
    // Best effort — a publication failure is logged, never thrown (same
    // contract as notify.ts), so it cannot break the other jobs.
    await anchorDay(runtime.repos, { projectId, at: runtime.now() });
  }
}

/** Write one ledger entry per expired permit. */
async function expirePermits(projectId: string): Promise<void> {
  const runtime = getRuntimeSync();
  const permits = await runtime.repos.permits.listPermits({ projectId });
  const now = runtime.now();
  for (const permit of permits) {
    if (permit.revokedAt || permit.expiresAt >= now) continue;
    const prev = await runtime.repos.ledger.lastEntry(projectId);
    const entry = makeEntry(
      {
        kind: 'permit-expired',
        projectId,
        issueId: permit.scope.issueKey,
        actionClass: permit.scope.actionClass,
        target: permit.scope.target,
        permitId: permit.id,
        at: now,
      },
      prev,
    );
    await runtime.repos.ledger.append(entry);
  }
}

/** Trust capital drifts back to 50 for profiles that did nothing. */
async function erodeProfiles(projectId: string, entries: LedgerEntry[]): Promise<void> {
  const runtime = getRuntimeSync();
  const profiles = Array.from(
    new Set(entries.filter((entry) => entry.projectId === projectId && entry.profileId).map((entry) => entry.profileId as string)),
  );
  for (const profileId of profiles) {
    const state = await runtime.repos.trust.getState(profileId);
    if (!state || state.status !== 'active') continue;
    const eroded = erodeTrust(state, runtime.now());
    if (eroded.score === state.score) continue;
    await runtime.repos.trust.saveState(eroded);
    const prev = await runtime.repos.ledger.lastEntry(projectId);
    const entry = makeEntry(
      {
        kind: 'trust-change',
        projectId,
        profileId,
        decision: 'erosion',
        detail: { from: state.score, to: eroded.score, reason: 'Inactivity: trust drifts back to 50' },
        at: runtime.now(),
      },
      prev,
    );
    await runtime.repos.ledger.append(entry);
  }
}

/** Verify the hash chain and record a deviation when it is broken. */
async function verifyProjectChain(projectId: string, entries: LedgerEntry[]): Promise<void> {
  const runtime = getRuntimeSync();
  const scoped = entries.filter((entry) => entry.projectId === projectId).sort((a, b) => a.seq - b.seq);
  if (scoped.length === 0) return;
  const verification = verifyChain(scoped);
  if (verification.valid) return;
  const prev = await runtime.repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    {
      kind: 'deviation',
      projectId,
      decision: 'chain-broken',
      detail: { firstBreak: verification.firstBreak, checked: verification.checked },
      at: runtime.now(),
    },
    prev,
  );
  await runtime.repos.ledger.append(entry);
}
