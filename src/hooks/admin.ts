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
import { applyDrift, detectDrift as detectDriftReport } from '../services/drift';
import { applySuggestion, suggestPolicyChanges } from '../services/policy-suggestions';
import { applySeed, planSeed } from '../services/seed-policy';
import { parseChanges, planActionsFrom } from '../mcp/handlers/reads';
import { hashToken } from '../core/tokens';
import { verifyChain } from '../core/ledger';
import { Repositories } from '../core/types';
import { getRuntimeSync } from '../mcp/runtime';
import { ensureSchema } from '../storage';
import { callResolver, createResolvers } from '../ui/resolvers';
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
    // The trust state lives in the `agent_profile` row, so this probe reads the
    // `trust_event` table instead: one probe per table, none twice, none missed.
    { name: 'trust_event', run: () => repos.trust.listEvents('health-probe') },
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

/** Dispatch one operator command: reads first, then writes. */
async function dispatch(repos: Repositories, secret: string, body: any): Promise<WebTriggerResponse> {
  const action = String(body?.action ?? '');
  const projectId = typeof body?.projectId === 'string' ? body.projectId : 'unknown';
  return (
    (await dispatchRead(repos, action, projectId, body)) ??
    (await dispatchWrite(repos, secret, action, projectId, body)) ??
    respond(400, { error: 'UNKNOWN_ACTION', allowed: ALLOWED_ACTIONS })
  );
}

/** Every action an operator may call; also the answer to an unknown one. */
const ALLOWED_ACTIONS = [
  'status',
  'health',
  'screen',
  'bootstrap-schema',
  'seed-policy',
  'mint-token',
  'approve-request',
  'deny-request',
  'revoke-permit',
  'revoke-token',
  'apply-drift',
  'apply-suggestion',
];

/** Read-only commands: they change nothing, so they are safe to replay. */
async function dispatchRead(
  repos: Repositories,
  action: string,
  projectId: string,
  body: any,
): Promise<WebTriggerResponse | undefined> {
  if (action === 'status') return respond(200, await status(repos, projectId));

  if (action === 'health') return respond(200, { projectId, tables: await health(repos, projectId) });

  // Read-only view of a Jira screen, so the screen data path can be checked
  // against the real Forge SQL backend without opening a browser.
  if (action === 'screen') return renderScreen(repos, body);

  return undefined;
}

/** Commands that write: schema, tokens, approvals, policy and drift. */
async function dispatchWrite(
  repos: Repositories,
  secret: string,
  action: string,
  projectId: string,
  body: any,
): Promise<WebTriggerResponse | undefined> {
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

  if (action === 'revoke-token') return revokeTokenOperation(repos, body);
  if (action === 'apply-drift') return applyDriftOperation(repos, projectId, body);
  if (action === 'apply-suggestion') return applySuggestionOperation(repos, projectId, body);

  return undefined;
}

/**
 * Revoke a personal hook token, by its plaintext value or by its hash. The
 * plaintext is never stored, so an operator who only has the hash (from the
 * personal settings screen) can still revoke it.
 */
async function revokeTokenOperation(repos: Repositories, body: any): Promise<WebTriggerResponse> {
  const token = typeof body?.token === 'string' ? body.token : '';
  const hash =
    typeof body?.tokenHash === 'string' && body.tokenHash.length > 0 ? body.tokenHash : token ? hashToken(token) : '';
  if (!hash) return respond(400, { error: 'TOKEN_OR_HASH_REQUIRED' });

  const stored = await repos.hookTokens.findByTokenHash(hash);
  if (!stored) return respond(404, { error: 'UNKNOWN_TOKEN' });

  const revokedAt = new Date().toISOString();
  await repos.hookTokens.revoke(hash, String(body?.by ?? 'operator'), typeof body?.reason === 'string' ? body.reason : undefined, revokedAt);
  // The answer never echoes the token or its hash: a log of this call must not
  // become a place where credentials are collected.
  return respond(200, { ok: true, accountId: stored.accountId, label: stored.label, revokedAt });
}

