/**
 * Forge SQL repositories: one factory per storage port of `src/core/types.ts`.
 *
 * Connection, schema bootstrap and query helpers live in `./sql-client`; the
 * column <-> type mapping lives in `./schema`. This file only translates
 * between domain objects and rows.
 */
import { ApprovalRequest, LedgerEntry, LedgerFilter, Repositories } from '../core/types';
import { killSwitchKey } from './memory';
import {
  DbRow, dbJson, dbNumber, hookTokenFromRow, killSwitchFromRow, ledgerEntryFromRow, permitFromRow,
  profileFromRow, requestFromRow, ruleFromRow, trustEventFromRow, trustStateFromRow, zoneFromRow,
} from './schema';
import {
  Clause, Params, SqlDb, countSequence, createDdlRunner, createRunner, loadForgeSqlClient,
  nowIso, where,
} from './sql-client';

// ------------------------------------------------------------- repositories

function createSqlPolicies(db: SqlDb): Repositories['policies'] {
  return {
    listRules: (projectId) => db.all(
      'SELECT * FROM `policy_rule` WHERE `scope` = ? OR (`scope` = ? AND `project_id` = ?) ORDER BY `id` ASC',
      ['org', 'project', projectId], ruleFromRow,
    ),
    upsertRule: (rule) => db.upsert('policy_rule', {
      id: rule.id, scope: rule.scope, project_id: rule.projectId ?? null, action_class: rule.actionClass,
      zone_id: rule.zoneId ?? null, conditions_json: dbJson(rule.conditions), level: rule.level,
      mode: rule.mode, created_at: nowIso(), updated_at: nowIso(),
    }, ['id'], ['created_at']),
    deleteRule: (id) => db.rows('DELETE FROM `policy_rule` WHERE `id` = ?', [id]).then(() => undefined),
  };
}

function createSqlZones(db: SqlDb): Repositories['zones'] {
  return {
    listZones: (projectId) =>
      db.all('SELECT * FROM `zone` WHERE `project_id` = ? ORDER BY `id` ASC', [projectId], zoneFromRow),
    upsertZone: (zone) => db.upsert('zone', {
      id: zone.id, project_id: zone.projectId, name: zone.name,
      path_patterns: JSON.stringify(zone.pathPatterns ?? []),
      component: zone.component ?? null, environment: zone.environment ?? null,
    }),
    deleteZone: (id) => db.rows('DELETE FROM `zone` WHERE `id` = ?', [id]).then(() => undefined),
  };
}

function createSqlProfiles(db: SqlDb): Repositories['profiles'] {
  return {
    getProfile: (projectId, profileId) => db.one(
      'SELECT * FROM `agent_profile` WHERE `project_id` = ? AND `id` = ? LIMIT 1',
      [projectId, profileId], profileFromRow,
    ),
    listProfiles: (projectId) => db.all(
      'SELECT * FROM `agent_profile` WHERE `project_id` = ? ORDER BY `id` ASC',
      [projectId], profileFromRow,
    ),
    // Trust columns are insert-only: re-registering never resets trust capital (spec §9).
    upsertProfile: (profile) => db.upsert('agent_profile', {
      id: profile.id, project_id: profile.projectId, name: profile.name, client: profile.client,
      status: profile.status, trust_score: 50, trust_status: 'active', trust_last_activity_at: null,
    }, ['id'], ['trust_score', 'trust_status', 'trust_last_activity_at']),
  };
}

function createSqlPermits(db: SqlDb): Repositories['permits'] {
  return {
    async listPermits(filter) {
      const clause = where([
        { sql: '`project_id` = ?', value: filter.projectId },
        { sql: '`issue_key` = ?', value: filter.issueKey },
        { sql: '`holder_profile_id` = ?', value: filter.profileId },
      ]);
      return db.all(
        `SELECT * FROM \`permit\`${clause.sql} ORDER BY \`issued_at\` ASC, \`id\` ASC`,
        clause.params,
        permitFromRow,
      );
    },
    async savePermit(permit) {
      await db.upsert('permit', {
        id: permit.id,
        request_id: permit.requestId ?? null,
        scope_json: JSON.stringify(permit.scope),
        action_class: permit.scope.actionClass,
        target: permit.scope.target,
        issue_key: permit.scope.issueKey ?? null,
        project_id: permit.scope.projectId,
        holder_profile_id: permit.holderProfileId,
        pilot_account_id: permit.pilotAccountId,
        issued_at: permit.issuedAt,
        expires_at: permit.expiresAt,
        uses_left: permit.usesLeft,
        signature: permit.signature,
        revoked_at: permit.revokedAt ?? null,
        suspended: permit.suspended ? 1 : 0,
      });
    },
    async nextPermitSequence(year) {
      return countSequence(db, 'permit', `PA-${year}`);
    },
  };
}

