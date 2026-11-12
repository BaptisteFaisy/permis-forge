/**
 * Policy linter — find the contradictions in a hand-written policy before an
 * agent runs into them.
 *
 * A policy of forty rules written by hand is wrong in ways nobody notices:
 * a rule shadowed by a stricter one on the same class and zone (it can never
 * apply), a zone no rule refers to (a typo, or dead weight), a project rule
 * softer than the organisation floor (which the resolver would silently
 * overrule). None of these is a runtime error, so nothing reports them — until
 * a developer wonders why a rule they wrote has no effect.
 *
 * Pure module: no Atlassian SDK, no storage. The caller passes the rules and
 * zones; the linter returns findings.
 */
import { ACTION_CLASSES, defaultLevelFor, isLockedClass } from '../core/catalog';
import { targetCovers } from '../core/glob';
import { PolicyRule, Zone } from '../core/types';

export type LintSeverity = 'error' | 'warning' | 'info';

export type LintCode =
  | 'CLASS_WITHOUT_RULE'
  | 'UNREACHABLE_RULE'
  | 'DUPLICATE_RULE'
  | 'SOFTER_THAN_FLOOR'
  | 'ZONE_WITHOUT_RULE'
  | 'OVERLAPPING_ZONES'
  | 'OBSERVE_TOO_LONG';

export interface PolicyFinding {
  code: LintCode;
  severity: LintSeverity;
  actionClass?: string;
  zoneId?: string;
  ruleId?: string;
  /** What is wrong, in one sentence. */
  message: string;
  /** What to do about it, in one sentence. */
  suggestion: string;
}

export interface LintInput {
  projectId: string;
  rules: PolicyRule[];
  zones: Zone[];
  /**
   * When each rule entered observe mode, by rule id. Optional: the policy rows
   * carry no timestamp, so the caller derives it from the `policy-changed`
   * ledger entries. Without it, OBSERVE_TOO_LONG is simply not reported.
   */
  observeSince?: Record<string, string>;
  now?: string;
}

/** Days a rule may stay in observation before the linter asks about it. */
const OBSERVE_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;

/** Rules of the project, plus the organisation rules that floor it. */
function splitScopes(rules: PolicyRule[], projectId: string) {
  const project = rules.filter((rule) => rule.scope === 'project' && rule.projectId === projectId);
  const org = rules.filter((rule) => rule.scope === 'org');
  return { project, org };
}

/** The strictest level an organisation rule imposes on a class. */
function orgFloorByClass(org: PolicyRule[]): Map<string, number> {
  const floor = new Map<string, number>();
  for (const rule of org) {
    const current = floor.get(rule.actionClass);
    if (current === undefined || rule.level < current) floor.set(rule.actionClass, rule.level);
  }
  return floor;
}

/** Two rules compete when they cover the same class and the same zone space. */
function sameZone(rule: PolicyRule, other: PolicyRule): boolean {
  return rule.zoneId === other.zoneId;
}

/**
 * A rule is unreachable when a stricter rule competes with it: among the
 * applicable rules the most restrictive wins (spec §7.2), so the looser one can
 * never produce a decision.
 */
function unreachableFindings(project: PolicyRule[]): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const rule of project) {
    const shadow = project.find(
      (other) =>
        other.id !== rule.id &&
        other.actionClass === rule.actionClass &&
        sameZone(rule, other) &&
        other.level < rule.level,
    );
    if (shadow) {
      findings.push({
        code: 'UNREACHABLE_RULE',
        severity: 'warning',
        actionClass: rule.actionClass,
        zoneId: rule.zoneId,
        ruleId: rule.id,
        message: `Rule ${rule.id} (N${rule.level}) is shadowed by ${shadow.id} (N${shadow.level}) on the same class and zone: the most restrictive wins, so it can never apply.`,
        suggestion: `Delete ${rule.id}, or narrow its zone so the two no longer compete.`,
      });
    }
  }
  return findings;
}

