/**
 * Zone matching (spec §7.1).
 *
 * A zone is a *place*: a set of path globs, optionally narrowed by a
 * component and/or an environment. A zone matches an action only when every
 * constraint it declares is satisfied:
 *   - pathPatterns empty  -> any path matches
 *   - pathPatterns filled -> at least one glob matches action.target
 *   - component undefined -> any component matches
 *   - environment undefined -> any environment matches
 */
import { ActionRequest, PolicyRule, Zone } from './types';
import { pathMatches } from './glob';

/**
 * Resolve the component of an action.
 *
 * `ActionRequest` (frozen contract, src/core/types.ts) exposes no `component`
 * field, so the component is resolved in two steps:
 *   1. an optional runtime `component` field on the request, when the caller
 *      provides one (read defensively, the contract is never modified);
 *   2. otherwise the first segment of a path-like target
 *      ("api/src/users.ts" -> "api"), which is the usual monorepo layout a
 *      Jira component maps to.
 * Returns undefined when no component can be determined.
 */
export function componentOf(action: ActionRequest): string | undefined {
  const extra = (action as { component?: unknown }).component;
  if (typeof extra === 'string' && extra.length > 0) return extra;
  const target = (action.target ?? '').trim();
  const slash = target.indexOf('/');
  if (slash <= 0) return undefined;
  const head = target.slice(0, slash);
  if (head === '.' || head === '..' || /\s/.test(head)) return undefined;
  return head;
}

/** True when the zone's path constraint accepts the action target. */
function pathConstraintMatches(zone: Zone, action: ActionRequest): boolean {
  if (!zone.pathPatterns || zone.pathPatterns.length === 0) return true;
  return zone.pathPatterns.some((pattern) => pathMatches(pattern, action.target));
}

/** True when the zone's component and environment constraints accept the action. */
function scopeConstraintMatches(
  zone: Zone,
  action: ActionRequest,
  component?: string,
): boolean {
  if (zone.component !== undefined && zone.component !== component) return false;
  if (zone.environment !== undefined && zone.environment !== action.environment) return false;
  return true;
}

/** True when every constraint declared by the zone is satisfied by the action. */
export function zoneMatchesAction(
  zone: Zone,
  action: ActionRequest,
  component?: string,
): boolean {
  if (!pathConstraintMatches(zone, action)) return false;
  return scopeConstraintMatches(zone, action, component);
}

/** Every zone of the list matching the action. */
export function findMatchingZones(
  zones: Zone[],
  action: ActionRequest,
  component?: string,
): Zone[] {
  return zones.filter((zone) => zoneMatchesAction(zone, action, component));
}

/**
 * True when the rule is not zone-scoped, or when the zone it points to
 * exists in the same project and matches the action.
 * A rule pointing to an unknown zone never applies (fail closed).
 */
export function ruleMatchesZone(
  rule: PolicyRule,
  zones: Zone[],
  action: ActionRequest,
  component?: string,
): boolean {
  if (rule.zoneId === undefined) return true;
  const zone = zones.find(
    (candidate) => candidate.id === rule.zoneId && candidate.projectId === rule.projectId,
  );
  if (!zone) return false;
  return zoneMatchesAction(zone, action, component);
}
