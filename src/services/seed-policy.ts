/**
 * Policy seeding for a fresh installation (operator bootstrap).
 *
 * A new installation has the organisation floor (seeded with the schema) but no
 * project rules and no zones, so every action falls back to the catalogue
 * default and the policy grid looks empty. This service loads a seed document
 * — `examples/policy/seed-payments.json` is one — through the operator entry
 * point.
 *
 * Guard rails, because this endpoint writes policy:
 * - only `project` scope is accepted: the organisation floor comes from the
 *   schema bootstrap and is changed from the Jira screens, under a real
 *   Atlassian identity, never through an operator secret;
 * - a rule can never be more permissive than the organisation floor of its
 *   class (spec §7.2: a project hardens, never softens);
 * - a locked class (A-15) is refused outright — an operator secret must not be
 *   a way around "an agent never widens its own rights";
 * - every applied rule is journaled as `policy-changed` with its author.
 */
import { isLockedClass } from '../core/catalog';
import { makeEntry } from '../core/ledger';
import {
  AutonomyLevel,
  LedgerEntry,
  PolicyRule,
  Repositories,
  RuleMode,
  Zone,
} from '../core/types';

export interface SeedDocument {
  projectId?: string;
  settings?: Record<string, unknown>;
  zones?: Partial<Zone>[];
  rules?: Partial<PolicyRule>[];
  orgFloor?: Partial<PolicyRule>[];
}

export interface SeedRefusal {
  id: string;
  reason: 'ORG_SCOPE_REFUSED' | 'LOCKED_CLASS' | 'SOFTER_THAN_ORG_FLOOR' | 'INVALID_LEVEL' | 'INVALID';
  detail: string;
}

export interface SeedPlan {
  projectId: string;
  zones: Zone[];
  rules: PolicyRule[];
  refusals: SeedRefusal[];
}

const LEVELS: AutonomyLevel[] = [0, 1, 2, 3, 4, 5];

/** Validate a seed document against the existing policy; change nothing. */
export async function planSeed(
  repos: Repositories,
  projectId: string,
  seed: SeedDocument,
): Promise<SeedPlan> {
  const existing = await repos.policies.listRules(projectId);
  const floor = orgFloorByClass(existing);
  const zones: Zone[] = [];
  const rules: PolicyRule[] = [];
  const refusals: SeedRefusal[] = [];

  for (const zone of seed.zones ?? []) {
    const built = toZone(zone, projectId);
    if (built) zones.push(built);
    else refusals.push({ id: String(zone.id ?? zone.name ?? '?'), reason: 'INVALID', detail: 'zone sans nom' });
  }
  for (const rule of seed.rules ?? []) {
    const verdict = toRule(rule, projectId, floor);
    if (verdict.rule) rules.push(verdict.rule);
    else refusals.push({ id: String(rule.id ?? '?'), reason: verdict.reason!, detail: verdict.detail! });
  }
  return { projectId, zones, rules, refusals };
}

/** Strictest organisation level per class, from the rules already stored. */
function orgFloorByClass(rules: PolicyRule[]): Record<string, AutonomyLevel> {
  const floor: Record<string, AutonomyLevel> = {};
  for (const rule of rules) {
    if (rule.scope !== 'org') continue;
    const current = floor[rule.actionClass];
    if (current === undefined || rule.level < current) floor[rule.actionClass] = rule.level;
  }
  return floor;
}

function toZone(source: Partial<Zone>, projectId: string): Zone | null {
  if (typeof source.name !== 'string' || source.name.length === 0) return null;
  return {
    id: typeof source.id === 'string' && source.id.length > 0 ? source.id : `zone-${source.name}`,
    projectId,
    name: source.name,
    pathPatterns: Array.isArray(source.pathPatterns) ? source.pathPatterns.map(String) : [],
    component: typeof source.component === 'string' ? source.component : undefined,
    environment: source.environment,
  };
}

type RuleVerdict =
  | { rule: PolicyRule; reason?: undefined; detail?: undefined }
  | { rule?: undefined; reason: SeedRefusal['reason']; detail: string };

/** One seed rule → a storable rule, or an explicit refusal. */
function toRule(
  source: Partial<PolicyRule>,
  projectId: string,
  floor: Record<string, AutonomyLevel>,
): RuleVerdict {
  const actionClass = source.actionClass;
  if (typeof actionClass !== 'string' || actionClass.length === 0) {
    return { reason: 'INVALID', detail: 'classe d’action absente' };
  }
  if (source.scope === 'org') {
    return { reason: 'ORG_SCOPE_REFUSED', detail: 'le plancher d’organisation ne se change pas ici' };
  }
  if (isLockedClass(actionClass)) {
    return { reason: 'LOCKED_CLASS', detail: `${actionClass} est verrouillée` };
  }
  const level = source.level as AutonomyLevel;
  if (!LEVELS.includes(level)) {
    return { reason: 'INVALID_LEVEL', detail: `niveau invalide : ${String(source.level)}` };
  }
  const floorLevel = floor[actionClass];
  if (floorLevel !== undefined && level > floorLevel) {
    return {
      reason: 'SOFTER_THAN_ORG_FLOOR',
      detail: `N${level} est plus permissif que le plancher d’organisation N${floorLevel}`,
    };
  }
  const mode: RuleMode = source.mode === 'observe' ? 'observe' : 'enforce';
  return {
    rule: {
      id: typeof source.id === 'string' && source.id.length > 0
        ? source.id
        : `${projectId}-${actionClass}-${source.zoneId ?? 'any'}`,
      scope: 'project',
      projectId,
      actionClass,
      zoneId: typeof source.zoneId === 'string' ? source.zoneId : undefined,
      conditions: source.conditions,
      level,
      mode,
      approverRole: typeof source.approverRole === 'string' ? source.approverRole : undefined,
    },
  };
}

export interface SeedResult {
  ok: boolean;
  zonesWritten: number;
  rulesWritten: number;
  refusals: SeedRefusal[];
  entries: number;
}

/** Write a validated plan and journal every rule that changed. */
export async function applySeed(
  repos: Repositories,
  plan: SeedPlan,
  actor: string,
  at?: string,
): Promise<SeedResult> {
  const stamp = at ?? new Date().toISOString();
  for (const zone of plan.zones) await repos.zones.upsertZone(zone);
  let entries = 0;
  for (const rule of plan.rules) {
    await repos.policies.upsertRule(rule);
    await journalRule(repos, plan.projectId, rule, actor, stamp);
    entries++;
  }
  return {
    ok: plan.rules.length > 0 || plan.zones.length > 0,
    zonesWritten: plan.zones.length,
    rulesWritten: plan.rules.length,
    refusals: plan.refusals,
    entries,
  };
}

async function journalRule(
  repos: Repositories,
  projectId: string,
  rule: PolicyRule,
  actor: string,
  at: string,
): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(projectId);
  const entry = makeEntry(
    {
      kind: 'policy-changed',
      projectId,
      actionClass: rule.actionClass,
      ruleId: rule.id,
      decision: 'seeded',
      detail: {
        actor,
        level: rule.level,
        mode: rule.mode,
        zoneId: rule.zoneId,
        approverRole: rule.approverRole,
      },
      at,
    },
    prev,
  );
  await repos.ledger.append(entry);
  return entry;
}
