/**
 * Operator entry point — installation bootstrap and demo support.
 *
 * Why this exists: the gate identifies a pilot with a personal token, and that
 * token is normally minted from a Jira screen. Before any screen is reachable
 * (fresh installation, CI, a scripted demo) an operator needs a way to mint the
 * first token, inspect the installation, approve a pending request and revoke a
 * permit. This module is that way.
 *
 * Security model (read docs/DEPLOYMENT.md before enabling it):
 * - it is a SEPARATE web trigger, so it has its own unguessable URL;
 * - every call must present the installation secret in `X-Permis-Admin`, which
 *   is the same secret that signs permits and is stored as an app variable;
 * - the comparison is constant-time and a wrong secret is refused with 401;
 * - approvals still go through src/services/approvals-service, so the pilot of
 *   a request cannot approve it and a denial still requires a written reason;
 * - nothing here widens the policy: there is no rule-writing operation.
 *
 * Wire format is the Forge web trigger contract, as in src/hooks/gate.ts.
 */
import { timingSafeEqual } from 'crypto';
import { approveRequest, createHookToken, denyRequest, revokePermit } from '../services/approvals-service';
import { applySeed, planSeed } from '../services/seed-policy';
import { verifyChain } from '../core/ledger';
import { Repositories } from '../core/types';
import { getRuntimeSync } from '../mcp/runtime';
import { ensureSchema } from '../storage';
import { WebTriggerRequest, WebTriggerResponse } from './gate';

const ADMIN_HEADER = 'x-permis-admin';

/** Read one header value case-insensitively from the Forge array form. */
function headerOf(input: any, name: string): string | undefined {
  const headers = (input?.headers ?? {}) as Record<string, string[]>;
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const first = Array.isArray(values) ? values[0] : (values as unknown as string);
    if (typeof first === 'string' && first.trim().length > 0) return first.trim();
  }
  return undefined;
}

function respond(statusCode: number, payload: unknown): WebTriggerResponse {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(payload),
  };
}