/** Ledger row of an entry: absent optional fields become SQL NULL. */
function ledgerColumns(entry: LedgerEntry): DbRow {
  return {
    seq: entry.seq,
    at: entry.at,
    kind: entry.kind,
    project_id: entry.projectId,
    issue_id: entry.issueId ?? null,
    profile_id: entry.profileId ?? null,
    pilot_account_id: entry.pilotAccountId ?? null,
    action_class: entry.actionClass ?? null,
    target: entry.target ?? null,
    rule_id: entry.ruleId ?? null,
    decision: entry.decision ?? null,
    permit_id: entry.permitId ?? null,
    detail_json: dbJson(entry.detail),
    corrects_seq: entry.correctsSeq ?? null,
    prev_hash: entry.prevHash,
    hash: entry.hash,
  };
}

/** `WHERE` fragments of a ledger filter; unset filters are skipped. */
function ledgerClauses(filter: LedgerFilter): Clause[] {
  return [
    { sql: '`project_id` = ?', value: filter.projectId },
    { sql: '`issue_id` = ?', value: filter.issueId },
    { sql: '`profile_id` = ?', value: filter.profileId },
    { sql: '`action_class` = ?', value: filter.actionClass },
    { sql: '`kind` = ?', value: filter.kind },
    { sql: '`at` >= ?', value: filter.since },
    { sql: '`at` <= ?', value: filter.until },
  ];
}

function createSqlLedger(db: SqlDb): Repositories['ledger'] {
  return {
    async lastEntry(projectId) {
      return db.one(
        'SELECT * FROM `ledger` WHERE `project_id` = ? ORDER BY `seq` DESC LIMIT 1',
        [projectId],
        ledgerEntryFromRow,
      );
    },
    async append(entry) {
      await db.insert('ledger', ledgerColumns(entry));
    },
    async list(filter) {
      const clause = where(ledgerClauses(filter));
      const limit = filter.limit === undefined
        ? ''
        : ` LIMIT ${Math.max(0, Math.floor(filter.limit))}`;
      return db.all(
        `SELECT * FROM \`ledger\`${clause.sql} ORDER BY \`project_id\` ASC, \`seq\` ASC${limit}`,
        clause.params,
        ledgerEntryFromRow,
      );
    },
  };
}

/** create() and update() write the same row; only the caller intent differs. */
function writeRequest(db: SqlDb, request: ApprovalRequest): Promise<void> {
  return db.upsert('request', {
    id: request.id,
    issue_id: request.issueId,
    project_id: request.projectId,
    profile_id: request.profileId,
    pilot_account_id: request.pilotAccountId,
    action_class: request.actionClass,
    target: request.target,
    justification: request.justification ?? null,
    plan: request.plan ?? null,
    level: request.level,
    status: request.status,
    created_at: request.createdAt,
    approvals_json: JSON.stringify(request.approvals ?? []),
  });
}

function createSqlRequests(db: SqlDb): Repositories['requests'] {
  return {
    async create(request) {
      await writeRequest(db, request);
    },
    async get(requestId) {
      return db.one('SELECT * FROM `request` WHERE `id` = ? LIMIT 1', [requestId], requestFromRow);
    },
    async update(request) {
      await writeRequest(db, request);
    },
    async listPending(issueKey) {
      const clause = where([{ sql: '`issue_id` = ?', value: issueKey }], 'AND');
      return db.all(
        "SELECT * FROM `request` WHERE `status` = 'pending'" + clause.sql +
          ' ORDER BY `created_at` ASC',
        clause.params,
        requestFromRow,
      );
    },
    async nextRequestSequence(year) {
      return countSequence(db, 'request', `RQ-${year}`);
    },
  };
}

