/**
 * Claude Code PreToolUse hook adapter (spec §10).
 *
 * Maps incoming hook tool calls to ActionRequest payloads, converts resolved
 * autonomy levels into hook decisions (allow / ask / deny), and generates
 * the `.claude/settings.json` HTTP hook configuration and response body.
 */
import {
  ActionRequest,
  AutonomyLevel,
  HookDecision,
  HookEvent,
  HookFile,
  HookFileEntry,
} from './types';

const BASH_TOOLS = new Set(['bash', 'shell', 'bashoutput']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls']);

const DEFAULT_TOKEN_ENV_VAR = 'PERMIS_AGENT_TOKEN';
const DEFAULT_ISSUE_ENV_VAR = 'PERMIS_AGENT_ISSUE';
const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MATCHERS = ['Bash|Edit|Write|MultiEdit'];
/** Where the command bridge lives, for the clients without a native HTTP hook. */
const DEFAULT_BRIDGE_PATH = '.cursor/hooks/gate-bridge.sh';
const DEFAULT_BRIDGE_TIMEOUT_SECONDS = 15;
/** Cursor's matcher syntax differs from Claude Code's: `Shell`, not `Bash`. */
const DEFAULT_CURSOR_MATCHERS = ['Shell|Write|Read'];
const MAX_DESCRIPTION_LENGTH = 200;

export interface MapHookOptions {
  projectKey?: string;
  issueKey?: string;
}

export interface GateDecisionOptions {
  hasValidPermit: boolean;
  observeOnly?: boolean;
}

export interface GateDecisionResult {
  decision: HookDecision;
  log: boolean;
  reason?: string;
}

export interface BuildHookFileOptions {
  gateUrl: string;
  tokenEnvVar?: string;
  issueEnvVar?: string;
  timeoutSeconds?: number;
  matchers?: string[];
}

export interface GateResponseInput {
  decision: HookDecision;
  reason: string;
  requestId?: string;
  level?: AutonomyLevel;
}

function coerceString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '';
  }
}

function safeJsonTruncate(value: unknown, maxLength: number): string {
  try {
    const serialized = JSON.stringify(value ?? {});
    return (serialized ?? '{}').slice(0, maxLength);
  } catch {
    return '';
  }
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    if (args[key] !== undefined && args[key] !== null) {
      return coerceString(args[key]);
    }
  }
  return '';
}

/** Convert a Claude Code PreToolUse hook event into an ActionRequest. */
export function mapHookEventToAction(
  event: HookEvent,
  opts?: MapHookOptions,
): ActionRequest {
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  const toolName = coerceString(event.toolName);
  const normalized = toolName.toLowerCase();
  const base = { projectId: opts?.projectKey, issueKey: opts?.issueKey };

  if (BASH_TOOLS.has(normalized)) {
    const command = firstString(args, ['command']);
    return { ...base, target: command, command };
  }
  if (EDIT_TOOLS.has(normalized)) {
    const target = firstString(args, ['file_path', 'path', 'notebook_path']);
    return { ...base, target };
  }
  if (READ_TOOLS.has(normalized)) {
    const target = firstString(args, ['file_path', 'path', 'pattern']);
    return { ...base, declaredClass: 'A-01', target };
  }
  // Unknown or malformed tool name: never assume it is harmless. A client that
  // sends a non-string `toolName` (a bridge bug, a new tool, a hostile payload)
  // must not turn a `rm -rf` into a read — so the arguments still decide what
  // the action is, exactly as they do for a known tool.
  const command = firstString(args, ['command', 'cmd', 'script']);
  const path = firstString(args, ['file_path', 'path', 'notebook_path', 'pattern']);
  return {
    ...base,
    target: command || path || toolName,
    command,
    description: safeJsonTruncate(args, MAX_DESCRIPTION_LENGTH),
  };
}

function baseGateDecision(
  level: AutonomyLevel,
  hasValidPermit: boolean,
): GateDecisionResult {
  if (level === 5) return { decision: 'allow', log: false };
  if (level === 4) return { decision: 'allow', log: true };
  if (level === 3) return { decision: 'ask', log: true };
  if (level === 0) {
    return { decision: 'deny', log: true, reason: 'forbidden by policy' };
  }
  if (hasValidPermit) return { decision: 'allow', log: true };
  return {
    decision: 'deny',
    log: true,
    reason: 'no valid permit covers this action',
  };
}

/** Map an autonomy level and permit status to a PreToolUse hook decision. */
export function gateDecisionFor(
  level: AutonomyLevel,
  opts: GateDecisionOptions,
): GateDecisionResult {
  const base = baseGateDecision(level, opts.hasValidPermit);
  if (!opts.observeOnly) return base;
  return {
    decision: 'allow',
    log: true,
    reason: `observe mode: would have been ${base.decision}`,
  };
}