/** Two rules on the same class, zone and mode: one of them is noise. */
function duplicateFindings(project: PolicyRule[]): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const seen = new Set<string>();
  for (const rule of project) {
    const key = `${rule.actionClass}|${rule.zoneId ?? ''}|${rule.mode}`;
    const twin = project.find(
      (other) => other.id !== rule.id && `${other.actionClass}|${other.zoneId ?? ''}|${other.mode}` === key,
    );
    if (twin && !seen.has(key)) {
      seen.add(key);
      findings.push({
        code: 'DUPLICATE_RULE',
        severity: 'warning',
        actionClass: rule.actionClass,
        zoneId: rule.zoneId,
        ruleId: rule.id,
        message: `Rules ${rule.id} and ${twin.id} both cover ${rule.actionClass} on the same zone in ${rule.mode} mode, at levels N${rule.level} and N${twin.level}.`,
        suggestion: 'Keep one: the stricter level is the one that applies anyway.',
      });
    }
  }
  return findings;
}

/**
 * A project rule softer than the organisation floor. The resolver overrules it,
 * so this is not a policy choice but a mistake — reported as an error.
 */
function floorFindings(project: PolicyRule[], org: PolicyRule[]): PolicyFinding[] {
  const floor = orgFloorByClass(org);
  const findings: PolicyFinding[] = [];
  for (const rule of project) {
    const minimum = floor.get(rule.actionClass);
    if (minimum !== undefined && rule.level > minimum) {
      findings.push({
        code: 'SOFTER_THAN_FLOOR',
        severity: 'error',
        actionClass: rule.actionClass,
        zoneId: rule.zoneId,
        ruleId: rule.id,
        message: `Rule ${rule.id} sets N${rule.level} for ${rule.actionClass}, but the organisation floor is N${minimum}: the floor wins and this rule never applies.`,
        suggestion: `Raise it to N${minimum} at most, or delete it — a project may harden the floor, never soften it.`,
      });
    }
  }
  return findings;
}

/** A class nobody wrote a rule for falls back to its catalogue default. */
function missingClassFindings(project: PolicyRule[], org: PolicyRule[]): PolicyFinding[] {
  const covered = new Set([...project, ...org].map((rule) => rule.actionClass));
  return ACTION_CLASSES.filter((entry) => !covered.has(entry.code)).map((entry) => ({
    code: 'CLASS_WITHOUT_RULE' as LintCode,
    severity: (isLockedClass(entry.code) ? 'info' : 'warning') as LintSeverity,
    actionClass: entry.code,
    message: `No rule covers ${entry.code} (${entry.nameEn}): it resolves to the catalogue default N${defaultLevelFor(entry.code)}.`,
    suggestion: isLockedClass(entry.code)
      ? 'Nothing to do: a locked class stays forbidden whatever the policy says.'
      : 'Write an explicit rule if the default is not what this project wants.',
  }));
}

/** A zone no rule refers to: a typo, or dead weight in the settings screen. */
function unusedZoneFindings(project: PolicyRule[], zones: Zone[]): PolicyFinding[] {
  const used = new Set(project.map((rule) => rule.zoneId).filter((id): id is string => Boolean(id)));
  return zones
    .filter((zone) => !used.has(zone.id))
    .map((zone) => ({
      code: 'ZONE_WITHOUT_RULE' as LintCode,
      severity: 'info' as LintSeverity,
      zoneId: zone.id,
      message: `Zone "${zone.name}" is referenced by no rule.`,
      suggestion: 'Attach a rule to it, or delete it: an unused zone still shows up in the grid.',
    }));
}

/**
 * Two zones whose patterns nest, with different levels for the same class: the
 * resolver picks the strictest, which surprises whoever wrote the softer one.
 */
