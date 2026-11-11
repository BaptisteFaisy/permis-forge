/**
 * Policy suggestions from history (spec §26 "La politique s'écrit toute seule",
 * requirement PA-21) and the observe-before-hardening rule of spec §7.4.
 *
 * The service only ever *proposes*: every suggestion carries its evidence and
 * stays a proposal until a human applies it. Guard rails are absolute — a
 * locked class is never suggested, nothing is proposed beyond N4, nothing is
 * proposed that would be more permissive than the organisation floor, and the
 * classes that protect data, secrets, git history and production are never
 * relaxed.
 */
import { ACTION_CLASSES, defaultLevelFor, isLockedClass } from '../core/catalog';
import { makeEntry } from '../core/ledger';
import { summarize30DayObservation } from '../ui/audit';
import { AutonomyLevel, LedgerEntry, PolicyRule, Repositories, RuleMode } from '../core/types';

/** Classes that are never relaxed, whatever the history says. */
const NEVER_RELAX = new Set(['A-09', 'A-10', 'A-12', 'A-13', 'A-15']);

export interface SuggestionOptions {
  days?: number;
  minRequests?: number;
  minGrantRate?: number;
  minIncidents?: number;
  at?: string;
}

export type SuggestionDirection = 'relax' | 'harden' | 'observe-first' | 'enforce-observed';

export interface SuggestionEvidence {
  windowDays: number;
  requests: number;
  granted: number;
  denied: number;
  grantRate: number;
  incidents: number;
  deviations: number;
  wouldHaveBlocked: number;
  /** Ledger sequence numbers backing the numbers, for the audit trail. */
  seqs: number[];
}

export interface PolicySuggestion {
  id: string;
  projectId: string;
  actionClass: string;
  zoneId?: string;
  currentLevel: AutonomyLevel;
  proposedLevel: AutonomyLevel;
  proposedMode: RuleMode;
  direction: SuggestionDirection;
  evidence: SuggestionEvidence;
  risk: string;
  status: 'proposal';
}

const DEFAULTS = { days: 30, minRequests: 20, minGrantRate: 0.9, minIncidents: 2 };

/** Analyse the journal and propose level changes, with their evidence. */
export async function suggestPolicyChanges(
  repos: Repositories,
  projectId: string,
  opts: SuggestionOptions = {},
): Promise<PolicySuggestion[]> {
  const options = { ...DEFAULTS, ...opts };
  const at = options.at ?? new Date().toISOString();
  const entries = await repos.ledger.list({ projectId });
  const window = entries.filter((entry) => withinDays(entry.at, at, options.days));
  const rules = await repos.policies.listRules(projectId);
  const orgFloor = floorByClass(rules);
  const suggestions: PolicySuggestion[] = [];

  for (const def of ACTION_CLASSES) {
    const evidence = evidenceFor(window, def.code);
    const current = currentLevelFor(rules, def.code);
    const proposal = propose(def.code, current, evidence, orgFloor[def.code], options);
    if (proposal) {
      suggestions.push({
        ...proposal,
        projectId,
        actionClass: def.code,
        id: `${projectId}-${def.code}-${proposal.direction}`,
      });
    }
  }
  suggestions.push(...observePromotions(rules, window, projectId));
  return suggestions;
}

function withinDays(entryAt: string, at: string, days: number): boolean {
  const from = Date.parse(at) - days * 86_400_000;
  const value = Date.parse(entryAt);
  return Number.isFinite(value) && value >= from && value <= Date.parse(at);
}

/** Organisation floor per class: the strictest org rule wins. */
function floorByClass(rules: PolicyRule[]): Record<string, AutonomyLevel> {
  const floor: Record<string, AutonomyLevel> = {};
  for (const rule of rules) {
    if (rule.scope !== 'org') continue;
    const current = floor[rule.actionClass];
    if (current === undefined || rule.level < current) floor[rule.actionClass] = rule.level;
  }
  return floor;
}

/** Level in force for a class: strictest project rule, else catalogue default. */
function currentLevelFor(rules: PolicyRule[], actionClass: string): AutonomyLevel {
  const projectLevels = rules
    .filter((rule) => rule.scope === 'project' && rule.actionClass === actionClass)
    .map((rule) => rule.level);
  if (projectLevels.length === 0) return defaultLevelFor(actionClass);
  return projectLevels.reduce((worst, level) => (level < worst ? level : worst));
}

function evidenceFor(entries: LedgerEntry[], actionClass: string): SuggestionEvidence {
  const scoped = entries.filter((entry) => entry.actionClass === actionClass);
  const granted = scoped.filter((entry) => entry.kind === 'approval');
  const denied = scoped.filter((entry) => entry.kind === 'denial');
  const incidents = scoped.filter((entry) => entry.detail?.trustKind === 'incident');
  const deviations = scoped.filter((entry) => entry.kind === 'deviation');
  const requests = granted.length + denied.length;
  return {
    windowDays: 0,
    requests,
    granted: granted.length,
    denied: denied.length,
    grantRate: requests === 0 ? 0 : granted.length / requests,
    incidents: incidents.length,
    deviations: deviations.length,
    wouldHaveBlocked: 0,
    seqs: [...granted, ...denied, ...incidents, ...deviations].map((entry) => entry.seq).slice(0, 20),
  };
}

