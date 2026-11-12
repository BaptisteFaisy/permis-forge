/**
 * In-memory adapter for the storage ports of `src/core/types.ts`.
 *
 * Used by the unit tests and as a fallback when the app runs outside Forge
 * (no SQL database available). Every method returns copies of stored objects,
 * so a caller mutating a result can never corrupt the store.
 */
import {
  AgentProfile,
  ApprovalRequest,
  HookToken,
  KillSwitchState,
  LedgerEntry,
  LedgerFilter,
  Permit,
  PolicyRule,
  Repositories,
  RuleScope,
  TrustEvent,
  TrustState,
  Zone,
} from '../core/types';

/** Bucket used by rules that apply to the whole organisation. */
const ORG_BUCKET = 'org';

interface MemoryState {
  rules: Map<string, Map<string, PolicyRule>>;
  zones: Map<string, Map<string, Zone>>;
  profiles: Map<string, Map<string, AgentProfile>>;
  permits: Map<string, Permit>;
  ledger: LedgerEntry[];
  requests: Map<string, ApprovalRequest>;
  trustStates: Map<string, TrustState>;
  trustEvents: Map<string, TrustEvent[]>;
  killSwitches: Map<string, KillSwitchState>;
  hookTokens: Map<string, HookToken>;
  /** Revoked token hashes, kept apart: Forge SQL has no ALTER (see storage.ts). */
  revokedTokens: Map<string, { by: string; reason?: string; at: string }>;
  permitSequences: Map<number, number>;
  requestSequences: Map<number, number>;
}

/** Deep copy: undefined passes through, everything else is JSON-safe data. */
function copy<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Bucket key of a policy rule: org rules share one bucket. */
function ruleBucket(rule: Pick<PolicyRule, 'scope' | 'projectId'>): string {
  return rule.scope === 'org' ? ORG_BUCKET : `project:${rule.projectId ?? ''}`;
}

/** Get (or create) the id-keyed map of a project bucket. */
function bucket<T>(state: Map<string, Map<string, T>>, key: string): Map<string, T> {
  let existing = state.get(key);
  if (!existing) {
    existing = new Map<string, T>();
    state.set(key, existing);
  }
  return existing;
}

/** Monotonic per-year counter, starting at 1. */
function nextSequence(counters: Map<number, number>, year: number): number {
  const next = (counters.get(year) ?? 0) + 1;
  counters.set(year, next);
  return next;
}

/** True when an entry satisfies every provided filter (undefined = skip). */
function ledgerMatches(entry: LedgerEntry, filter: LedgerFilter): boolean {
  if (filter.projectId && entry.projectId !== filter.projectId) return false;
  if (filter.issueId && entry.issueId !== filter.issueId) return false;
  if (filter.profileId && entry.profileId !== filter.profileId) return false;
  if (filter.actionClass && entry.actionClass !== filter.actionClass) return false;
  if (filter.kind && entry.kind !== filter.kind) return false;
  // ISO-8601 timestamps sort lexicographically, so plain comparison works.
  if (filter.since && entry.at < filter.since) return false;
  if (filter.until && entry.at > filter.until) return false;
  return true;
}

/** Insert an entry keeping the whole journal ordered by seq. */
function insertOrdered(entries: LedgerEntry[], entry: LedgerEntry): void {
  const index = entries.findIndex((existing) => existing.seq > entry.seq);
  if (index === -1) {
    entries.push(entry);
  } else {
    entries.splice(index, 0, entry);
  }
}

function createPolicyRepository(state: MemoryState): Repositories['policies'] {
  return {
    async listRules(projectId: string): Promise<PolicyRule[]> {
      const orgRules = [...(state.rules.get(ORG_BUCKET)?.values() ?? [])];
      const projectRules = [...(state.rules.get(`project:${projectId}`)?.values() ?? [])];
      return copy([...orgRules, ...projectRules]);
    },
    async upsertRule(rule: PolicyRule): Promise<void> {
      bucket(state.rules, ruleBucket(rule)).set(rule.id, copy(rule));
    },
    async deleteRule(id: string): Promise<void> {
      for (const byId of state.rules.values()) byId.delete(id);
    },
  };
}

function createZoneRepository(state: MemoryState): Repositories['zones'] {
  return {
    async listZones(projectId: string): Promise<Zone[]> {
      return copy([...(state.zones.get(`project:${projectId}`)?.values() ?? [])]);
    },
    async upsertZone(zone: Zone): Promise<void> {
      bucket(state.zones, `project:${zone.projectId}`).set(zone.id, copy(zone));
    },
    async deleteZone(id: string): Promise<void> {
      for (const byId of state.zones.values()) byId.delete(id);
    },
  };
}

function createProfileRepository(state: MemoryState): Repositories['profiles'] {
  return {
    async getProfile(projectId: string, profileId: string): Promise<AgentProfile | undefined> {
      return copy(state.profiles.get(`project:${projectId}`)?.get(profileId));
    },
    async listProfiles(projectId: string): Promise<AgentProfile[]> {
      return copy([...(state.profiles.get(`project:${projectId}`)?.values() ?? [])]);
    },
    async upsertProfile(profile: AgentProfile): Promise<void> {
      bucket(state.profiles, `project:${profile.projectId}`).set(profile.id, copy(profile));
    },
  };
}

