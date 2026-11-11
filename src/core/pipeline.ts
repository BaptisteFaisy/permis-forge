/**
 * Decision pipeline (spec §16 "Déroulement d'une décision").
 *
 * This is the only place where an action becomes a decision: classify, resolve
 * the policy, look for a permit that covers exactly this action, consume it,
 * write the ledger entry, answer with the reason and the next step.
 *
 * Everything is injected (repositories and core functions) so the pipeline is
 * unit-testable with the in-memory storage and no Forge runtime.
 */
import {
  ActionRequest,
  AgentCallContext,
  ApprovalRequest,
  AutonomyLevel,
  Classification,
  Decision,
  HookDecision,
  LedgerEntry,
  LedgerEntryInput,
  Permit,
  PolicyContext,
  PolicyResolution,
  PolicyResolutionInput,
  PolicyRule,
  ProjectSettings,
  Repositories,
  Zone,
} from './types';

export interface PipelineDeps {
  repos: Repositories;
  secret: string;
  classify: (action: ActionRequest, opts?: any) => Promise<Classification>;
  resolve: (input: PolicyResolutionInput) => PolicyResolution;
  isPermitActive: (permit: Permit, nowIso: string, killSwitchActive: boolean) => boolean;
  permitCovers: (permit: Permit, action: ActionRequest, classification: Classification) => boolean;
  consumePermitUse: (permit: Permit) => Permit;
  maskSecrets: (text: string) => string;
  makeEntry: (input: LedgerEntryInput, prev?: LedgerEntry) => LedgerEntry;
  adjustLevel?: (level: AutonomyLevel, score: number, actionClass: string) => AutonomyLevel;
  /** Best-effort approver notification (spec §8.1, §18 validation 6). */
  notify?: (request: ApprovalRequest, classification: Classification) => Promise<void>;
  settings?: ProjectSettings;
  now?: () => string;
}

export interface DecisionEngine {
  evaluateAction(action: ActionRequest, caller: AgentCallContext): Promise<Decision>;
  /** Pure steps, exposed so the simulation console can decide without writing. */
  classifyAction(action: ActionRequest, opts?: any): Promise<Classification>;
  resolvePolicy(input: PolicyResolutionInput): Promise<PolicyResolution>;
}

/** Above this level an action without a ticket is refused (spec §20). */
const DEFAULT_MAX_LEVEL_WITHOUT_TICKET: AutonomyLevel = 4;

export function createDecisionEngine(deps: PipelineDeps): DecisionEngine {
  return {
    evaluateAction: (action, caller) => evaluateAction(deps, action, caller),
    classifyAction: (action, opts) => deps.classify(action, opts),
    resolvePolicy: async (input) => deps.resolve(input),
  };
}

interface LoadedState {
  rules: PolicyRule[];
  zones: Zone[];
  killSwitchActive: boolean;
  trustScore: number;
  suspended: boolean;
  projectId: string;
}

/** Steps 1-5 of the spec, in order. */
async function evaluateAction(
  deps: PipelineDeps,
  action: ActionRequest,
  caller: AgentCallContext,
): Promise<Decision> {
  const at = deps.now?.() ?? action.at ?? new Date().toISOString();
  const classification = await deps.classify({ ...action, at });
  const state = await loadState(deps, action, caller);
  const resolution = deps.resolve({
    context: buildContext(action, classification, state, at),
    rules: state.rules,
    zones: state.zones,
    killSwitchActive: state.killSwitchActive,
    trustEffectsEnabled: deps.settings?.trustEffectsEnabled ?? true,
    adjustLevel: deps.adjustLevel,
  });
  if (state.suspended) {
    return finish(deps, action, caller, classification, resolution, state, at, {
      decision: 'deny',
      log: true,
      reason: 'Agent profile suspended after review (trust capital at 0).',
      guidance: 'Stop: a human must review this profile before any new action.',
    });
  }
  const maxWithoutTicket = deps.settings?.maxLevelWithoutTicket ?? DEFAULT_MAX_LEVEL_WITHOUT_TICKET;
  if (!action.issueKey && resolution.level < maxWithoutTicket) {
    return finish(deps, action, caller, classification, resolution, state, at, {
      decision: 'deny',
      log: true,
      reason: `Ticket reference required for actions beyond N${maxWithoutTicket} (spec §20).`,
      guidance: 'Cite the Jira issue key, then ask again.',
    });
  }
  const outcome = await applyPermitOrRequest(deps, action, caller, classification, resolution, state, at);
  const mapped = mapDecision(resolution, outcome.hasValidPermit);
  return finish(deps, action, caller, classification, resolution, state, at, {
    decision: mapped.decision,
    log: mapped.log,
    reason: mapped.reason,
    guidance: guidanceFor(mapped.decision, outcome.requestId, resolution),
    permitConsumed: outcome.permitConsumed,
    requestId: outcome.requestId,
  });
}

