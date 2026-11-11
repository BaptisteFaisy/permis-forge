/**
 * Hook gate — the web trigger every enforcement point calls.
 *
 * Two modes:
 * - decision mode (default): a Claude Code PreToolUse hook event arrives, the
 *   action is classified and decided, and the answer says allow / ask / deny;
 * - verification mode: a CI step asks whether a permit is valid (spec §19,
 *   point d'application n°3).
 *
 * Wire contract (Forge web trigger): the function receives a plain object
 * `{ method, headers, body, path, userPath, queryParameters }` where `body` is
 * a string and each header value is an ARRAY of strings; it must return
 * `{ statusCode, headers, body }`. A Fetch `Request` is also accepted so the
 * gate stays testable offline. Any failure answers 5xx, which the client blocks
 * because the generated hooks file sets onFailure: block — closed by default.
 *
 * The web trigger has no platform authentication (spec §18): the personal hook
 * token identifies the pilot, and an unknown token is refused.
 */
import { createHash } from 'crypto';
import { buildGateResponseBody, mapHookEventToAction } from '../core/gate';
import { verifyPermit } from '../core/permits';
import { HookEvent } from '../core/types';
import { buildCaller, getRuntimeSync } from '../mcp/runtime';

/** Forge web trigger request payload. */
export interface WebTriggerRequest {
  method?: string;
  headers?: Record<string, string[]>;
  body?: string;
  path?: string;
  userPath?: string;
  queryParameters?: Record<string, string[]>;
}

/** Forge web trigger response payload. */
export interface WebTriggerResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: string;
  statusText?: string;
}

type HeaderLookup = (name: string) => string | undefined;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Build the JSON answer Forge sends back to the caller. */
function respond(statusCode: number, payload: unknown, statusText?: string): WebTriggerResponse {
  const response: WebTriggerResponse = {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(payload),
  };
  if (statusText) response.statusText = statusText;
  return response;
}

/** Read one header value case-insensitively from the Forge array form. */
function fromForgeHeaders(headers: Record<string, string[]>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, values] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    const first = Array.isArray(values) ? values[0] : (values as unknown as string);
    if (typeof first === 'string' && first.trim().length > 0) return first.trim();
  }
  return undefined;
}

/** Accept either the Forge payload or a Fetch Request (offline tests). */
async function normalize(input: any): Promise<{ body: any; header: HeaderLookup }> {
  if (typeof input?.json === 'function' && typeof input?.headers?.get === 'function') {
    let parsed: any = {};
    try {
      parsed = await input.json();
    } catch {
      parsed = {};
    }
    const header: HeaderLookup = (name) => {
      const value = input.headers.get(name);
      return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    };
    return { body: parsed, header };
  }
  const raw = typeof input?.body === 'string' && input.body.length > 0 ? input.body : '{}';
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const headers = (input?.headers ?? {}) as Record<string, string[]>;
  return { body: parsed, header: (name) => fromForgeHeaders(headers, name) };
}

/** Bearer token of the pilot, when the caller sent one. */
function bearerToken(header: HeaderLookup): string | undefined {
  const value = header('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : undefined;
}

function toHookEvent(body: any): HookEvent {
  return {
    toolName: typeof body?.toolName === 'string' ? body.toolName : 'unknown',
    args: typeof body?.args === 'object' && body.args !== null ? body.args : {},
    cwd: typeof body?.cwd === 'string' ? body.cwd : undefined,
  };
}

/** Verification mode: is this permit still valid? */
async function verifyPermitMode(body: any): Promise<WebTriggerResponse> {
  const runtime = getRuntimeSync();
  const permitId = typeof body?.permitId === 'string' ? body.permitId : '';
  const permits = await runtime.repos.permits.listPermits({});
  const permit = permits.find((item) => item.id === permitId);
  if (!permit) return respond(200, { permitId, found: false, valid: false });
  const now = runtime.now();
  const signatureValid = verifyPermit(permit, runtime.secret);
  const expired = now >= permit.expiresAt;
  const active = !expired && permit.usesLeft > 0 && !permit.revokedAt && permit.suspended !== true;
  return respond(200, {
    permitId,
    found: true,
    valid: signatureValid && active,
    signatureValid,
    expired,
    revoked: Boolean(permit.revokedAt),
    usesLeft: permit.usesLeft,
    scope: permit.scope,
  });
}

/** Decision mode: the hook asks "may I run this tool?". */
async function decisionMode(
  header: HeaderLookup,
  body: any,
  event: HookEvent,
  accountId: string,
): Promise<WebTriggerResponse> {
  const runtime = getRuntimeSync();
  // The ticket is not part of the client payload: the bridge sends it in a
  // header, or the caller puts it in the body. Without it, actions beyond N4
  // are refused (spec §20).
  const issueKey =
    header('x-permis-issue') ?? (typeof body?.issueKey === 'string' && body.issueKey.length > 0 ? body.issueKey : undefined);
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
  return respond(
    200,
    buildGateResponseBody({
      decision: decision.decision,
      reason: decision.reason,
      requestId: decision.requestId,
      level: decision.level,
    }),
  );
}

/** Entry point of the web trigger. */
export async function handleGate(input: WebTriggerRequest | Request | any): Promise<WebTriggerResponse> {
  const { body, header } = await normalize(input);
  try {
    if (typeof body?.permitId === 'string' && body.permitId.length > 0) {
      return await verifyPermitMode(body);
    }
    const token = bearerToken(header);
    if (!token) return respond(401, { error: 'PERSONAL_TOKEN_REQUIRED' }, 'Unauthorized');
    const runtime = getRuntimeSync();
    const stored = await runtime.repos.hookTokens.findByTokenHash(hashToken(token));
    if (!stored) return respond(401, { error: 'UNKNOWN_TOKEN' }, 'Unauthorized');
    await runtime.repos.hookTokens.touchLastUsed(stored.tokenHash, runtime.now());
    return await decisionMode(header, body, toHookEvent(body), stored.accountId);
  } catch (error) {
    // Fail closed: a 5xx makes the client block the action (onFailure: block).
    // Logged as well, so `forge logs` shows why the door stayed shut.
    console.error('[permis-gate] failure:', error);
    return respond(500, { error: 'GATE_FAILURE', detail: errorMessage(error) }, 'Internal error');
  }
}
