/**
 * Runtime glue for the MCP tools, the Forge screens and the triggers.
 *
 * Assembles the decision engine from the pure core modules and the storage
 * adapters, resolves identity (never from tool inputs, spec §16 step 1) and
 * exposes small helpers shared by every handler.
 */
import { createDecisionEngine } from '../core/pipeline';
import { classifyAction } from '../core/classify';
import { resolvePolicy } from '../core/policy';
import { consumePermitUse, isPermitActive, permitCovers } from '../core/permits';
import { makeEntry } from '../core/ledger';
import { maskSecrets } from '../core/mask';
import { trustAdjustLevel } from '../core/trust';
import { getDefaultRepositories } from '../storage';
import { AgentCallContext, Repositories } from '../core/types';

/** Default agent profile when the caller does not name one. */
export const DEFAULT_PROFILE_ID = 'default';

/**
 * Signing secret of the installation. Set PERMIS_AGENT_SECRET as an app
 * environment variable; the fallback exists so a fresh install still runs in
 * development — it must be replaced before any real deployment.
 */
export function resolveSigningSecret(): string {
  // Forge exposes app variables as FORGE_USER_VAR_<NAME>; the plain name is
  // kept for local runs and tests.
  const secret =
    process.env.FORGE_USER_VAR_PERMIS_AGENT_SECRET ?? process.env.PERMIS_AGENT_SECRET;
  if (secret && secret.length > 0) return secret;
  return 'dev-insecure-secret-change-me';
}

export interface Runtime {
  repos: Repositories;
  engine: ReturnType<typeof createDecisionEngine>;
  now: () => string;
  secret: string;
}

let cached: Runtime | undefined;

export function getRuntimeSync(): Runtime {
  const repos = getDefaultRepositories();
  // Rebuild when the storage instance changed (tests reset it between cases).
  if (cached && cached.repos === repos) return cached;
  const secret = resolveSigningSecret();
  const engine = createDecisionEngine({
    repos,
    secret,
    classify: classifyAction,
    resolve: resolvePolicy,
    isPermitActive,
    permitCovers,
    consumePermitUse,
    maskSecrets,
    makeEntry,
    adjustLevel: trustAdjustLevel,
  });
  cached = { repos, engine, secret, now: () => new Date().toISOString() };
  return cached;
}

export async function getRuntime(): Promise<Runtime> {
  return getRuntimeSync();
}

/** Project identifier used across storage: the Jira project key. */
export function resolveProjectId(input: {
  issueKey?: string;
  projectKey?: string;
}): string {
  if (input.projectKey && input.projectKey.length > 0) return input.projectKey;
  if (input.issueKey && input.issueKey.includes('-')) {
    return input.issueKey.split('-')[0];
  }
  return 'unknown';
}

/** Issue key of the calling context, never taken from tool inputs. */
export function resolveIssueKey(context: any, payload: any): string | undefined {
  const fromContext = context?.extension?.issue?.key;
  if (typeof fromContext === 'string' && fromContext.length > 0) return fromContext;
  const fromPayload = payload?.issueKey;
  return typeof fromPayload === 'string' && fromPayload.length > 0 ? fromPayload : undefined;
}

/** Account id of the caller, never taken from tool inputs. */
export function resolveAccountId(context: any): string {
  const id = context?.accountId ?? context?.extension?.accountId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

/** Agent profile id: the caller may name one, it grants no right by itself. */
export function resolveProfileId(payload: any): string {
  const profile = payload?.agentProfile;
  return typeof profile === 'string' && profile.length > 0 ? profile : DEFAULT_PROFILE_ID;
}

export function buildCaller(input: {
  projectId: string;
  issueKey?: string;
  profileId: string;
  accountId: string;
  via: AgentCallContext['via'];
}): AgentCallContext {
  return {
    projectId: input.projectId,
    issueKey: input.issueKey,
    profileId: input.profileId,
    pilot: { accountId: input.accountId, roles: [] },
    via: input.via,
  };
}

/** Compact JSON output for MCP tools (actions must return a string). */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