async function loadState(
  deps: PipelineDeps,
  action: ActionRequest,
  caller: AgentCallContext,
): Promise<LoadedState> {
  const projectId = action.projectId ?? caller.projectId;
  const [rules, zones, killSwitches, profile, trustState] = await Promise.all([
    deps.repos.policies.listRules(projectId),
    deps.repos.zones.listZones(projectId),
    deps.repos.killSwitches.listActive(projectId),
    deps.repos.profiles.getProfile(projectId, caller.profileId),
    deps.repos.trust.getState(caller.profileId),
  ]);
  return {
    rules,
    zones,
    killSwitchActive: killSwitches.some((state) => state.active),
    trustScore: trustState?.score ?? 50,
    suspended: profile?.status === 'suspended' || trustState?.status === 'suspended',
    projectId,
  };
}

function buildContext(
  action: ActionRequest,
  classification: Classification,
  state: LoadedState,
  at: string,
): PolicyContext {
  return {
    // Normalise the project: rules are stored per project id, an action may
    // only carry its ticket key.
    action: { ...action, projectId: state.projectId },
    classification,
    environment: action.environment,
    issueType: action.issueType,
    hasAcceptanceCriteria: action.hasAcceptanceCriteria,
    incidentLinked: action.incidentLinked,
    changeFreezeActive: false,
    trustScore: state.trustScore,
    at,
  };
}

interface Outcome {
  hasValidPermit: boolean;
  permitConsumed?: string;
  requestId?: string;
}

/** Step 4: a permit covering exactly this action is consumed, else a request. */
async function applyPermitOrRequest(
  deps: PipelineDeps,
  action: ActionRequest,
  caller: AgentCallContext,
  classification: Classification,
  resolution: PolicyResolution,
  state: LoadedState,
  at: string,
): Promise<Outcome> {
  // N0 is a refusal with no derogation (spec §5): no request is created.
  if (resolution.level > 2 || resolution.level === 0) return { hasValidPermit: resolution.level > 2 };
  const permits = await deps.repos.permits.listPermits({
    projectId: state.projectId,
    issueKey: action.issueKey,
    profileId: caller.profileId,
  });
  const permit = permits.find(
    (item) =>
      deps.isPermitActive(item, at, state.killSwitchActive) &&
      deps.permitCovers(item, action, classification),
  );
  if (permit) {
    await deps.repos.permits.savePermit(deps.consumePermitUse(permit));
    return { hasValidPermit: true, permitConsumed: permit.id };
  }
  if (resolution.observeOnly) return { hasValidPermit: false };
  const request = await createRequest(deps, action, caller, classification, resolution, state, at);
  // A request nobody sees never gets answered (spec §18, validation 6). Best
  // effort: a failed comment must not change the refusal already decided.
  if (deps.notify && request.status === 'pending') {
    try {
      await deps.notify(request, classification);
    } catch (error) {
      console.error('[permis-pipeline] notification failed:', error);
    }
  }
  return { hasValidPermit: false, requestId: request.id };
}

async function createRequest(
  deps: PipelineDeps,
  action: ActionRequest,
  caller: AgentCallContext,
  classification: Classification,
  resolution: PolicyResolution,
  state: LoadedState,
  at: string,
): Promise<ApprovalRequest> {
  const year = new Date(at).getUTCFullYear();
  const sequence = await deps.repos.requests.nextRequestSequence(year);
  const request: ApprovalRequest = {
    id: `RQ-${year}-${String(sequence).padStart(6, '0')}`,
    issueId: action.issueKey ?? '',
    projectId: state.projectId,
    profileId: caller.profileId,
    pilotAccountId: caller.pilot.accountId,
    actionClass: classification.actionClass,
    target: deps.maskSecrets(action.target),
    justification: action.description,
    plan: action.command,
    level: resolution.level,
    status: state.killSwitchActive ? 'frozen' : 'pending',
    createdAt: at,
    approvals: [],
    approverRoles: approverRoles(resolution),
  };
  await deps.repos.requests.create(request);
  return request;
}