/** Constant-time secret comparison; length differences short-circuit safely. */
function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBody(input: any): any {
  const raw = typeof input?.body === 'string' && input.body.length > 0 ? input.body : '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** Per-repository health probe: which table answers, and what it says. */
async function health(repos: Repositories, projectId: string): Promise<Record<string, unknown>> {
  const probes: { name: string; run: () => Promise<unknown> }[] = [
    { name: 'policy_rule', run: () => repos.policies.listRules(projectId) },
    { name: 'zone', run: () => repos.zones.listZones(projectId) },
    { name: 'permit', run: () => repos.permits.listPermits({ projectId }) },
    { name: 'ledger', run: () => repos.ledger.list({ projectId, limit: 1 }) },
    { name: 'request', run: () => repos.requests.listPending() },
    { name: 'kill_switch', run: () => repos.killSwitches.get('project', projectId) },
    { name: 'agent_profile', run: () => repos.profiles.getProfile(projectId, 'health-probe') },
    { name: 'trust_state', run: () => repos.trust.getState('health-probe') },
    { name: 'hook_token', run: () => repos.hookTokens.listForAccount('health-probe') },
  ];
  const results: Record<string, string> = {};
  for (const probe of probes) {
    try {
      await probe.run();
      results[probe.name] = 'ok';
    } catch (error) {
      results[probe.name] = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
    }
  }
  return results;
}

/** Installation health: what is stored, and is the ledger chain intact? */
async function status(repos: Repositories, projectId: string): Promise<Record<string, unknown>> {
  const [rules, zones, permits, entries, pending] = await Promise.all([
    repos.policies.listRules(projectId),
    repos.zones.listZones(projectId),
    repos.permits.listPermits({ projectId }),
    repos.ledger.list({ projectId }),
    repos.requests.listPending(),
  ]);
  const ordered = [...entries].sort((a, b) => a.seq - b.seq);
  const chain = verifyChain(ordered);
  return {
    projectId,
    rules: rules.length,
    zones: zones.length,
    permits: permits.length,
    ledgerEntries: entries.length,
    pendingRequests: pending.length,
    chainValid: chain.valid,
    chainChecked: chain.checked,
    firstBreak: chain.firstBreak,
    storage: process.env.PERMIS_STORAGE ?? 'auto',
  };
}

/** Dispatch one operator command. */
async function dispatch(repos: Repositories, secret: string, body: any): Promise<WebTriggerResponse> {
  const action = String(body?.action ?? '');
  const projectId = typeof body?.projectId === 'string' ? body.projectId : 'unknown';

  if (action === 'status') return respond(200, await status(repos, projectId));

  if (action === 'health') return respond(200, { projectId, tables: await health(repos, projectId) });

  // Create the tables and seed the organisation floor once, right after a first
  // install, so the first real decision does not pay for the DDL.
  if (action === 'bootstrap-schema') {
    const result = await ensureSchema();
    return respond(result.ok ? 200 : 500, result);
  }

  if (action === 'mint-token') {
    const accountId = String(body?.accountId ?? '');
    if (!accountId) return respond(400, { error: 'ACCOUNT_ID_REQUIRED' });
    const created = await createHookToken(repos, accountId, body?.label);
    // Shown once: only the hash is stored.
    return respond(200, { ok: true, accountId, token: created.token, tokenHash: created.hash });
  }

  if (action === 'approve-request' || action === 'deny-request') {
    return approveOrDeny(repos, secret, body, action === 'approve-request');
  }

  if (action === 'revoke-permit') {
    const outcome = await revokePermit(repos, String(body?.permitId ?? ''), String(body?.by ?? 'operator'), body?.reason);
    return respond(outcome.ok ? 200 : 404, { ok: outcome.ok, permitId: body?.permitId });
  }

  // Load a policy seed (zones + project rules). Guard rails live in the service:
  // org scope refused, locked classes refused, nothing softer than the floor.
  if (action === 'seed-policy') {
    const seedProject = typeof body?.projectId === 'string' && body.projectId.length > 0 ? body.projectId : projectId;
    const plan = await planSeed(repos, seedProject, body?.policy ?? {});
    const result = await applySeed(repos, plan, String(body?.by ?? 'operator'));
    return respond(200, { ...result, projectId: seedProject });
  }

  return respond(400, {
    error: 'UNKNOWN_ACTION',
    allowed: [
      'status',
      'health',
      'bootstrap-schema',
      'seed-policy',
      'mint-token',
      'approve-request',
      'deny-request',
      'revoke-permit',
    ],
  });
}

/** Approvals go through the service, so its guard rails still apply. */
async function approveOrDeny(
  repos: Repositories,
  secret: string,
  body: any,
  grant: boolean,
): Promise<WebTriggerResponse> {
  const request = await repos.requests.get(String(body?.requestId ?? ''));
  if (!request) return respond(404, { error: 'REQUEST_NOT_FOUND' });
  const approver = {
    accountId: String(body?.approverAccountId ?? ''),
    roles: Array.isArray(body?.roles) ? body.roles.map(String) : [String(body?.role ?? 'operator')],
    // Computed from the request, never from the payload.
    isPilot: String(body?.approverAccountId ?? '') === request.pilotAccountId,
  };
  const common = { repos, secret, requestId: request.id, approver, reason: body?.reason };
  const outcome = grant
    ? await approveRequest({ ...common, ttlMinutes: body?.ttlMinutes, uses: body?.uses })
    : await denyRequest(common);
  return respond(outcome.ok ? 200 : 403, {
    ok: outcome.ok,
    error: outcome.error,
    status: outcome.request?.status,
    permit: outcome.permit?.id,
    expiresAt: outcome.permit?.expiresAt,
    usesLeft: outcome.permit?.usesLeft,
  });
}

/** Entry point of the operator web trigger. */
export async function handleAdmin(input: WebTriggerRequest | any): Promise<WebTriggerResponse> {
  const runtime = getRuntimeSync();
  const provided = headerOf(input, ADMIN_HEADER);
  if (!provided) return respond(401, { error: 'ADMIN_SECRET_REQUIRED' });
  if (!secretMatches(provided, runtime.secret)) return respond(401, { error: 'ADMIN_SECRET_INVALID' });
  try {
    return await dispatch(runtime.repos, runtime.secret, parseBody(input));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // Visible dans `forge logs` : une erreur avalée ne se diagnostique pas.
    console.error('[permis-admin] failure:', error);
    return respond(500, { error: 'ADMIN_FAILURE', detail });
  }
}
