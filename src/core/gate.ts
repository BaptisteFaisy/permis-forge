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
} from './types';

const BASH_TOOLS = new Set(['bash', 'shell', 'bashoutput']);
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit']);
const READ_TOOLS = new Set(['read', 'grep', 'glob', 'ls']);

const DEFAULT_TOKEN_ENV_VAR = 'PERMIS_AGENT_TOKEN';
const DEFAULT_TIMEOUT_SECONDS = 10;
const DEFAULT_MATCHERS = ['Bash|Edit|Write|MultiEdit'];
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
  return {
    ...base,
    target: toolName,
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
  const timeout = opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const matchers = opts.matchers ?? DEFAULT_MATCHERS;

  return {
    hooks: {
      PreToolUse: matchers.map((matcher) => ({
        matcher,
        hooks: [
          {
            type: 'http',
            url: opts.gateUrl,
            timeout,
            onFailure: 'block',
            headers: { Authorization: `Bearer $${tokenEnvVar}` },
            allowedEnvVars: [tokenEnvVar],
          },
        ],
      })),
    },
  };
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