function overlapFindings(project: PolicyRule[], zones: Zone[]): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const overlap = zonesOverlap(zones[i], zones[j]);
      if (!overlap) continue;
      const conflicting = project.filter(
        (rule) =>
          (rule.zoneId === zones[i].id || rule.zoneId === zones[j].id) &&
          project.some(
            (other) =>
              other.actionClass === rule.actionClass &&
              other.zoneId !== rule.zoneId &&
              (other.zoneId === zones[i].id || other.zoneId === zones[j].id) &&
              other.level !== rule.level,
          ),
      );
      for (const rule of conflicting) {
        findings.push({
          code: 'OVERLAPPING_ZONES',
          severity: 'warning',
          actionClass: rule.actionClass,
          zoneId: rule.zoneId,
          ruleId: rule.id,
          message: `Zones "${zones[i].name}" and "${zones[j].name}" overlap, and ${rule.actionClass} is set to different levels in each: on a path in both, the stricter one wins.`,
          suggestion: 'Make the zones disjoint, or align the levels for this class.',
        });
      }
    }
  }
  return dedupeByRule(findings, 'OVERLAPPING_ZONES');
}

/** One zone's patterns nest inside the other's, in either direction. */
function zonesOverlap(a: Zone, b: Zone): boolean {
  if (a.pathPatterns.length === 0 || b.pathPatterns.length === 0) return true;
  return a.pathPatterns.some((pattern) => b.pathPatterns.some((other) => covers(pattern, other) || covers(other, pattern)));
}

/** Pattern containment, via the same predicate the resolver uses. */
function covers(pattern: string, other: string): boolean {
  return targetCovers(pattern, other);
}

/** A rule left in observation past the window is a decision being postponed. */
function observeFindings(project: PolicyRule[], input: LintInput): PolicyFinding[] {
  if (!input.observeSince) return [];
  const now = Date.parse(input.now ?? new Date().toISOString());
  if (!Number.isFinite(now)) return [];
  return project
    .filter((rule) => rule.mode === 'observe')
    .map((rule) => ({ rule, since: Date.parse(input.observeSince?.[rule.id] ?? '') }))
    .filter((item) => Number.isFinite(item.since) && now - item.since > OBSERVE_WINDOW_DAYS * DAY_MS)
    .map(({ rule, since }) => ({
      code: 'OBSERVE_TOO_LONG' as LintCode,
      severity: 'info' as LintSeverity,
      actionClass: rule.actionClass,
      zoneId: rule.zoneId,
      ruleId: rule.id,
      message: `Rule ${rule.id} has been in observation mode for ${Math.floor((now - since) / DAY_MS)} days without blocking anything.`,
      suggestion: 'Promote it to enforce, or delete it: an observation nobody reads is only noise in the ledger.',
    }));
}

/** Keep one finding per rule and code: overlaps are reported once per rule. */
function dedupeByRule(findings: PolicyFinding[], code: LintCode): PolicyFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (finding.code !== code) return true;
    const key = `${finding.ruleId ?? ''}|${finding.actionClass ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Lint a project's policy. Findings are ordered by severity, then by class, so
 * the settings screen can show the errors first.
 */
export function lintPolicy(input: LintInput): PolicyFinding[] {
  const { project, org } = splitScopes(input.rules, input.projectId);
  const findings: PolicyFinding[] = [
    ...floorFindings(project, org),
    ...unreachableFindings(project),
    ...duplicateFindings(project),
    ...overlapFindings(project, input.zones),
    ...missingClassFindings(project, org),
    ...unusedZoneFindings(project, input.zones),
    ...observeFindings(project, input),
  ];
  const rank: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      String(a.actionClass).localeCompare(String(b.actionClass)) ||
      String(a.code).localeCompare(String(b.code)),
  );
}

/** Counts by severity, for a one-line summary on the settings screen. */
export function summarizeFindings(findings: PolicyFinding[]): Record<LintSeverity, number> {
  const summary: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}
