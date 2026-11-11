/**
 * Hook gate — the web trigger every enforcement point calls.
 *
 * Two modes:
 * - decision mode (default): a Claude Code PreToolUse hook event arrives, the
 *   action is classified and decided, and the answer says allow / ask / deny;
 * - verification mode: a CI step asks whether a permit is valid (spec §19,
 *   point d'application n°3).
 *
 * The web trigger has no platform authentication (spec §18): the personal hook
 * token identifies the pilot, and an unknown token is refused. A non-2xx
 * answer is blocked by the client because the generated hooks file sets
 * onFailure: block — the door stays closed by default.
 */
import { createHash } from 'crypto';
import { buildGateResponseBody, mapHookEventToAction } from '../core/gate';
import { verifyPermit } from '../core/permits';
import { HookEvent } from '../core/types';
import { buildCaller, getRuntimeSync } from '../mcp/runtime';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function readEvent(request: Request): Promise<{ event: HookEvent; token?: string }> {
  const header = request.headers.get('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined;
  let body: any = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const event: HookEvent = {
    toolName: typeof body?.toolName === 'string' ? body.toolName : 'unknown',
    args: typeof body?.args === 'object' && body.args !== null ? body.args : {},
    cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
    token,
  };
  return { event, token };
}

/** Verification mode: is this permit still valid? */
async function verifyPermitMode(body: any): Promise<Response> {
  const runtime = getRuntimeSync();
  const permitId = typeof body?.permitId === 'string' ? body.permitId : '';
  const permits = await runtime.repos.permits.listPermits({});
  const permit = permits.find((item) => item.id === permitId);
  if (!permit) return jsonResponse(200, { permitId, found: false, valid: false });
  const signatureValid = verifyPermit(permit, runtime.secret);
  const active = runtime.now() < permit.expiresAt && permit.usesLeft > 0 && !permit.revokedAt;
  return jsonResponse(200, {
    permitId,
    found: true,
    valid: signatureValid && active,
    signatureValid,
    expired: runtime.now() >= permit.expiresAt,
    revoked: Boolean(permit.revokedAt),
    usesLeft: permit.usesLeft,
    scope: permit.scope,
  });
}

/** Decision mode: the hook asks "may I run this tool?". */
async function decisionMode(request: Request, event: HookEvent, accountId: string): Promise<Response> {
  const runtime = getRuntimeSync();
  // The ticket is not part of the client payload: the bridge sends it in a
  // header (or the body). Without it, actions beyond N4 are refused (spec §20).
  const issueKey = headerValue(request, 'x-permis-issue');
  const action = mapHookEventToAction(event, {
    issueKey,
    projectKey: issueKey && issueKey.includes('-') ? issueKey.split('-')[0] : undefined,
  });
  const caller = buildCaller({
    projectId: action.projectId ?? 'unknown',
    issueKey,
    profileId: 'default',
    accountId,
    via: 'hook',
  });
  const decision = await runtime.engine.evaluateAction({ ...action, at: runtime.now() }, caller);
  const body = buildGateResponseBody({
    decision: decision.decision,
    reason: decision.reason,
    requestId: decision.requestId,
    level: decision.level,
  });
  return jsonResponse(200, body);
}

/** Read one header, case-insensitively, ignoring empty values. */
function headerValue(request: Request, name: string): string | undefined {
  const value = request.headers.get(name);
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Entry point of the web trigger. */
export async function handleGate(request: Request): Promise<Response> {
  const runtime = getRuntimeSync();
  let raw: any = {};
  try {
    raw = await request.clone().json();
  } catch {
    raw = {};
  }
  if (typeof raw?.permitId === 'string' && raw.permitId.length > 0) {
    return verifyPermitMode(raw);
  }
  const { event, token } = await readEvent(request);
  if (!token) {
    return jsonResponse(401, { error: 'PERSONAL_TOKEN_REQUIRED' });
  }
  const stored = await runtime.repos.hookTokens.findByTokenHash(hashToken(token));
  if (!stored) {
    return jsonResponse(401, { error: 'UNKNOWN_TOKEN' });
  }
  await runtime.repos.hookTokens.touchLastUsed(stored.tokenHash, runtime.now());
  try {
    return await decisionMode(request, event, stored.accountId);
  } catch (error) {
    return jsonResponse(500, { error: 'GATE_FAILURE', detail: String(error) });
  }
}