function approverRoles(resolution: PolicyResolution): string[] {
  if (resolution.rule?.approverRole) return [resolution.rule.approverRole];
  return resolution.level === 1 ? ['data-owner', 'security'] : ['project-admin'];
}

/** Level → enforcement decision (spec §10), with observe mode. */
function mapDecision(
  resolution: PolicyResolution,
  hasValidPermit: boolean,
): { decision: HookDecision; log: boolean; reason?: string } {
  const level = resolution.level;
  if (level >= 5) return withObserve(resolution, { decision: 'allow', log: false });
  if (level === 4) return withObserve(resolution, { decision: 'allow', log: true });
  if (level === 3) return withObserve(resolution, { decision: 'ask', log: true });
  if (level === 1 || level === 2) {
    return withObserve(
      resolution,
      hasValidPermit
        ? { decision: 'allow', log: true }
        : { decision: 'deny', log: true, reason: 'No valid permit covers this action.' },
    );
  }
  return withObserve(resolution, { decision: 'deny', log: true, reason: 'Forbidden by policy.' });
}

function withObserve(
  resolution: PolicyResolution,
  outcome: { decision: HookDecision; log: boolean; reason?: string },
): { decision: HookDecision; log: boolean; reason?: string } {
  if (!resolution.observeOnly) return outcome;
  return {
    decision: 'allow',
    log: true,
    reason: `OBSERVE MODE: would have been ${outcome.decision}.`,
  };
}

function guidanceFor(
  decision: HookDecision,
  requestId: string | undefined,
  resolution: PolicyResolution,
): string {
  if (decision === 'allow') {
    return resolution.observeOnly
      ? 'Observe mode: the action is allowed and journaled, nothing is blocked.'
      : 'Proceed, and cite the permit in the commit message or the PR description.';
  }
  if (decision === 'ask') return 'Ask the pilot for interactive confirmation before continuing.';
  if (requestId) {
    return `Approval required. Request ${requestId} is on the ticket: stop, announce the number, resume when the pilot restarts you.`;
  }
  return 'Forbidden by policy (N0). Do not attempt again; report it in your account.';
}

interface FinalInput {
  decision: HookDecision;
  log: boolean;
  reason?: string;
  guidance: string;
  permitConsumed?: string;
  requestId?: string;
}

/** Step 5: write the ledger entry, then answer. */
async function finish(
  deps: PipelineDeps,
  action: ActionRequest,
  caller: AgentCallContext,
  classification: Classification,
  resolution: PolicyResolution,
  state: LoadedState,
  at: string,
  final: FinalInput,
): Promise<Decision> {
  const decision: Decision = {
    level: resolution.level,
    decision: final.decision,
    log: final.log,
    classification,
    resolution,
    permitConsumed: final.permitConsumed,
    requestId: final.requestId,
    reason: [resolution.reason, final.reason].filter(Boolean).join(' ').trim(),
    guidance: final.guidance,
    at,
  };
  if (shouldJournal(decision, resolution)) {
    decision.ledgerSeq = await journal(deps, decision, action, caller, classification, resolution, state, at);
  }
  return decision;
}

/** Everything is journaled except a plain autonomous allow. */
function shouldJournal(decision: Decision, resolution: PolicyResolution): boolean {
  return decision.log || decision.decision !== 'allow' || resolution.observeOnly;
}

async function journal(
  deps: PipelineDeps,
  decision: Decision,
  action: ActionRequest,
  caller: AgentCallContext,
  classification: Classification,
  resolution: PolicyResolution,
  state: LoadedState,
  at: string,
): Promise<number> {
  const prev = await deps.repos.ledger.lastEntry(state.projectId);
  const entry = deps.makeEntry(
    {
      kind: 'decision',
      projectId: state.projectId,
      issueId: action.issueKey,
      profileId: caller.profileId,
      pilotAccountId: caller.pilot.accountId,
      actionClass: classification.actionClass,
      target: deps.maskSecrets(action.target),
      ruleId: resolution.rule?.id,
      decision: decision.decision,
      permitId: decision.permitConsumed,
      detail: {
        level: resolution.level,
        source: resolution.source,
        observeOnly: resolution.observeOnly,
        reclassified: classification.reclassified,
        declaredClass: classification.declaredClass,
        requestId: decision.requestId,
        guidance: decision.guidance,
      },
      at,
    },
    prev,
  );
  await deps.repos.ledger.append(entry);
  return entry.seq;
}
