/**
 * Policy resolution (spec §7.2, §12, §19).
 *
 * From a classification + the project rule grid, produce ONE autonomy level
 * and a human-readable reason that always cites the rule that was applied.
 * Lower level = more restrictive: the most restrictive applicable rule wins.
 *
 * Order of resolution:
 *   1. kill switch (everything but reading is forbidden)
 *   2. applicable rules (class, scope, zone, conditions)
 *   3. project winner P / organisation winner O
 *   4. base level = P ? P.level : class default
 *      O more restrictive than base -> 'org-floor', else P -> 'project-rule',
 *      else the class default -> 'class-default'
 *   5. optional trust adjustment injected by the caller (never opened here)
 *   6. observe mode of the winning rule
 */
import {
  AutonomyLevel,
  LevelSource,
  PolicyContext,
  PolicyResolution,
  PolicyResolutionInput,
  PolicyRule,
  RuleConditions,
} from './types';
import { defaultLevelFor, isReadClass } from './catalog';
import { componentOf, ruleMatchesZone } from './zones';

const KILL_SWITCH_REASON = 'Emergency stop active: everything beyond reading is forbidden';

/**
 * True when the timestamp falls inside one of the windows.
 *
 * Deterministic by design: hours and days are read in UTC (`getUTCHours` /
 * `getUTCDay`) so the outcome never depends on the machine timezone.
 * A window is [startHour, endHour); a window whose end is before its start
 * wraps over midnight. Days: 0 = Sunday (JS convention).
 */
function timeWindowsMatch(
  windows: NonNullable<RuleConditions['timeWindows']>,
  at: string,
): boolean {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return false;
  const hour = date.getUTCHours();
  const day = date.getUTCDay();
  return windows.some((window) => {
    if (window.days && window.days.length > 0 && !window.days.includes(day)) return false;
    const { startHour, endHour } = window;
    if (startHour === endHour) return false;
    if (startHour < endHour) return hour >= startHour && hour < endHour;
    return hour >= startHour || hour < endHour; // window wrapping over midnight
  });
}

/**
 * Every condition that is set must hold. An unset condition never blocks.
 *
 * - environments / issueTypes: the context value must be listed.
 * - timeWindows: at least one window must contain the timestamp (UTC).
 * - freezeActive: compared to `ctx.changeFreezeActive` (unset == no freeze).
 * - trustAbove / trustBelow: strict comparison against `ctx.trustScore`;
 *   an unknown score never satisfies the condition.
 * - requiresAcceptanceCriteria / incidentLinked: only meaningful when true.
 */
export function conditionsMatch(
  conditions: RuleConditions | undefined,
  ctx: PolicyContext,
): boolean {
  if (!conditions) return true;
  if (Object.keys(conditions).length === 0) return true;
  if (
    conditions.environments &&
    (!ctx.environment || !conditions.environments.includes(ctx.environment))
  ) {
    return false;
  }
  if (
    conditions.issueTypes &&
    (!ctx.issueType || !conditions.issueTypes.includes(ctx.issueType))
  ) {
    return false;
  }
  if (
    conditions.timeWindows &&
    conditions.timeWindows.length > 0 &&
    !timeWindowsMatch(conditions.timeWindows, ctx.at)
  ) {
    return false;
  }
  if (
    conditions.freezeActive !== undefined &&
    conditions.freezeActive !== (ctx.changeFreezeActive === true)
  ) {
    return false;
  }
  if (conditions.trustAbove !== undefined || conditions.trustBelow !== undefined) {
    const score = ctx.trustScore;
    if (score === undefined) return false;
    if (conditions.trustAbove !== undefined && !(score > conditions.trustAbove)) return false;
    if (conditions.trustBelow !== undefined && !(score < conditions.trustBelow)) return false;
  }
  if (conditions.requiresAcceptanceCriteria === true && ctx.hasAcceptanceCriteria !== true) {
    return false;
  }
  if (conditions.incidentLinked === true && ctx.incidentLinked !== true) return false;
  return true;
}

/** True when the rule applies to the action: class, scope, zone and conditions. */
export function ruleApplies(rule: PolicyRule, input: PolicyResolutionInput): boolean {
  const ctx = input.context;
  if (rule.actionClass !== ctx.classification.actionClass) return false;
  if (rule.scope === 'project' && rule.projectId !== ctx.action.projectId) return false;
  if (!ruleMatchesZone(rule, input.zones, ctx.action, componentOf(ctx.action))) return false;
  return conditionsMatch(rule.conditions, ctx);
}

/** Number of condition keys declared by a rule (used as a tie-breaker). */
function conditionCount(rule: PolicyRule): number {
  return rule.conditions ? Object.keys(rule.conditions).length : 0;
}

/**
 * Strict ordering between two rules of the same scope.
 * Most restrictive level first; then the zone-scoped rule; then the rule with
 * the most conditions; then the alphabetically first id (deterministic).
 */