function createSqlTrust(db: SqlDb): Repositories['trust'] {
  return {
    async getState(profileId) {
      return db.one(
        'SELECT * FROM `agent_profile` WHERE `id` = ? LIMIT 1',
        [profileId],
        trustStateFromRow,
      );
    },
    async saveState(trustState) {
      // Identity columns are insert-only: saving trust must not blank a
      // profile row that already exists.
      await db.upsert(
        'agent_profile',
        {
          id: trustState.profileId,
          project_id: null,
          name: '',
          client: '',
          status: 'active',
          trust_score: trustState.score,
          trust_status: trustState.status,
          trust_last_activity_at: trustState.lastActivityAt ?? null,
        },
        ['id'],
        ['project_id', 'name', 'client', 'status'],
      );
    },
    async recordEvent(event) {
      await db.insert('trust_event', {
        profile_id: event.profileId,
        kind: event.kind,
        delta: event.delta,
        reason: event.reason ?? null,
        ledger_seq: event.ledgerSeq ?? null,
        at: event.at,
      });
    },
    async listEvents(profileId) {
      return db.all(
        'SELECT * FROM `trust_event` WHERE `profile_id` = ? ORDER BY `id` ASC',
        [profileId],
        trustEventFromRow,
      );
    },
  };
}

function createSqlKillSwitches(db: SqlDb): Repositories['killSwitches'] {
  return {
    async get(scope, projectId) {
      return db.one(
        'SELECT * FROM `kill_switch` WHERE `id` = ? LIMIT 1',
        [killSwitchKey(scope, projectId)],
        killSwitchFromRow,
      );
    },
    async listActive(projectId) {
      return db.all(
        'SELECT * FROM `kill_switch` WHERE `active` = 1 AND (`scope` = ? OR `project_id` = ?) ' +
          'ORDER BY `id` ASC',
        ['org', projectId],
        killSwitchFromRow,
      );
    },
    async save(killSwitch) {
      await db.upsert('kill_switch', {
        id: killSwitchKey(killSwitch.scope, killSwitch.projectId),
        scope: killSwitch.scope,
        project_id: killSwitch.projectId ?? null,
        active: killSwitch.active ? 1 : 0,
        toggled_by: killSwitch.by ?? null,
        reason: killSwitch.reason ?? null,
        at: killSwitch.at ?? null,
      });
    },
  };
}

function createSqlHookTokens(db: SqlDb): Repositories['hookTokens'] {
  return {
    async findByTokenHash(hash) {
      return db.one(
        'SELECT * FROM `hook_token` WHERE `token_hash` = ? LIMIT 1',
        [hash],
        hookTokenFromRow,
      );
    },
    async save(token) {
      await db.upsert(
        'hook_token',
        {
          token_hash: token.tokenHash,
          account_id: token.accountId,
          label: token.label ?? null,
          created_at: token.createdAt,
          last_used_at: token.lastUsedAt ?? null,
        },
        ['token_hash'],
      );
    },
    async listForAccount(accountId) {
      return db.all(
        'SELECT * FROM `hook_token` WHERE `account_id` = ? ORDER BY `created_at` ASC',
        [accountId],
        hookTokenFromRow,
      );
    },
    async touchLastUsed(hash, at) {
      await db.rows('UPDATE `hook_token` SET `last_used_at` = ? WHERE `token_hash` = ?', [at, hash]);
    },
    async revoke(hash, by, reason, at) {
      await db.upsert(
        'token_revocation',
        { token_hash: hash, revoked_by: by, reason: reason ?? null, revoked_at: at },
        ['token_hash'],
      );
    },
    async isRevoked(hash) {
      const found = await db.one(
        'SELECT `token_hash` FROM `token_revocation` WHERE `token_hash` = ? LIMIT 1',
        [hash],
        (row) => row?.token_hash != null,
      );
      return found === true;
    },
  };
}

/**
 * Build the SQL-backed repositories. Without an explicit client the Forge SQL
 * SDK is loaded lazily; when neither is available the caller gets one clear
 * error instead of a cryptic failure deep inside a query.
 */
export function createSqlRepositories(sqlClient?: any): Repositories {
  const client = sqlClient ?? loadForgeSqlClient();
  if (!client) {
    throw new Error('No SQL client available: pass one explicitly or run inside Forge.');
  }
  const db = new SqlDb(createRunner(client), createDdlRunner(client));
  return {
    policies: createSqlPolicies(db),
    zones: createSqlZones(db),
    profiles: createSqlProfiles(db),
    permits: createSqlPermits(db),
    ledger: createSqlLedger(db),
    requests: createSqlRequests(db),
    trust: createSqlTrust(db),
    killSwitches: createSqlKillSwitches(db),
    hookTokens: createSqlHookTokens(db),
  };
}
