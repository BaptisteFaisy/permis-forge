/**
 * Classification (spec §7.3, §20).
 *
 * The class announced by the agent is never trusted blindly: deterministic
 * patterns on the target and on the command decide, and the most restrictive
 * class wins. A model may only propose a class when nothing matched at all
 * (injected by the caller, offline-testable).
 */
import { ActionRequest, Classification, ClassifyOptions } from './types';
import { defaultLevelFor } from './catalog';

/** One deterministic pattern: what it matches, the class it implies, why. */
export interface PatternEntry {
  pattern: RegExp;
  actionClass: string;
  reason: string;
}

/** Patterns matched against the target path (or file name). */
export const TARGET_PATTERNS: PatternEntry[] = [
  { pattern: /(^|\/)migrations?\//i, actionClass: 'A-08', reason: 'target path points to a schema migration' },
  { pattern: /(^|\/)\.github\/workflows\//, actionClass: 'A-07', reason: 'target path points to a CI workflow' },
  { pattern: /Jenkinsfile/, actionClass: 'A-07', reason: 'target is a CI pipeline definition' },
  { pattern: /\.gitlab-ci\.yml/, actionClass: 'A-07', reason: 'target is a CI pipeline definition' },
  { pattern: /azure-pipelines/, actionClass: 'A-07', reason: 'target is a CI pipeline definition' },
  { pattern: /(^|\/)(terraform|infra|k8s|kubernetes|helm)\//, actionClass: 'A-11', reason: 'target path points to infrastructure' },
  { pattern: /\.tf$/, actionClass: 'A-11', reason: 'target is an infrastructure definition' },
  { pattern: /(^|\/)\.env($|\.)/, actionClass: 'A-10', reason: 'target is an environment file holding secrets' },
  { pattern: /(^|\/)secrets?\//, actionClass: 'A-10', reason: 'target path points to secrets' },
  { pattern: /\.pem$/, actionClass: 'A-10', reason: 'target is a private key file' },
  { pattern: /id_rsa/, actionClass: 'A-10', reason: 'target is a private key file' },
  { pattern: /credentials\.json/, actionClass: 'A-10', reason: 'target holds credentials' },
  { pattern: /AGENTS\.md/, actionClass: 'A-15', reason: 'target is the agent policy file' },
  { pattern: /CLAUDE\.md/, actionClass: 'A-15', reason: 'target is the agent policy file' },
  { pattern: /\.claude\/settings/, actionClass: 'A-15', reason: 'target is the agent settings file' },
  { pattern: /hooks?\.json/, actionClass: 'A-15', reason: 'target holds agent hooks' },
  { pattern: /\.cursorrules/, actionClass: 'A-15', reason: 'target is the agent policy file' },
  { pattern: /(^|\/)(tests?|__tests__|specs?)\//, actionClass: 'A-03', reason: 'target path points to a test' },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, actionClass: 'A-03', reason: 'target is a test file' },
  { pattern: /package-lock\.json/, actionClass: 'A-05', reason: 'target is a dependency lock file' },
  { pattern: /yarn\.lock/, actionClass: 'A-05', reason: 'target is a dependency lock file' },
  { pattern: /pnpm-lock\.yaml/, actionClass: 'A-05', reason: 'target is a dependency lock file' },
  { pattern: /(^|\/)package\.json$/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /requirements.*\.txt$/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /Pipfile/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /poetry\.lock/, actionClass: 'A-05', reason: 'target is a dependency lock file' },
  { pattern: /Cargo\.(toml|lock)$/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /go\.(mod|sum)$/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /pom\.xml$/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
  { pattern: /build\.gradle/, actionClass: 'A-05', reason: 'target is a dependency manifest' },
];

/** Patterns matched against a command line. */
export const COMMAND_PATTERNS: PatternEntry[] = [
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, actionClass: 'A-09', reason: 'command drops a database object' },
  { pattern: /\bDELETE\s+FROM\b/i, actionClass: 'A-09', reason: 'command deletes rows' },
  { pattern: /\bTRUNCATE\s+TABLE\b/i, actionClass: 'A-09', reason: 'command truncates a table' },
  { pattern: /\bUPDATE\s+\S+\s+SET\b/i, actionClass: 'A-09', reason: 'command updates rows' },
  { pattern: /git\s+push\b[^|;&]*(-{2}force\b|-f\b|-{2}delete\b)/, actionClass: 'A-12', reason: 'command force-pushes or deletes a remote branch' },
  { pattern: /git\s+branch\s+-D\b/, actionClass: 'A-12', reason: 'command force-deletes a branch' },
  { pattern: /git\s+reset\s+--hard\b/, actionClass: 'A-12', reason: 'command discards local work' },
  { pattern: /git\s+clean\s+-[a-z]*f/i, actionClass: 'A-12', reason: 'command deletes untracked files' },
  { pattern: /\brm\s+-[a-z]*[rf]/i, actionClass: 'A-09', reason: 'command deletes files recursively or forcibly' },
  { pattern: /it\.skip|describe\.skip|test\.skip|\bxit\(|\bxdescribe\(|@Disabled|@Ignore|pytest\.mark\.skip|#\[ignore\]/i, actionClass: 'A-04', reason: 'command disables a test' },
  { pattern: /\brm\b[^|;&]*\b(test|spec)\b[^|;&]*/i, actionClass: 'A-04', reason: 'command removes a test file' },
  { pattern: /\bgit\s+rm\b[^|;&]*\b(test|spec)\b[^|;&]*/i, actionClass: 'A-04', reason: 'command removes a test file' },
  { pattern: /\b(curl|wget)\b[^|;&]*https?:\/\//i, actionClass: 'A-14', reason: 'command sends data to an external host' },
  { pattern: /gh\s+secret\b/, actionClass: 'A-10', reason: 'command touches a secret' },
  { pattern: /kubectl\s+create\s+secret/, actionClass: 'A-10', reason: 'command creates a secret' },
  { pattern: /aws\s+secretsmanager/, actionClass: 'A-10', reason: 'command touches a secret' },
  { pattern: /vault\s+(kv|read|write)/i, actionClass: 'A-10', reason: 'command touches a secret' },
  { pattern: /kubectl\b[^|;&]*--context[= ]\S*prod/i, actionClass: 'A-13', reason: 'command targets a production environment' },
  { pattern: /-e\s+production\b/, actionClass: 'A-13', reason: 'command targets a production environment' },
  { pattern: /NODE_ENV=production/, actionClass: 'A-13', reason: 'command targets a production environment' },
  { pattern: /\bdeploy\b[^|;&]*\bprod\b/i, actionClass: 'A-13', reason: 'command deploys to production' },
  { pattern: /\b(npm|yarn|pnpm)\s+(install|add)\b/, actionClass: 'A-05', reason: 'command adds a dependency' },
  { pattern: /\bpip3?\s+install\b/, actionClass: 'A-05', reason: 'command adds a dependency' },
  { pattern: /\bcargo\s+add\b/, actionClass: 'A-05', reason: 'command adds a dependency' },
  { pattern: /\bgo\s+get\b/, actionClass: 'A-05', reason: 'command adds a dependency' },
  { pattern: /terraform\s+(apply|destroy)/, actionClass: 'A-11', reason: 'command changes infrastructure' },
  { pattern: /kubectl\s+(apply|delete)/, actionClass: 'A-11', reason: 'command changes infrastructure' },
  // Access-control changes: making a path world-writable, or moving its owner,
  // is how a secret stops being protected. Narrow on purpose — an ordinary
  // `chmod 644 build/x` is not an incident.
  { pattern: /\bchmod\b[^|;&]*(\b[0-7]*777\b|\ba\+rwx\b|-[a-z]*R[^|;&]*\b777\b)/i, actionClass: 'A-10', reason: 'command makes a path world-readable and world-writable' },
  { pattern: /\b(chown|chgrp|setfacl)\b/, actionClass: 'A-10', reason: 'command changes who owns or may access a path' },
  { pattern: /\b(useradd|usermod|userdel|passwd|groupadd)\b/, actionClass: 'A-10', reason: 'command changes accounts or credentials' },
];

const FALLBACK_CLASS = 'A-02';
const FALLBACK_REASON = 'no sensitive pattern matched; treated as application code edit';
const MODEL_REASON = 'model-proposed class; most restrictive candidate retained';
const VAGUE_REASON = 'vague target classified to the most restrictive plausible class (spec §20)';
const COMPOSED_SUFFIX = 'composed command: most restrictive part wins';
const VAGUE_KEYWORDS = /base|database|db|données|data|purge|nettoy|clean/i;

/** Tie-break ranks: the lower the number, the earlier the pattern in its table. */
const TARGET_ORDER_BASE = 0;
const COMMAND_ORDER_BASE = 100;
const PART_ORDER_BASE = 1000;
const PART_ORDER_STEP = 100;

/** A class obtained from a pattern, with its provenance for tie-breaking. */
interface PatternHit {
  actionClass: string;
  reason: string;
  order: number;
  source: 'target' | 'command' | 'part';
}

/**
 * Split a command on `&&`, `||`, `;`, `|` and newlines, ignoring separators
 * inside quotes ('…', "…", `…`). Parts are trimmed, empty parts dropped.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '\n') {
      parts.push(current);
      current = '';
      continue;
    }
    const next = command[i + 1];
    if ((char === '&' && next === '&') || (char === '|' && next === '|')) {
      parts.push(current);
      current = '';
      i += 1;
      continue;
    }
    if (char === ';' || char === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** All entries of a table matching the text, in table order. */
function matchPatterns(
  table: PatternEntry[],
  text: string,
  startOrder: number,
  source: PatternHit['source'],
): PatternHit[] {
  const found: PatternHit[] = [];
  table.forEach((entry, index) => {
    if (entry.pattern.test(text)) {
      found.push({ actionClass: entry.actionClass, reason: entry.reason, order: startOrder + index, source });
    }
  });
  return found;
}

/** The most restrictive hit; ties are broken by table order. */
function pickMostRestrictive(hits: PatternHit[]): PatternHit | undefined {
  let best: PatternHit | undefined;
  for (const hit of hits) {
    if (!best) {
      best = hit;
      continue;
    }
    const bestLevel = defaultLevelFor(best.actionClass);
    const hitLevel = defaultLevelFor(hit.actionClass);
    if (hitLevel < bestLevel || (hitLevel === bestLevel && hit.order < best.order)) {
      best = hit;
    }
  }
  return best;
}

/** True when the text looks like a shell command rather than a file path. */
function looksLikeCommand(text: string): boolean {
  const trimmed = text.trim();
  if (!/\s/.test(trimmed)) return false;
  return /^[a-z][a-z0-9_.-]*\b/i.test(trimmed);
}

/** Classify one part of a composed command (command patterns, then target ones). */
function classifyPart(text: string, index: number): { actionClass: string; reason: string; hit?: PatternHit } {
  const base = PART_ORDER_BASE + index * PART_ORDER_STEP;
  const hits = [
    ...matchPatterns(COMMAND_PATTERNS, text, base, 'part'),
    ...matchPatterns(TARGET_PATTERNS, text, base + PART_ORDER_STEP / 2, 'part'),
  ];
  const best = pickMostRestrictive(hits);
  if (best) return { actionClass: best.actionClass, reason: best.reason, hit: best };
  return { actionClass: FALLBACK_CLASS, reason: FALLBACK_REASON };
}

/** The command text to analyse: the explicit command, or a target that looks like one. */
function commandTextOf(action: ActionRequest): string | undefined {
  const command = (action.command ?? '').trim();
  if (command.length > 0) return command;
  return looksLikeCommand(action.target) ? action.target : undefined;
}

/** True when the target is too vague to classify safely (spec §20). */
function isVagueTarget(target: string): boolean {
  if (target.includes('/')) return false;
  return VAGUE_KEYWORDS.test(target);
}

/**
 * Ask the injected model for candidate classes (offline: the caller provides
 * the implementation). Returns undefined when there is nothing to ask or when
 * no candidate comes back.
 */
async function proposeClass(
  action: ActionRequest,
  opts?: ClassifyOptions,
): Promise<string | undefined> {
  const description = (action.description ?? '').trim();
  if (!opts?.suggestClass || description.length === 0) return undefined;
  const suggestions = await opts.suggestClass(description);
  const candidates = (suggestions ?? []).filter((code) => typeof code === 'string' && code.trim().length > 0);
  if (candidates.length === 0) return undefined;
  let best = candidates[0].trim();
  for (const candidate of candidates.slice(1)) {
    const code = candidate.trim();
    if (defaultLevelFor(code) < defaultLevelFor(best)) best = code;
  }
  return best;
}

/** Everything the deterministic pass collected for one action. */
interface Collected {
  hits: PatternHit[];
  parts: NonNullable<Classification['parts']>;
}

/** Outcome of the classification decision (class, why, how it was obtained). */
interface Outcome {
  actionClass: string;
  reason: string;
  confidence: Classification['confidence'];
}

/** Step 1: collect every deterministic hit from the target and the command. */
function collectHits(action: ActionRequest): Collected {
  const hits: PatternHit[] = matchPatterns(TARGET_PATTERNS, action.target, TARGET_ORDER_BASE, 'target');
  const parts: NonNullable<Classification['parts']> = [];
  const commandText = commandTextOf(action);
  if (commandText === undefined) return { hits, parts };

  const split = splitCommand(commandText);
  if (split.length < 2) {
    hits.push(...matchPatterns(COMMAND_PATTERNS, commandText, COMMAND_ORDER_BASE, 'command'));
    return { hits, parts };
  }
  split.forEach((text, index) => {
    const result = classifyPart(text, index);
    parts.push({ text, actionClass: result.actionClass, reason: result.reason });
    if (result.hit) hits.push(result.hit);
  });
  return { hits, parts };
}

/** Step 2: a pattern wins unless the declared class is strictly more restrictive. */
function outcomeFromHits(best: PatternHit | undefined, declared: string | undefined): Outcome | undefined {
  const declaredLevel = declared ? defaultLevelFor(declared) : undefined;
  if (best && (declaredLevel === undefined || defaultLevelFor(best.actionClass) <= declaredLevel)) {
    const reason = best.source === 'part' ? `${best.reason} (${COMPOSED_SUFFIX})` : best.reason;
    return { actionClass: best.actionClass, reason, confidence: 'deterministic' };
  }
  if (!declared) return undefined;
  return {
    actionClass: declared,
    confidence: 'declared',
    reason: best
      ? `Declared class ${declared} kept: it is more restrictive than the matched pattern (${best.actionClass}).`
      : `Declared class ${declared} retained: no pattern matched.`,
  };
}

/** Steps 3-4: model suggestion, then vague target, then the code-edit fallback. */
async function outcomeWithoutHits(action: ActionRequest, opts?: ClassifyOptions): Promise<Outcome> {
  const suggested = await proposeClass(action, opts);
  if (suggested) return { actionClass: suggested, reason: MODEL_REASON, confidence: 'model' };
  if (isVagueTarget(action.target)) {
    return { actionClass: 'A-09', reason: VAGUE_REASON, confidence: 'deterministic' };
  }
  return { actionClass: FALLBACK_CLASS, reason: FALLBACK_REASON, confidence: 'deterministic' };
}

/**
 * Classify an action.
 *
 * Deterministic patterns first (target + command, part by part for composed
 * commands), then the declared class as a candidate, then — only when nothing
 * matched at all — the optional model hook.
 */
export async function classifyAction(
  action: ActionRequest,
  opts?: ClassifyOptions,
): Promise<Classification> {
  const raw = action.declaredClass;
  const declared = raw && raw.trim().length > 0 ? raw.trim() : undefined;
  const { hits, parts } = collectHits(action);
  const outcome =
    outcomeFromHits(pickMostRestrictive(hits), declared) ??
    (await outcomeWithoutHits(action, opts));

  return {
    actionClass: outcome.actionClass,
    declaredClass: raw,
    reclassified: declared !== undefined && declared !== outcome.actionClass,
    reason: outcome.reason,
    parts: parts.length > 0 ? parts : undefined,
    confidence: outcome.confidence,
  };
}