/** Build the Claude Code settings hook configuration for the gate endpoint. */
export function buildHookFile(opts: BuildHookFileOptions): HookFile {
  const tokenEnvVar = opts.tokenEnvVar ?? DEFAULT_TOKEN_ENV_VAR;
  const issueEnvVar = opts.issueEnvVar ?? DEFAULT_ISSUE_ENV_VAR;
  const timeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const matchers = opts.matchers ?? DEFAULT_MATCHERS;
  // The ticket does not come from the client payload: the hook names it in the
  // X-Permis-Issue header, read from the environment. Without it, actions beyond
  // N4 are refused (spec §20) — a silent "no ticket" is safer than guessing one.
  const httpHook: HookFileEntry = {
    type: 'http',
    url: opts.gateUrl,
    timeout,
    onFailure: 'block',
    headers: {
      Authorization: `Bearer $${tokenEnvVar}`,
      'X-Permis-Issue': `$${issueEnvVar}`,
    },
    allowedEnvVars: [tokenEnvVar, issueEnvVar],
  };

  return {
    hooks: {
      PreToolUse: matchers.map((matcher) => ({
        matcher,
        hooks: [httpHook],
      })),
      // The same URL, after the tool ran: the action is declared without the
      // agent's cooperation, so drift detection has something to compare the
      // observed changes with. A PostToolUse hook cannot undo anything, so it
      // never blocks — but it authenticates the same way.
      PostToolUse: matchers.map((matcher) => ({
        matcher,
        hooks: [httpHook],
      })),
    },
  };
}

/** Clients whose hook configuration this app can generate. */
export type HookClient = 'claude-code' | 'cursor';

export interface HookClientOptions extends BuildHookFileOptions {
  /** Path of the command bridge, for the clients without a native HTTP hook. */
  bridgePath?: string;
}

/**
 * The Cursor configuration: the same gate, reached through the command
 * bridge, because Cursor documents command and prompt hooks, not the HTTP type.
 */
export function buildCursorHookFile(opts: HookClientOptions): Record<string, unknown> {
  const bridgePath = opts.bridgePath ?? DEFAULT_BRIDGE_PATH;
  const timeout = opts.timeoutSeconds ?? DEFAULT_BRIDGE_TIMEOUT_SECONDS;
  const matchers = opts.matchers ?? DEFAULT_CURSOR_MATCHERS;
  return {
    version: 1,
    hooks: {
      preToolUse: matchers.map((matcher) => ({
        command: bridgePath,
        matcher,
        timeout,
        failClosed: true,
      })),
    },
    _comment: [
      'Cursor loads Claude Code hook configurations (.claude/settings.json) but documents',
      'command-based and prompt-based hooks, not the http type. This file wires the same',
      'gate through the command bridge, which fails closed on exit code 2.',
      'Required environment: PERMIS_AGENT_GATE_URL, PERMIS_AGENT_TOKEN, and optionally',
      'PERMIS_AGENT_ISSUE (the Jira ticket, sent as the X-Permis-Issue header).',
    ],
  };
}

/**
 * The hook configuration of a client, from the same policy and the same gate
 * URL. Two clients are generated because their formats are known and shipped
 * in `examples/hooks/`; for any other client the bridge is the supported path
 * (documented in HOOK-SETUP §9), and inventing a configuration file whose
 * format is not known would be worse than saying so.
 */
export function buildHookFileForClient(
  client: HookClient,
  opts: HookClientOptions,
): HookFile | Record<string, unknown> {
  return client === 'cursor' ? buildCursorHookFile(opts) : buildHookFile(opts);
}

/** Format the JSON response body expected by Claude Code HTTP hooks. */
export function buildGateResponseBody(
  input: GateResponseInput,
): Record<string, unknown> {
  const requestSuffix = input.requestId ? ` Request: ${input.requestId}` : '';
  const levelSuffix =
    input.level !== undefined ? ` Level: N${input.level}` : '';
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: input.decision,
      permissionDecisionReason: `${input.reason}${requestSuffix}${levelSuffix}`,
    },
  };
}

/**
 * Is the hook payload's tool name usable?
 *
 * A legitimate client always sends a non-empty string. Anything else is a
 * contract violation — a bridge bug, an old client, a hostile payload — and it
 * must be refused rather than interpreted: coercing it to a placeholder turns a
 * malformed request into a plausible-looking one, which is exactly how the
 * fail-open found by the fuzzer worked (docs/THREAT-MODEL.md §3).
 */
export function isWellFormedToolName(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}
