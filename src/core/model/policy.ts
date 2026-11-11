/**
 * Policy rules, zones, contexts, and resolution contracts.
 *
 * Governs the policy matrix (class x zone x conditions -> level), resolution input/output,
 * explainability sources, and project-level settings.
 */

import type { AutonomyLevel, Environment } from './levels';
import type { ActionRequest, Classification } from './actions';

/** A zone is a place: path patterns, a component and/or an environment. */
export interface Zone {
  id: string;
  projectId: string;
  name: string;
  /** Glob patterns ("**\/migrations/**"). Empty = any path. */
  pathPatterns: string[];
  component?: string;
  environment?: Environment;
}

export type RuleScope = 'org' | 'project';

/** 'observe' = rule decides and journals but never blocks (spec §7.4). */
export type RuleMode = 'enforce' | 'observe';

/** Optional conditions narrowing when a rule applies (spec §7.1). */
export interface RuleConditions {
  environments?: Environment[];
  issueTypes?: string[];
  /** Inclusive start, exclusive end, local hours 0..23. */
  timeWindows?: { startHour: number; endHour: number; days?: number[] }[];
  /** When true, only applies while a change freeze is active. */
  freezeActive?: boolean;
  trustAbove?: number;
  trustBelow?: number;
  requiresAcceptanceCriteria?: boolean;
  /** Hotfix fast-path: ticket linked to an open incident (spec §20). */
  incidentLinked?: boolean;
}

/** One row of the policy grid: class x zone x conditions -> level. */
export interface PolicyRule {
  id: string;
  scope: RuleScope;
  /** Required when scope = 'project'; ignored for org rules. */
  projectId?: string;
  actionClass: string;
  /** Undefined = any zone of the project. */
  zoneId?: string;
  conditions?: RuleConditions;
  level: AutonomyLevel;
  mode: RuleMode;
  /** Role allowed to approve this class on this zone (spec §8.2). */
  approverRole?: string;
}

/** Everything the resolver needs to know about the current situation. */
export interface PolicyContext {
  action: ActionRequest;
  classification: Classification;
  environment?: Environment;
  issueType?: string;
  hasAcceptanceCriteria?: boolean;
  incidentLinked?: boolean;
  changeFreezeActive?: boolean;
  trustScore?: number;
  /** ISO timestamp used for time windows. */
  at: string;
}

export interface PolicyResolutionInput {
  context: PolicyContext;
  rules: PolicyRule[];
  zones: Zone[];
  killSwitchActive: boolean;
  /** Project setting: does trust capital bend levels? (spec §9) */
  trustEffectsEnabled: boolean;
  /**
   * Injectable trust adjustment (src/core/trust.ts) — keeps policy.ts free
   * of cross-module imports. When provided and a trust score is known, the
   * resolved level passes through it; a change is reported as 'trust-adjusted'.
   */
  adjustLevel?: (
    level: AutonomyLevel,
    score: number,
    actionClass: string,
  ) => AutonomyLevel;
}

/** Where the winning level came from (explainability, spec §19). */
export type LevelSource =
  | 'kill-switch'
  | 'project-rule'
  | 'org-floor'
  | 'class-default'
  | 'trust-adjusted';

export interface PolicyResolution {
  level: AutonomyLevel;
  /** The rule that produced the level, when any. */
  rule?: PolicyRule;
  source: LevelSource;
  /** Human-readable reason; always cites the applied rule (spec §19). */
  reason: string;
  /** True when the winning rule runs in observe mode. */
  observeOnly: boolean;
  /** Ids of every rule that matched, most restrictive first. */
  consideredRules: string[];
}

/** Project-level settings that bend the engine (all optional, safe defaults). */
export interface ProjectSettings {
  projectId: string;
  trustEffectsEnabled?: boolean;
  /** Default permit TTL chosen by approvers, minutes (default 120). */
  defaultPermitTtlMinutes?: number;
  /** Lifting the kill switch requires a different person (default true). */
  killSwitchRequiresDifferentPerson?: boolean;
  /** Refuse actions without a ticket above this level (default 4, spec §20). */
  maxLevelWithoutTicket?: AutonomyLevel;
}
