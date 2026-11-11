/**
 * Explicit UI mutations (policy rules, zones, project kill switch,
 * personal hook tokens, ledger integrity verification).
 */
import { createHash, randomBytes } from 'crypto';
import { ChainVerification, LedgerEntry, PolicyRule, Zone } from '../core/types';
import { verifyLedgerIntegrity } from './audit';
import { accountIdOf, idOf, projectIdOf, str } from './format';
import type { ResolverDeps } from './resolvers';

export type DefineFn = (key: string, handler: (request: any) => Promise<unknown>) => void;

export async function issueHookToken(deps: ResolverDeps, accountId: string, label?: string) {
  const token = randomBytes(24).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  await deps.repos.hookTokens.save({ accountId, tokenHash, label, createdAt: new Date().toISOString() });
  return { token, tokenHash };
}

export function toPolicyRule(payload: any, projectId: string): PolicyRule | null {
  const source = payload?.rule ?? payload;
  const actionClass = str(source?.actionClass);
  const level = Number(source?.level);
  if (!actionClass || !Number.isInteger(level) || level < 0 || level > 5) return null;
  const scope = source?.scope === 'org' ? 'org' : 'project';
  return {
    id: str(source?.id) ?? `rule-${actionClass}`,
    scope,
    projectId: scope === 'project' ? projectId : undefined,
    actionClass,
    zoneId: str(source?.zoneId),
    conditions: source?.conditions,
    level: level as PolicyRule['level'],
    mode: source?.mode === 'observe' ? 'observe' : 'enforce',
    approverRole: str(source?.approverRole),
  };
}

export function toZone(payload: any, projectId: string): Zone | null {
  const source = payload?.zone ?? payload;
  const name = str(source?.name);
  if (!name) return null;
  return {
    id: str(source?.id) ?? `zone-${name}`,
    projectId,
    name,
    pathPatterns: Array.isArray(source?.pathPatterns) ? source.pathPatterns.map(String) : [],
    component: str(source?.component),
    environment: source?.environment,
  };
}

export async function handleToggleKillSwitch(deps: ResolverDeps, payload: any, context: any) {
  const projectId = projectIdOf(payload, context);
  const activate = payload?.activate === true;
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
  const by = accountIdOf(context);
  if (!reason) return { ok: false, error: 'REASON_REQUIRED' };
  // One brake per project, one for the whole organisation (spec §12).
  const scope: 'org' | 'project' = payload?.scope === 'org' ? 'org' : 'project';
  const current = await deps.repos.killSwitches.get(scope, scope === 'org' ? undefined : projectId);
  if (!activate && payload?.requireDifferentPerson !== false && current?.active && current.by === by) {
    return { ok: false, error: 'DIFFERENT_PERSON_REQUIRED' };
  }
  const killSwitch = {
    scope,
    projectId: scope === 'org' ? undefined : projectId,
    active: activate,
    by,
    reason,
    at: new Date().toISOString(),
  };
  await deps.repos.killSwitches.save(killSwitch);
  return { ok: true, killSwitch };
}

export function registerMutations(define: DefineFn, deps: ResolverDeps): void {
  define('saveRule', async ({ payload, context }: any) => {
    const rule = toPolicyRule(payload, projectIdOf(payload, context));
    if (!rule) return { ok: false, error: 'INVALID_RULE' };
    await deps.repos.policies.upsertRule(rule);
    return { ok: true, rule };
  });
  define('deleteRule', async ({ payload }: any) => {
    const id = idOf(payload, ['id', 'ruleId']);
    if (!id) return { ok: false, error: 'MISSING_RULE_ID' };
    await deps.repos.policies.deleteRule(id);
    return { ok: true, id };
  });
  define('saveZone', async ({ payload, context }: any) => {
    const zone = toZone(payload, projectIdOf(payload, context));
    if (!zone) return { ok: false, error: 'INVALID_ZONE' };
    await deps.repos.zones.upsertZone(zone);
    return { ok: true, zone };
  });
  define('deleteZone', async ({ payload }: any) => {
    const id = idOf(payload, ['id', 'zoneId']);
    if (!id) return { ok: false, error: 'MISSING_ZONE_ID' };
    await deps.repos.zones.deleteZone(id);
    return { ok: true, id };
  });
  define('toggleProjectKillSwitch', ({ payload, context }: any) => handleToggleKillSwitch(deps, payload, context));
  define('generateHookToken', async ({ payload, context }: any) => {
    const issued = await issueHookToken(deps, accountIdOf(context), payload?.label);
    return { ok: true, ...issued, notice: 'This token is shown once. Store it in PERMIS_AGENT_TOKEN.' };
  });
  define('verifyLedger', async ({ payload, context }: any) => {
    const entries = await deps.repos.ledger.list({ projectId: projectIdOf(payload, context) });
    const ordered = [...entries].sort((a, b) => a.seq - b.seq);
    const verification = verifyLedgerIntegrity(ordered, deps.verifyChain as (e: LedgerEntry[]) => ChainVerification);
    return { ok: verification.valid, ...verification };
  });
}
