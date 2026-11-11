/**
 * Shared helpers for the offline acceptance demo (spec §21).
 *
 * Every scenario runs against the REAL decision engine and the in-memory
 * storage adapter: nothing is faked, so the demo proves the same code path the
 * Forge app uses. Scenarios are pure functions of a fresh "world".
 */
import { createDecisionEngine, DecisionEngine } from '../src/core/pipeline';
import { classifyAction } from '../src/core/classify';
import { resolvePolicy } from '../src/core/policy';
import { consumePermitUse, isPermitActive, issuePermit, newPermitId, permitCovers } from '../src/core/permits';
import { makeEntry, verifyChain } from '../src/core/ledger';
import { maskSecrets } from '../src/core/mask';
import { trustAdjustLevel, applyTrustEvent, initialTrustState } from '../src/core/trust';
import { createMemoryRepositories, resetDefaultRepositories, getDefaultRepositories } from '../src/storage';
import { approveRequest, createHookToken } from '../src/services/approvals-service';
import { AgentCallContext, Decision, Permit, PolicyRule, Repositories } from '../src/core/types';

export const SECRET = 'demo-secret';
export const PROJECT = 'PAY';
export const ISSUE = 'PAY-42';
export const PROFILE = 'claude-code-payments';
export const PILOT = 'pilot-1';
export const APPROVER = 'tech-lead-2';
export const NOW = '2026-11-11T10:00:00.000Z';

export interface World {
  repos: Repositories;
  engine: DecisionEngine;
  now: string;
}

/** A fresh, isolated world: empty storage plus a wired decision engine. */
export function makeWorld(): World {
  const repos = createMemoryRepositories();
  const engine = createDecisionEngine({
    repos,
    secret: SECRET,
    classify: classifyAction,
    resolve: resolvePolicy,
    isPermitActive,
    permitCovers,
    consumePermitUse,
    maskSecrets,
    makeEntry,
    adjustLevel: trustAdjustLevel,
    now: () => NOW,
  });
  return { repos, engine, now: NOW };
}

export function caller(overrides: Partial<AgentCallContext> = {}): AgentCallContext {
  return {
    projectId: PROJECT,
    issueKey: ISSUE,
    profileId: PROFILE,
    pilot: { accountId: PILOT, roles: ['developer'] },
    via: 'mcp',
    ...overrides,
  };
}

/** Evaluate one action in a world and return the decision. */
export async function decide(
  world: World,
  target: string,
  declaredClass?: string,
  overrides: Partial<AgentCallContext> = {},
): Promise<Decision> {
  return world.engine.evaluateAction(
    { target, declaredClass, issueKey: ISSUE, projectId: PROJECT, at: world.now },
    caller(overrides),
  );
}

/** Grant a signed permit covering one exact target. */
export async function grantPermit(
  world: World,
  actionClass: string,
  target: string,
  opts: { uses?: number; ttlMinutes?: number; issuedAt?: string } = {},
): Promise<Permit> {
  const sequence = await world.repos.permits.nextPermitSequence(2026);
  const permit = issuePermit(
    {
      id: newPermitId(sequence, 2026),
      scope: { actionClass, target, issueKey: ISSUE, projectId: PROJECT },
      holderProfileId: PROFILE,
      pilotAccountId: PILOT,
      issuedAt: opts.issuedAt ?? world.now,
      ttlMinutes: opts.ttlMinutes ?? 120,
      uses: opts.uses ?? 1,
    },
    SECRET,
  );
  await world.repos.permits.savePermit(permit);
  return permit;
}

/** Install one project rule (the demo seeds the minimum it needs). */
export async function addRule(world: World, rule: Partial<PolicyRule> & { id: string }): Promise<void> {
  await world.repos.policies.upsertRule({
    scope: 'project',
    projectId: PROJECT,
    actionClass: 'A-08',
    level: 2,
    mode: 'enforce',
    ...rule,
  } as PolicyRule);
}

/** Switch the project emergency stop on. */
export async function activateKillSwitch(world: World): Promise<void> {
  await world.repos.killSwitches.save({
    scope: 'project',
    projectId: PROJECT,
    active: true,
    by: 'security-lead',
    reason: 'Demo: incident in progress',
    at: world.now,
  });
}

/** Give a profile a trust score so trust effects can be shown. */
export async function setTrust(world: World, score: number): Promise<void> {
  let state = initialTrustState(PROFILE);
  state = applyTrustEvent(state, 'report-confirmed', world.now);
  state = { ...state, score, lastActivityAt: world.now };
  await world.repos.trust.saveState(state);
}

/** Approve the pending request created by a refusal, as a third party. */
export async function approvePending(world: World, requestId: string) {
  return approveRequest({
    repos: world.repos,
    secret: SECRET,
    requestId,
    approver: { accountId: APPROVER, roles: ['tech-lead'], isPilot: false },
    reason: 'Demo approval',
    ttlMinutes: 30,
    uses: 1,
    now: world.now,
  });
}

/**
 * Prepare the process-wide runtime used by the HTTP gate, with a personal hook
 * token for the pilot. Returns the token (plaintext, shown once).
 */
export async function seedGateRuntime(): Promise<{ repos: Repositories; token: string }> {
  resetDefaultRepositories();
  const repos = getDefaultRepositories();
  const { token } = await createHookToken(repos, PILOT, 'demo');
  return { repos, token };
}

/** Result of one acceptance scenario. */
export interface ScenarioResult {
  id: number;
  title: string;
  passed: boolean;
  detail: string;
}

export interface Scenario {
  id: number;
  title: string;
  run: () => Promise<ScenarioResult>;
}

/** Build a result, keeping the demo transcript short and readable. */
export function result(id: number, title: string, passed: boolean, detail: string): ScenarioResult {
  return { id, title, passed, detail };
}

export { verifyChain };