function createPermitRepository(state: MemoryState): Repositories['permits'] {
  return {
    async listPermits(filter: { projectId?: string; issueKey?: string; profileId?: string }): Promise<Permit[]> {
      const permits = [...state.permits.values()];
      return copy(
        permits.filter(
          (permit) =>
            (!filter.projectId || permit.scope.projectId === filter.projectId) &&
            (!filter.issueKey || permit.scope.issueKey === filter.issueKey) &&
            (!filter.profileId || permit.holderProfileId === filter.profileId),
        ),
      );
    },
    async savePermit(permit: Permit): Promise<void> {
      state.permits.set(permit.id, copy(permit));
    },
    async nextPermitSequence(year: number): Promise<number> {
      return nextSequence(state.permitSequences, year);
    },
  };
}

function createLedgerRepository(state: MemoryState): Repositories['ledger'] {
  return {
    async lastEntry(projectId: string): Promise<LedgerEntry | undefined> {
      const ofProject = state.ledger.filter((entry) => entry.projectId === projectId);
      return copy(ofProject.length > 0 ? ofProject[ofProject.length - 1] : undefined);
    },
    async append(entry: LedgerEntry): Promise<void> {
      insertOrdered(state.ledger, copy(entry));
    },
    async list(filter: LedgerFilter): Promise<LedgerEntry[]> {
      const matched = state.ledger.filter((entry) => ledgerMatches(entry, filter));
      return copy(filter.limit !== undefined ? matched.slice(0, filter.limit) : matched);
    },
  };
}

function createRequestRepository(state: MemoryState): Repositories['requests'] {
  return {
    async create(request: ApprovalRequest): Promise<void> {
      state.requests.set(request.id, copy(request));
    },
    async get(requestId: string): Promise<ApprovalRequest | undefined> {
      return copy(state.requests.get(requestId));
    },
    async update(request: ApprovalRequest): Promise<void> {
      state.requests.set(request.id, copy(request));
    },
    async listPending(issueKey?: string): Promise<ApprovalRequest[]> {
      const pending = [...state.requests.values()].filter(
        (request) => request.status === 'pending' && (!issueKey || request.issueId === issueKey),
      );
      return copy(pending);
    },
    async nextRequestSequence(year: number): Promise<number> {
      return nextSequence(state.requestSequences, year);
    },
  };
}

function createTrustRepository(state: MemoryState): Repositories['trust'] {
  return {
    async getState(profileId: string): Promise<TrustState | undefined> {
      return copy(state.trustStates.get(profileId));
    },
    async saveState(trustState: TrustState): Promise<void> {
      state.trustStates.set(trustState.profileId, copy(trustState));
    },
    async recordEvent(event: TrustEvent): Promise<void> {
      const events = state.trustEvents.get(event.profileId) ?? [];
      events.push(copy(event));
      state.trustEvents.set(event.profileId, events);
    },
    async listEvents(profileId: string): Promise<TrustEvent[]> {
      return copy(state.trustEvents.get(profileId) ?? []);
    },
  };
}

/** `${scope}:${projectId ?? 'org'}` — one row per scope, project or organisation. */
export function killSwitchKey(scope: RuleScope, projectId?: string): string {
  return `${scope}:${projectId ?? 'org'}`;
}

function createKillSwitchRepository(state: MemoryState): Repositories['killSwitches'] {
  return {
    async get(scope: RuleScope, projectId?: string): Promise<KillSwitchState | undefined> {
      return copy(state.killSwitches.get(killSwitchKey(scope, projectId)));
    },
    async listActive(projectId: string): Promise<KillSwitchState[]> {
      const active = [...state.killSwitches.values()].filter(
        (item) => item.active === true && (item.scope === 'org' || item.projectId === projectId),
      );
      return copy(active);
    },
    async save(killSwitch: KillSwitchState): Promise<void> {
      state.killSwitches.set(killSwitchKey(killSwitch.scope, killSwitch.projectId), copy(killSwitch));
    },
  };
}

function createHookTokenRepository(state: MemoryState): Repositories['hookTokens'] {
  return {
    async findByTokenHash(hash: string): Promise<HookToken | undefined> {
      return copy(state.hookTokens.get(hash));
    },
    async save(token: HookToken): Promise<void> {
      state.hookTokens.set(token.tokenHash, copy(token));
    },
    async listForAccount(accountId: string): Promise<HookToken[]> {
      return copy([...state.hookTokens.values()].filter((token) => token.accountId === accountId));
    },
    async touchLastUsed(hash: string, at: string): Promise<void> {
      const token = state.hookTokens.get(hash);
      if (token) state.hookTokens.set(hash, { ...copy(token), lastUsedAt: at });
    },
    async revoke(hash: string, by: string, reason: string | undefined, at: string): Promise<void> {
      state.revokedTokens.set(hash, { by, reason, at });
    },
    async isRevoked(hash: string): Promise<boolean> {
      return state.revokedTokens.has(hash);
    },
  };
}

/** A fresh, fully isolated in-memory Repositories implementation. */
export function createMemoryRepositories(): Repositories {
  const state: MemoryState = {
    rules: new Map(),
    zones: new Map(),
    profiles: new Map(),
    permits: new Map(),
    ledger: [],
    requests: new Map(),
    trustStates: new Map(),
    trustEvents: new Map(),
    killSwitches: new Map(),
    hookTokens: new Map(),
    revokedTokens: new Map(),
    permitSequences: new Map(),
    requestSequences: new Map(),
  };

  return {
    policies: createPolicyRepository(state),
    zones: createZoneRepository(state),
    profiles: createProfileRepository(state),
    permits: createPermitRepository(state),
    ledger: createLedgerRepository(state),
    requests: createRequestRepository(state),
    trust: createTrustRepository(state),
    killSwitches: createKillSwitchRepository(state),
    hookTokens: createHookTokenRepository(state),
  };
}