function isMoreRestrictive(a: PolicyRule, b: PolicyRule): boolean {
  if (a.level !== b.level) return a.level < b.level;
  const aZone = a.zoneId !== undefined;
  const bZone = b.zoneId !== undefined;
  if (aZone !== bZone) return aZone;
  const aConditions = conditionCount(a);
  const bConditions = conditionCount(b);
  if (aConditions !== bConditions) return aConditions > bConditions;
  return a.id < b.id;
}

/** The winning rule of a scope, or undefined when the scope has no match. */
function pickWinner(rules: PolicyRule[]): PolicyRule | undefined {
  let best: PolicyRule | undefined;
  for (const rule of rules) {
    if (!best || isMoreRestrictive(rule, best)) best = rule;
  }
  return best;
}

/** Reason line for the resolved level; always cites the rule or the default. */
function buildReason(
  source: LevelSource,
  level: AutonomyLevel,
  rule: PolicyRule | undefined,
  actionClass: string,
): string {
  if (source === 'project-rule' && rule) {
    return `Project rule ${rule.id} applied to ${actionClass}: level N${level}.`;
  }
  if (source === 'org-floor' && rule) {
    return `Organisation rule ${rule.id} applied as the floor for ${actionClass}: level N${level}.`;
  }
  return `No rule matched ${actionClass}: class default level N${level} applied.`;
}

/** Winner of the grid: the level, where it came from and the audit trail. */
interface Winner {
  level: AutonomyLevel;
  source: LevelSource;
  rule?: PolicyRule;
  consideredRules: string[];
}

/** Deterministic id comparison (no locale dependency). */
function compareId(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Steps 2-4: applicable rules, then project winner vs organisation floor. */
function selectWinner(input: PolicyResolutionInput): Winner {
  const actionClass = input.context.classification.actionClass;
  const applicable = input.rules.filter((rule) => ruleApplies(rule, input));
  const consideredRules = [...applicable]
    .sort((a, b) => a.level - b.level || compareId(a.id, b.id))
    .map((rule) => rule.id);

  const projectWinner = pickWinner(applicable.filter((rule) => rule.scope === 'project'));
  const orgWinner = pickWinner(applicable.filter((rule) => rule.scope === 'org'));
  const base: AutonomyLevel = projectWinner ? projectWinner.level : defaultLevelFor(actionClass);

  if (orgWinner && orgWinner.level < base) {
    return { level: orgWinner.level, source: 'org-floor', rule: orgWinner, consideredRules };
  }
  if (projectWinner) {
    return { level: projectWinner.level, source: 'project-rule', rule: projectWinner, consideredRules };
  }
  // No project rule applies. When an organisation rule covers the class and is
  // at least as strict as the catalogue default, cite it: "no rule matched"
  // would be wrong, and every refusal must name its rule (spec §19).
  if (orgWinner && orgWinner.level <= base) {
    return { level: orgWinner.level, source: 'org-floor', rule: orgWinner, consideredRules };
  }
  return { level: base, source: 'class-default', consideredRules };
}

/**
 * Step 5: the injected trust adjustment. It only *reports* what the caller
 * computed — this module never widens a level on its own.
 */
function applyTrust(
  winner: Winner,
  reason: string,
  input: PolicyResolutionInput,
): { level: AutonomyLevel; source: LevelSource; reason: string } {
  const score = input.context.trustScore;
  const adjust = input.adjustLevel;
  const unchanged = { level: winner.level, source: winner.source, reason };
  if (!input.trustEffectsEnabled || !adjust || score === undefined) return unchanged;
  const adjusted = adjust(winner.level, score, input.context.classification.actionClass);
  if (adjusted === winner.level) return unchanged;
  return {
    level: adjusted,
    source: 'trust-adjusted',
    reason: `${reason} Trust capital adjusted the level from N${winner.level} to N${adjusted} (score ${score}).`,
  };
}

/**
 * Resolve the autonomy level of an action.
 *
 * Never throws: an unknown rule set simply falls back to the class default.
 */
export function resolvePolicy(input: PolicyResolutionInput): PolicyResolution {
  const actionClass = input.context.classification.actionClass;

  if (input.killSwitchActive && !isReadClass(actionClass)) {
    return {
      level: 0,
      source: 'kill-switch',
      reason: KILL_SWITCH_REASON,
      observeOnly: false,
      consideredRules: [],
    };
  }

  const winner = selectWinner(input);
  const trusted = applyTrust(
    winner,
    buildReason(winner.source, winner.level, winner.rule, actionClass),
    input,
  );

  return {
    level: trusted.level,
    rule: winner.rule,
    source: trusted.source,
    reason: trusted.reason,
    observeOnly: winner.rule?.mode === 'observe',
    consideredRules: winner.consideredRules,
  };
}