/**
 * Enforcement point 4: record the gaps between what was observed and what was
 * declared. Reserved to the operator endpoint because it moves the trust
 * capital, and an agent must never move its own standing.
 */
async function applyDriftOperation(
  repos: Repositories,
  projectId: string,
  body: any,
): Promise<WebTriggerResponse> {
  const changes = parseChanges(body?.changes);
  if (changes === undefined) {
    return respond(400, { error: 'CHANGES_INVALID', note: 'changes must be a JSON array of {path|command}.' });
  }
  const issueKey = typeof body?.issueKey === 'string' ? body.issueKey : undefined;
  const profileId = typeof body?.profileId === 'string' ? body.profileId : 'default';
  const entries = await repos.ledger.list({ projectId, issueId: issueKey });
  const report = await detectDriftReport({
    projectId,
    issueKey,
    profileId,
    changes,
    declared: entries.filter((entry) => entry.kind === 'action-declared'),
    planActions: planActionsFrom(entries, issueKey),
    at: new Date().toISOString(),
  });
  const result = await applyDrift(repos, projectId, report, {
    issueKey,
    profileId,
    pilotAccountId: String(body?.by ?? 'operator'),
  });
  return respond(200, { projectId, ...report, ...result });
}

/**
 * Apply one policy suggestion. Writing a rule is class A-15 (N0): no agent can
 * call this, and the service still refuses a locked class on its own.
 */
async function applySuggestionOperation(
  repos: Repositories,
  projectId: string,
  body: any,
): Promise<WebTriggerResponse> {
  const suggestionId = String(body?.suggestionId ?? '');
  const actor = String(body?.by ?? '');
  if (!actor) return respond(400, { error: 'ACTOR_REQUIRED', note: 'A policy change must name its author.' });
  const suggestions = await suggestPolicyChanges(repos, projectId);
  const suggestion = suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) return respond(404, { error: 'SUGGESTION_NOT_FOUND', suggestionId });
  const result = await applySuggestion(repos, suggestion, actor);
  return respond(result.ok ? 200 : 409, {
    ok: result.ok,
    error: result.error,
    suggestionId,
    rule: result.rule,
    seq: result.entry?.seq,
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

/** Screens an operator may render; all of them are read-only. */
const RENDERABLE_SCREENS = [
  'issuePanel',
  'projectSettings',
  'projectPage',
  'simulationConsole',
  'globalPage',
  'personalSettings',
] as const;

/**
 * Render one Jira screen and return its payload.
 *
 * Read-only by construction: the screens only read repositories, and the
 * personal-settings screen is called with `action: 'list'` so it never mints a
 * token as a side effect. This exists so the screen data path can be verified
 * against the real Forge SQL backend without a browser.
 */
async function renderScreen(repos: Repositories, body: any): Promise<WebTriggerResponse> {
  const screen = String(body?.screen ?? '');
  if (!RENDERABLE_SCREENS.includes(screen as (typeof RENDERABLE_SCREENS)[number])) {
    return respond(400, { error: 'UNKNOWN_SCREEN', allowed: [...RENDERABLE_SCREENS] });
  }
  const runtime = getRuntimeSync();
  const resolver = createResolvers({ repos, engine: runtime.engine, verifyChain });
  const projectId = typeof body?.projectId === 'string' ? body.projectId : 'unknown';
  const issueKey = typeof body?.issueKey === 'string' ? body.issueKey : undefined;
  const payload = {
    ...(typeof body?.payload === 'object' && body.payload !== null ? body.payload : {}),
    projectId,
    ...(issueKey ? { issueKey } : {}),
    // Never mint a token as a side effect of a read-only inspection.
    ...(screen === 'personalSettings' ? { action: 'list' } : {}),
  };
  const context = {
    accountId: typeof body?.accountId === 'string' ? body.accountId : 'operator',
    extension: { project: { key: projectId }, ...(issueKey ? { issue: { key: issueKey } } : {}) },
  };
  const result = await callResolver(resolver, screen, { payload, context });
  return respond(200, { screen, result });
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