/** Decide what to propose for one class, guard rails included. */
function propose(
  actionClass: string,
  current: AutonomyLevel,
  evidence: SuggestionEvidence,
  orgFloor: AutonomyLevel | undefined,
  options: Required<Omit<SuggestionOptions, 'at'>>,
): Omit<PolicySuggestion, 'id' | 'projectId' | 'actionClass'> | undefined {
  if (isLockedClass(actionClass)) return undefined;
  const harden = evidence.incidents >= options.minIncidents || evidence.deviations >= options.minIncidents;
  if (harden) return hardening(current, evidence, options.days);
  const relaxable =
    !NEVER_RELAX.has(actionClass) &&
    evidence.requests >= options.minRequests &&
    evidence.grantRate >= options.minGrantRate &&
    evidence.incidents === 0 &&
    evidence.deviations === 0 &&
    current < 4;
  if (!relaxable) return undefined;
  const proposed = (current + 1) as AutonomyLevel;
  if (orgFloor !== undefined && proposed > orgFloor) return undefined;
  return {
    currentLevel: current,
    proposedLevel: proposed,
    proposedMode: 'enforce',
    direction: 'relax',
    evidence: { ...evidence, windowDays: options.days },
    risk: `Widens autonomy for ${actionClass}; ${evidence.requests} similar requests were granted without incident.`,
    status: 'proposal',
  };
}

/** Hardening always goes through observe mode first (spec §7.4). */
function hardening(
  current: AutonomyLevel,
  evidence: SuggestionEvidence,
  days: number,
): Omit<PolicySuggestion, 'id' | 'projectId' | 'actionClass'> {
  const proposed = (Math.max(0, current - 1)) as AutonomyLevel;
  return {
    currentLevel: current,
    proposedLevel: proposed,
    proposedMode: 'observe',
    direction: 'observe-first',
    evidence: { ...evidence, windowDays: days },
    risk: `${evidence.incidents} incident(s) and ${evidence.deviations} deviation(s) followed this class; observe for ${days} days before enforcing.`,
    status: 'proposal',
  };
}

/** Observe-mode rules whose report shows real impact may be enforced. */
function observePromotions(
  rules: PolicyRule[],
  window: LedgerEntry[],
  projectId: string,
): PolicySuggestion[] {
  const observation = summarize30DayObservation(window);
  return rules
    .filter((rule) => rule.mode === 'observe' && rule.scope === 'project')
    .filter((rule) => observation.wouldHaveBlocked > 0)
    .map((rule) => ({
      id: `${projectId}-${rule.actionClass}-enforce-observed`,
      projectId,
      actionClass: rule.actionClass,
      zoneId: rule.zoneId,
      currentLevel: rule.level,
      proposedLevel: rule.level,
      proposedMode: 'enforce' as RuleMode,
      direction: 'enforce-observed' as SuggestionDirection,
      evidence: {
        windowDays: 30,
        requests: observation.totalObserved,
        granted: 0,
        denied: 0,
        grantRate: 0,
        incidents: 0,
        deviations: 0,
        wouldHaveBlocked: observation.wouldHaveBlocked,
        seqs: [],
      },
      risk: `Observe mode would have blocked ${observation.wouldHaveBlocked} action(s); enforcing makes it real.`,
      status: 'proposal' as const,
    }));
}

export interface ApplyResult {
  ok: boolean;
  error?: 'CLASS_LOCKED' | 'MISSING_ACTOR';
  rule?: PolicyRule;
  entry?: LedgerEntry;
}

/** Apply one suggestion: write the rule, journal the change with its author. */
export async function applySuggestion(
  repos: Repositories,
  suggestion: PolicySuggestion,
  actor: string,
  opts: { at?: string } = {},
): Promise<ApplyResult> {
  if (!actor) return { ok: false, error: 'MISSING_ACTOR' };
  // An agent can never widen its own rights (spec §6): locked classes refuse.
  if (isLockedClass(suggestion.actionClass)) return { ok: false, error: 'CLASS_LOCKED' };
  const at = opts.at ?? new Date().toISOString();
  const rule: PolicyRule = {
    id: suggestion.id,
    scope: 'project',
    projectId: suggestion.projectId,
    actionClass: suggestion.actionClass,
    zoneId: suggestion.zoneId,
    level: suggestion.proposedLevel,
    mode: suggestion.proposedMode,
  };
  await repos.policies.upsertRule(rule);
  const prev = await repos.ledger.lastEntry(suggestion.projectId);
  const entry = makeEntry(
    {
      kind: 'policy-changed',
      projectId: suggestion.projectId,
      actionClass: suggestion.actionClass,
      ruleId: rule.id,
      decision: suggestion.direction,
      detail: {
        actor,
        from: suggestion.currentLevel,
        to: suggestion.proposedLevel,
        mode: suggestion.proposedMode,
        evidence: suggestion.evidence,
        risk: suggestion.risk,
      },
      at,
    },
    prev,
  );
  await repos.ledger.append(entry);
  return { ok: true, rule, entry };
}
