/**
 * Forge SQL schema (spec §17) — DDL and organisation seed data.
 *
 * Constraints taken into account (spec §18, Forge SQL limits):
 * - no foreign keys: referential integrity is enforced by the repositories;
 * - MySQL-compatible types only (VARCHAR, TEXT, INT, BIGINT, TINYINT(1));
 * - timestamps are stored as ISO-8601 strings in VARCHAR(32) so the ledger
 *   stays byte-identical to the in-memory adapter and sorts lexicographically;
 * - every statement is idempotent (`IF NOT EXISTS`) so the DDL can be replayed
 *   on each deployment.
 *
 * Trust state (score / status / last activity) lives on `agent_profile`: the
 * profile is the unit of trust capital (spec §9), and one row per profile is
 * cheaper than an eleventh table. `kill_switch.toggled_by` is spelled that way
 * because `BY` is a reserved word in MySQL.
 *
 * The second half of this module is the read side of the schema: one row codec
 * per table, so `src/storage/sql.ts` stays about queries only.
 */
import {
  AgentProfile, Approval, ApprovalRequest, HookToken, KillSwitchState, LedgerEntry, Permit,
  PermitScope, PolicyRule, RuleConditions, RuleScope, TrustEvent, TrustState, Zone,
} from '../core/types';

