/**
 * Permis d'agir — logique du plugin opencode (pure, sans dépendance, testable).
 *
 * Pourquoi ce fichier : opencode v2 expose un crochet de permission
 * (`ctx.permission.hook("evaluate")`) qui s'exécute AVANT l'action, pour toute
 * décision `allow` ou `ask`. Ce n'est pas un outil que l'agent appelle — donc
 * pas un chemin coopératif qu'il peut court-circuiter : c'est le runtime qui
 * demande, et le runtime qui bloque. Le verdict vient du gate `permis`, le
 * même moteur que le hook Claude Code et le serveur MCP : aucune politique
 * n'est dupliquée ici, seulement le contrat de requête (PreToolUse).
 *
 * Règle de sûreté : le crochet ne peut que SERRER la décision
 * (allow → ask → deny), jamais la desserrer. Gate injoignable = refus.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Effect = 'allow' | 'ask' | 'deny';

export interface GateAnswer {
  decision: Effect;
  reason: string;
}

export interface GateConfig {
  url: string;
  token: string;
  issue?: string;
  timeoutMs?: number;
}

export interface GatePayload {
  toolName: string;
  args: Record<string, string>;
  cwd: string;
}

export interface PermissionCheck {
  /** opencode permission action: `edit`, `shell`, `read`, `grep`… */
  action: string;
  /** ce que l'action touche : chemin (edit) ou commande (shell) */
  resources: readonly string[];
  cwd: string;
  /** décision déjà rendue par les règles opencode (allow ou ask) */
  current: Effect;
}

export interface Verdict {
  effect: Effect;
  message?: string;
}

/** Actions interceptées ; tout le reste (read, grep, glob, web…) passe. */
export const GATED_ACTIONS: ReadonlySet<string> = new Set(['edit', 'shell']);

const DEFAULT_TIMEOUT_MS = 10_000;
const CREDENTIALS_DIR = '.atlassian';

function fileEnv(name: string): string {
  try {
    return readFileSync(join(homedir(), CREDENTIALS_DIR, name), 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Identifiants : l'environnement d'abord, puis `~/.atlassian/`.
 * Un fichier d'identifiant = un environnement (leçon du 12/11 : un token prod
 * pointé sur une URL dev renvoyait 401).
 */
export function readConfig(env: Record<string, string | undefined> = process.env): GateConfig | undefined {
  const url = env.PERMIS_GATE_URL || env.PERMIS_AGENT_GATE_URL || fileEnv('permis-gate-url.txt');
  const token = env.PERMIS_AGENT_TOKEN || fileEnv('permis-agent-token.txt');
  if (!url || !token) return undefined;
  const issue = env.PERMIS_AGENT_ISSUE || fileEnv('permis-agent-issue.txt');
  return { url, token, issue: issue || undefined };
}

/** Payload PreToolUse identique au pont shell et au serveur MCP. */
export function gatePayload(action: string, resource: string, cwd: string): GatePayload | undefined {
  if (action === 'shell') return { toolName: 'Bash', args: { command: resource }, cwd };
  if (action === 'edit') return { toolName: 'Edit', args: { file_path: resource }, cwd };
  return undefined;
}

/** allow < ask < deny : on ne peut que rendre la décision plus stricte. */
export function tighten(current: Effect, gate: Effect): Effect {
  const rank: Record<Effect, number> = { allow: 0, ask: 1, deny: 2 };
  return rank[gate] > rank[current] ? gate : current;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null ? (value as Json) : undefined;
}

function parseAnswer(body: unknown): GateAnswer | undefined {
  const root = asRecord(body);
  const output = asRecord(root?.hookSpecificOutput) ?? root;
  const decision = output?.permissionDecision;
  if (decision !== 'allow' && decision !== 'ask' && decision !== 'deny') return undefined;
  const reason = typeof output?.permissionDecisionReason === 'string' ? output.permissionDecisionReason : '';
  return { decision, reason };
}

/** Un POST vers le gate. Toute incertitude (réseau, HTTP, corps) vaut refus. */
export async function askGate(payload: GatePayload, config: GateConfig): Promise<GateAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.token}`,
  };
  if (config.issue) headers['X-Permis-Issue'] = config.issue;
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { decision: 'deny', reason: `gate error (HTTP ${response.status}) — failing closed` };
    }
    const answer = parseAnswer(await response.json());
    if (!answer) return { decision: 'deny', reason: 'gate answer unreadable — failing closed' };
    return answer;
  } catch (err) {
    return { decision: 'deny', reason: `gate unreachable — failing closed (${String(err)})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Décide pour une vérification opencode.
 * `undefined` = « rien à dire, garde ta décision » ; sinon le verdict à appliquer.
 * `config` à `null` = aucun identifiant : refus (fail-closed), jamais un passe-droit.
 */
export async function decidePermission(
  input: PermissionCheck,
  config: GateConfig | null,
): Promise<Verdict | undefined> {
  if (!GATED_ACTIONS.has(input.action)) return undefined;
  if (!config) {
    return {
      effect: 'deny',
      message:
        "Permis d'agir: aucun identifiant de gate (PERMIS_GATE_URL / PERMIS_AGENT_TOKEN) — refus par défaut.",
    };
  }

  const payloads = input.resources
    .map((resource) => gatePayload(input.action, resource, input.cwd))
    .filter((payload): payload is GatePayload => Boolean(payload));
  if (payloads.length === 0) return undefined;

  // Une commande composée arrive décomposée en sous-commandes : chacune passe
  // devant le gate, et le verdict le plus strict l'emporte.
  let effect = input.current;
  const reasons: string[] = [];
  for (const payload of payloads) {
    const answer = await askGate(payload, config);
    if (answer.reason) reasons.push(answer.reason);
    effect = tighten(effect, answer.decision);
    if (effect === 'deny') break;
  }
  if (effect === input.current) return undefined;
  return { effect, message: reasons.length > 0 ? `Permis d'agir: ${reasons.join(' | ')}` : undefined };
}