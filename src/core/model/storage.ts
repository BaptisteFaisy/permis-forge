/**
 * Storage ports (repository interfaces).
 *
 * The core pipeline only talks to these interfaces; a SQL adapter (src/sql/db.ts)
 * and an in-memory adapter (src/sql/memory.ts) implement them, which keeps every
 * decision unit-testable.
 */

import type { PolicyRule, Zone } from './policy';
import type { AgentProfile, HookToken } from './profiles';
import type { Permit } from './permits';
import type { LedgerEntry, LedgerFilter } from './ledger';
import type { ApprovalRequest } from './requests';
import type { TrustState, TrustEvent } from './trust';
import type { RuleScope } from './policy';
import type { KillSwitchState } from './killswitch';

export interface PolicyRepository {
  listRules(projectId: string): Promise<PolicyRule[]>;
  upsertRule(rule: PolicyRule): Promise<void>;
  deleteRule(id: string): Promise<void>;
}

export interface ZoneRepository {
  listZones(projectId: string): Promise<Zone[]>;
  upsertZone(zone: Zone): Promise<void>;
  deleteZone(id: string): Promise<void>;
}

export interface ProfileRepository {
  getProfile(projectId: string, profileId: string): Promise<AgentProfile | undefined>;
  listProfiles(projectId: string): Promise<AgentProfile[]>;
  upsertProfile(profile: AgentProfile): Promise<void>;
}

export interface PermitRepository {
  listPermits(filter: {
    projectId?: string;
    issueKey?: string;
    profileId?: string;
  }): Promise<Permit[]>;
  savePermit(permit: Permit): Promise<void>;
  /** Monotonic per year, for "PA-<year>-<6 digits>" ids. */
  nextPermitSequence(year: number): Promise<number>;
}

export interface LedgerRepository {
  lastEntry(projectId: string): Promise<LedgerEntry | undefined>;
  append(entry: LedgerEntry): Promise<void>;
  list(filter: LedgerFilter): Promise<LedgerEntry[]>;
}

export interface RequestRepository {
  create(request: ApprovalRequest): Promise<void>;
  get(requestId: string): Promise<ApprovalRequest | undefined>;
  update(request: ApprovalRequest): Promise<void>;
  listPending(issueKey?: string): Promise<ApprovalRequest[]>;
  nextRequestSequence(year: number): Promise<number>;
}

export interface TrustRepository {
  getState(profileId: string): Promise<TrustState | undefined>;
  saveState(state: TrustState): Promise<void>;
  recordEvent(event: TrustEvent): Promise<void>;
  listEvents(profileId: string): Promise<TrustEvent[]>;
}

export interface KillSwitchRepository {
  get(scope: RuleScope, projectId?: string): Promise<KillSwitchState | undefined>;
  listActive(projectId: string): Promise<KillSwitchState[]>;
  save(state: KillSwitchState): Promise<void>;
}

export interface HookTokenRepository {
  findByTokenHash(hash: string): Promise<HookToken | undefined>;
  save(token: HookToken): Promise<void>;
  listForAccount(accountId: string): Promise<HookToken[]>;
  touchLastUsed(hash: string, at: string): Promise<void>;
  /**
   * Revoke a token: it stops authenticating immediately and the reason is kept.
   * Revocation lives in its own table, not in a column of `hook_token`, because
   * Forge SQL has no ALTER — a new table is the only change that reaches an
   * already-installed app (the reactive bootstrap creates what is missing).
   */
  revoke(hash: string, by: string, reason: string | undefined, at: string): Promise<void>;
  isRevoked(hash: string): Promise<boolean>;
}

export interface Repositories {
  policies: PolicyRepository;
  zones: ZoneRepository;
  profiles: ProfileRepository;
  permits: PermitRepository;
  ledger: LedgerRepository;
  requests: RequestRepository;
  trust: TrustRepository;
  killSwitches: KillSwitchRepository;
  hookTokens: HookTokenRepository;
}