/** Ordered DDL: 10 `CREATE TABLE IF NOT EXISTS` + useful indexes. */
export const SCHEMA_DDL: string[] = [
  // ------------------------------------------------------------- policy grid
  `CREATE TABLE IF NOT EXISTS policy_rule (
  id VARCHAR(64) NOT NULL,
  scope VARCHAR(16) NOT NULL,
  project_id VARCHAR(32) NULL,
  action_class VARCHAR(32) NOT NULL,
  zone_id VARCHAR(64) NULL,
  conditions_json TEXT NULL,
  level TINYINT NOT NULL,
  mode VARCHAR(16) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_policy_rule_project ON policy_rule (project_id, action_class)',
  'CREATE INDEX IF NOT EXISTS idx_policy_rule_scope ON policy_rule (scope, action_class)',

  // -------------------------------------------------------------- zones
  `CREATE TABLE IF NOT EXISTS zone (
  id VARCHAR(64) NOT NULL,
  project_id VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  path_patterns TEXT NOT NULL,
  component VARCHAR(128) NULL,
  environment VARCHAR(32) NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_zone_project ON zone (project_id)',

  // --------------------------------------------------------- agent profiles
  `CREATE TABLE IF NOT EXISTS agent_profile (
  id VARCHAR(64) NOT NULL,
  project_id VARCHAR(32) NULL,
  name VARCHAR(255) NOT NULL,
  client VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  trust_score INT NOT NULL,
  trust_status VARCHAR(16) NOT NULL,
  trust_last_activity_at VARCHAR(32) NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_agent_profile_project ON agent_profile (project_id)',

  // -------------------------------------------------- approval requests
  `CREATE TABLE IF NOT EXISTS request (
  id VARCHAR(64) NOT NULL,
  issue_id VARCHAR(64) NOT NULL,
  project_id VARCHAR(32) NOT NULL,
  profile_id VARCHAR(64) NOT NULL,
  pilot_account_id VARCHAR(64) NOT NULL,
  action_class VARCHAR(32) NOT NULL,
  target TEXT NOT NULL,
  justification TEXT NULL,
  plan TEXT NULL,
  level TINYINT NOT NULL,
  status VARCHAR(32) NOT NULL,
  created_at VARCHAR(32) NOT NULL,
  approvals_json TEXT NOT NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_request_status ON request (status, issue_id)',
  'CREATE INDEX IF NOT EXISTS idx_request_project ON request (project_id, created_at)',

  // ------------------------------------------------------------- approvals
  `CREATE TABLE IF NOT EXISTS approval (
  id BIGINT NOT NULL AUTO_INCREMENT,
  request_id VARCHAR(64) NOT NULL,
  approver_account_id VARCHAR(64) NOT NULL,
  role VARCHAR(64) NOT NULL,
  decision VARCHAR(16) NOT NULL,
  reason TEXT NULL,
  at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_approval_request ON approval (request_id)',

  // --------------------------------------------------------------- permits
  `CREATE TABLE IF NOT EXISTS permit (
  id VARCHAR(64) NOT NULL,
  request_id VARCHAR(64) NULL,
  scope_json TEXT NOT NULL,
  action_class VARCHAR(32) NOT NULL,
  target TEXT NOT NULL,
  issue_key VARCHAR(64) NULL,
  project_id VARCHAR(32) NOT NULL,
  holder_profile_id VARCHAR(64) NOT NULL,
  pilot_account_id VARCHAR(64) NOT NULL,
  issued_at VARCHAR(32) NOT NULL,
  expires_at VARCHAR(32) NOT NULL,
  uses_left INT NOT NULL,
  signature VARCHAR(128) NOT NULL,
  revoked_at VARCHAR(32) NULL,
  suspended TINYINT(1) NOT NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_permit_project ON permit (project_id, holder_profile_id)',
  'CREATE INDEX IF NOT EXISTS idx_permit_issue ON permit (issue_key)',

  // ---------------------------------------------------- tamper-evident ledger
  `CREATE TABLE IF NOT EXISTS ledger (
  seq BIGINT NOT NULL,
  at VARCHAR(32) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  project_id VARCHAR(32) NOT NULL,
  issue_id VARCHAR(64) NULL,
  profile_id VARCHAR(64) NULL,
  pilot_account_id VARCHAR(64) NULL,
  action_class VARCHAR(32) NULL,
  target TEXT NULL,
  rule_id VARCHAR(64) NULL,
  decision VARCHAR(64) NULL,
  permit_id VARCHAR(64) NULL,
  detail_json TEXT NULL,
  corrects_seq BIGINT NULL,
  prev_hash VARCHAR(128) NOT NULL,
  hash VARCHAR(128) NOT NULL,
  PRIMARY KEY (project_id, seq)
)`,
  'CREATE INDEX IF NOT EXISTS idx_ledger_project_seq ON ledger (project_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_ledger_issue ON ledger (issue_id, seq)',
  'CREATE INDEX IF NOT EXISTS idx_ledger_kind ON ledger (kind, at)',

  // ---------------------------------------------------------- trust events
  `CREATE TABLE IF NOT EXISTS trust_event (
  id BIGINT NOT NULL AUTO_INCREMENT,
  profile_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  delta INT NOT NULL,
  reason TEXT NULL,
  ledger_seq BIGINT NULL,
  at VARCHAR(32) NOT NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_trust_event_profile ON trust_event (profile_id, at)',

  // ------------------------------------------------------------- kill switch
  `CREATE TABLE IF NOT EXISTS kill_switch (
  id VARCHAR(96) NOT NULL,
  scope VARCHAR(16) NOT NULL,
  project_id VARCHAR(32) NULL,
  active TINYINT(1) NOT NULL,
  toggled_by VARCHAR(64) NULL,
  reason TEXT NULL,
  at VARCHAR(32) NULL,
  PRIMARY KEY (id)
)`,
  'CREATE INDEX IF NOT EXISTS idx_kill_switch_scope ON kill_switch (scope, active)',

  // ------------------------------------------------------------- hook tokens
  `CREATE TABLE IF NOT EXISTS hook_token (
  token_hash VARCHAR(128) NOT NULL,
  account_id VARCHAR(64) NOT NULL,
  label VARCHAR(255) NULL,
  created_at VARCHAR(32) NOT NULL,
  last_used_at VARCHAR(32) NULL,
  PRIMARY KEY (token_hash)
)`,
  'CREATE INDEX IF NOT EXISTS idx_hook_token_account ON hook_token (account_id)',
];

/**
 * Default organisation rules for the critical classes (spec §6, §7.2):
 * A-10 secrets/access, A-12 destructive git and A-15 policy edits are forbidden
 * (N0); A-09 data deletion and A-13 production actions need dual approval (N1).
 * Scope 'org', mode 'enforce' — a project can only tighten these, never widen.
 */
export const INIT_DEFAULT_RULES_SQL: string[] = [
  `INSERT INTO policy_rule (id, scope, project_id, action_class, zone_id, conditions_json, level, mode, created_at, updated_at)
 VALUES ('org-default-A-10', 'org', NULL, 'A-10', NULL, NULL, 0, 'enforce', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
 ON DUPLICATE KEY UPDATE level = 0, mode = 'enforce'`,
  `INSERT INTO policy_rule (id, scope, project_id, action_class, zone_id, conditions_json, level, mode, created_at, updated_at)
 VALUES ('org-default-A-12', 'org', NULL, 'A-12', NULL, NULL, 0, 'enforce', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
 ON DUPLICATE KEY UPDATE level = 0, mode = 'enforce'`,
  `INSERT INTO policy_rule (id, scope, project_id, action_class, zone_id, conditions_json, level, mode, created_at, updated_at)
 VALUES ('org-default-A-15', 'org', NULL, 'A-15', NULL, NULL, 0, 'enforce', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
 ON DUPLICATE KEY UPDATE level = 0, mode = 'enforce'`,
  `INSERT INTO policy_rule (id, scope, project_id, action_class, zone_id, conditions_json, level, mode, created_at, updated_at)
 VALUES ('org-default-A-09', 'org', NULL, 'A-09', NULL, NULL, 1, 'enforce', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
 ON DUPLICATE KEY UPDATE level = 1, mode = 'enforce'`,
  `INSERT INTO policy_rule (id, scope, project_id, action_class, zone_id, conditions_json, level, mode, created_at, updated_at)
 VALUES ('org-default-A-13', 'org', NULL, 'A-13', NULL, NULL, 1, 'enforce', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
 ON DUPLICATE KEY UPDATE level = 1, mode = 'enforce'`,
];

/** Level of every org default rule, keyed by action class (tests + resolver). */
export const DEFAULT_ORG_RULE_LEVELS: Record<string, number> = {
  'A-10': 0,
  'A-12': 0,
  'A-15': 0,
  'A-09': 1,
  'A-13': 1,
};

/**
 * Apply the DDL (then optionally the org seed rules) through any executor that
 * takes one SQL statement at a time — `sql.executeDDL`, `sql.executeRaw`, a
 * test stub.
 */
export async function applySchema(
  execute: (statement: string) => Promise<unknown>,
  options?: { withDefaultRules?: boolean },
): Promise<void> {
  for (const statement of SCHEMA_DDL) {
    await execute(statement);
  }
  if (options?.withDefaultRules) {
    for (const statement of INIT_DEFAULT_RULES_SQL) {
      await execute(statement);
    }
  }
}

// ------------------------------------------------------- row <-> type codecs

/** One database row as returned by the Forge SQL API. */
export type DbRow = Record<string, unknown>;

/** Column as string ('' for NULL). */
export const dbText = (value: unknown): string =>
  value === undefined || value === null ? '' : String(value);

/** Column as string, undefined for SQL NULL or empty. */
export const dbOptionalText = (value: unknown): string | undefined =>
  value === undefined || value === null || value === '' ? undefined : String(value);

/** Column as number (0 when not numeric). */
export const dbNumber = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** TINYINT(1) column as boolean. */
export const dbFlag = (value: unknown): boolean => dbNumber(value) !== 0;

/** Value for a JSON column (SQL NULL when absent). */
export const dbJson = (value: unknown): string | null =>
  value === undefined || value === null ? null : JSON.stringify(value);

/** Parse a JSON column; objects already decoded by the driver pass through. */
export function parseJsonColumn<T>(value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value as T;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return parsed === null ? undefined : (parsed as T);
  } catch {
    return undefined;
  }
}

export const ruleFromRow = (row: DbRow): PolicyRule => ({
  id: dbText(row.id),
  scope: dbText(row.scope) === 'org' ? 'org' : 'project',
  projectId: dbOptionalText(row.project_id),
  actionClass: dbText(row.action_class),
  zoneId: dbOptionalText(row.zone_id),
  conditions: parseJsonColumn<RuleConditions>(row.conditions_json),
  level: dbNumber(row.level) as PolicyRule['level'],
  mode: dbText(row.mode) === 'observe' ? 'observe' : 'enforce',
});

export const zoneFromRow = (row: DbRow): Zone => ({
  id: dbText(row.id),
  projectId: dbText(row.project_id),
  name: dbText(row.name),
  pathPatterns: parseJsonColumn<string[]>(row.path_patterns) ?? [],
  component: dbOptionalText(row.component),
  environment: dbOptionalText(row.environment) as Zone['environment'],
});

export const profileFromRow = (row: DbRow): AgentProfile => ({
  id: dbText(row.id),
  projectId: dbText(row.project_id),
  name: dbText(row.name),
  client: dbText(row.client),
  status: dbText(row.status) as AgentProfile['status'],
});

/** `scope_json` is the source of truth; the flat columns are the fallback. */
export const permitScopeFromRow = (row: DbRow): PermitScope =>
  parseJsonColumn<PermitScope>(row.scope_json) ?? {
    actionClass: dbText(row.action_class),
    target: dbText(row.target),
    issueKey: dbOptionalText(row.issue_key),
    projectId: dbText(row.project_id),
  };

export const permitFromRow = (row: DbRow): Permit => ({
  id: dbText(row.id),
  requestId: dbOptionalText(row.request_id),
  scope: permitScopeFromRow(row),
  holderProfileId: dbText(row.holder_profile_id),
  pilotAccountId: dbText(row.pilot_account_id),
  issuedAt: dbText(row.issued_at),
  expiresAt: dbText(row.expires_at),
  usesLeft: dbNumber(row.uses_left),
  signature: dbText(row.signature),
  revokedAt: dbOptionalText(row.revoked_at),
  suspended: dbFlag(row.suspended),
});

export const ledgerEntryFromRow = (row: DbRow): LedgerEntry => ({
  seq: dbNumber(row.seq),
  at: dbText(row.at),
  kind: dbText(row.kind) as LedgerEntry['kind'],
  projectId: dbText(row.project_id),
  issueId: dbOptionalText(row.issue_id),
  profileId: dbOptionalText(row.profile_id),
  pilotAccountId: dbOptionalText(row.pilot_account_id),
  actionClass: dbOptionalText(row.action_class),
  target: dbOptionalText(row.target),
  ruleId: dbOptionalText(row.rule_id),
  decision: dbOptionalText(row.decision),
  permitId: dbOptionalText(row.permit_id),
  detail: parseJsonColumn<Record<string, unknown>>(row.detail_json),
  correctsSeq: row.corrects_seq === undefined || row.corrects_seq === null
    ? undefined
    : dbNumber(row.corrects_seq),
  prevHash: dbText(row.prev_hash),
  hash: dbText(row.hash),
});

export const requestFromRow = (row: DbRow): ApprovalRequest => ({
  id: dbText(row.id),
  issueId: dbText(row.issue_id),
  projectId: dbText(row.project_id),
  profileId: dbText(row.profile_id),
  pilotAccountId: dbText(row.pilot_account_id),
  actionClass: dbText(row.action_class),
  target: dbText(row.target),
  justification: dbOptionalText(row.justification),
  plan: dbOptionalText(row.plan),
  level: dbNumber(row.level) as ApprovalRequest['level'],
  status: dbText(row.status) as ApprovalRequest['status'],
  createdAt: dbText(row.created_at),
  approvals: parseJsonColumn<Approval[]>(row.approvals_json) ?? [],
});

/** Trust capital is stored on the profile row (spec §17 `agent_profile`). */
export const trustStateFromRow = (row: DbRow): TrustState => ({
  profileId: dbText(row.id),
  score: dbNumber(row.trust_score),
  status: dbText(row.trust_status) === 'suspended' ? 'suspended' : 'active',
  lastActivityAt: dbOptionalText(row.trust_last_activity_at),
});

export const trustEventFromRow = (row: DbRow): TrustEvent => ({
  id: dbOptionalText(row.id),
  profileId: dbText(row.profile_id),
  kind: dbText(row.kind) as TrustEvent['kind'],
  delta: dbNumber(row.delta),
  reason: dbOptionalText(row.reason),
  ledgerSeq: row.ledger_seq === undefined || row.ledger_seq === null
    ? undefined
    : dbNumber(row.ledger_seq),
  at: dbText(row.at),
});

export const killSwitchFromRow = (row: DbRow): KillSwitchState => ({
  scope: dbText(row.scope) as RuleScope,
  projectId: dbOptionalText(row.project_id),
  active: dbFlag(row.active),
  by: dbOptionalText(row.toggled_by),
  reason: dbOptionalText(row.reason),
  at: dbOptionalText(row.at),
});

export const hookTokenFromRow = (row: DbRow): HookToken => ({
  accountId: dbText(row.account_id),
  tokenHash: dbText(row.token_hash),
  label: dbOptionalText(row.label),
  createdAt: dbText(row.created_at),
  lastUsedAt: dbOptionalText(row.last_used_at),
});
