/**
 * Action requests, classification, and catalog definition.
 *
 * Represents what an agent wants to do (ActionRequest), how the system classifies it
 * (Classification, Confidence, ClassSuggester), and catalog definitions (ActionClassDef).
 */

import type { AutonomyLevel, Environment } from './levels';

/** One entry of the (project-extensible) action class catalog. */
export interface ActionClassDef {
  /** Stable code, e.g. "A-08". Custom classes use "X-<slug>". */
  code: string;
  nameEn: string;
  nameFr: string;
  /** Level applied when no rule matches (spec §7.2 rule 3). */
  defaultLevel: AutonomyLevel;
  /** Locked classes (A-15) can never be relaxed by an agent. */
  locked?: boolean;
}

/** What an agent is about to do (MCP `check-permission` / hook event). */
export interface ActionRequest {
  /** Missing ticket: refused above N4 (spec §20). */
  issueKey?: string;
  /** Class announced by the agent — never trusted blindly (spec §7.3). */
  declaredClass?: string;
  /** Exact target: file path, table name, command or free description. */
  target: string;
  /** Raw command text when the action is a shell/tool call. */
  command?: string;
  /** Free description; an LLM may propose a class from it. */
  description?: string;
  environment?: Environment;
  issueType?: string;
  hasAcceptanceCriteria?: boolean;
  incidentLinked?: boolean;
  /** ISO timestamp; defaults to now inside the pipeline. */
  at?: string;
  projectId?: string;
}

/** How the final class was obtained. */
export type ClassificationConfidence = 'deterministic' | 'model' | 'declared';

export interface Classification {
  /** Winning (most restrictive) class code. */
  actionClass: string;
  declaredClass?: string;
  /** True when the app overrode what the agent announced. */
  reclassified: boolean;
  /** Why: which pattern or model proposed the stricter class. */
  reason?: string;
  /** For composed commands: per-part classification (spec §20). */
  parts?: { text: string; actionClass: string; reason?: string }[];
  confidence: ClassificationConfidence;
}

/** Injectable LLM hook: free description -> candidate class codes. */
export type ClassSuggester = (description: string) => Promise<string[]>;

export interface ClassifyOptions {
  suggestClass?: ClassSuggester;
}
