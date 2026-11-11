/**
 * Forge SQL client layer: connection, schema bootstrap and query helpers.
 *
 * Any client exposing `execute(query, params)`, the Forge SDK shape
 * `prepare(query).bindParams(...params).execute()`, or `executeRaw(query)`
 * works. The Forge SDK is loaded lazily, so importing this module outside a
 * Forge runtime never crashes.
 *
 * The schema is created on first use: Forge SQL has no migration step, so the
 * ten `CREATE TABLE IF NOT EXISTS` statements and the organisation floor rules
 * are replayed idempotently, and a duplicate index (MySQL has no
 * `CREATE INDEX IF NOT EXISTS`) is treated as expected rather than fatal.
 */
import { DbRow, dbNumber, INIT_DEFAULT_RULES_SQL, SCHEMA_DDL } from './schema';

export type Params = unknown[];
export type SqlRunner = (query: string, params: Params) => Promise<DbRow[]>;
/** One `WHERE` fragment plus its bound value (skipped when undefined). */
export interface Clause {
  sql: string;
  value?: unknown;
}

// ------------------------------------------------------------------- client

export const nowIso = (): string => new Date().toISOString();

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Extract the row array from any supported client response shape. */
function toRows(result: unknown): DbRow[] {
  if (!result || typeof result !== 'object') return [];
  const candidate = result as { rows?: unknown; updateQueryResponse?: { rows?: unknown } };
  const rows = candidate.rows ?? candidate.updateQueryResponse?.rows;
  return Array.isArray(rows) ? (rows as DbRow[]) : [];
}

/** Build a runner around any supported SQL client. */
export function createRunner(client: any): SqlRunner {
  if (client && typeof client.execute === 'function') {
    return async (query, params) => toRows(await client.execute(query, params));
  }
  if (client && typeof client.prepare === 'function') {
    return async (query, params) => {
      const statement = client.prepare(query);
      const bound = typeof statement?.bindParams === 'function'
        ? statement.bindParams(...params)
        : statement;
      return toRows(await bound.execute(params));
    };
  }
  if (client && typeof client.executeRaw === 'function') {
    return async (query) => toRows(await client.executeRaw(query));
  }
  throw new Error('Unsupported SQL client: expected execute(), prepare() or executeRaw().');
}

/** Load the Forge SQL client lazily: a missing SDK must not crash the import. */
export function loadForgeSqlClient(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forgeSql = require('@forge/sql');
    return forgeSql?.sql ?? forgeSql?.default?.sql;
  } catch {
    return undefined;
  }
}

/** DDL goes through a dedicated endpoint on Forge SQL. */
export function createDdlRunner(client: any): ((statement: string) => Promise<unknown>) | undefined {
  if (client && typeof client.executeDDL === 'function') {
    return (statement: string) => client.executeDDL(statement);
  }
  if (client && typeof client.executeRaw === 'function') {
    return (statement: string) => client.executeRaw(statement);
  }
  return undefined;
}

/** A duplicate index is expected on every run after the first: ignore it. */
function isBenignDdlError(error: unknown): boolean {
  return /duplicate key name|already exists|1061/i.test(errorMessage(error));
}

/** Create the ten tables, then seed the organisation floor rules. */
async function runBootstrap(ddl: (statement: string) => Promise<unknown>, runner: SqlRunner): Promise<void> {
  for (const statement of SCHEMA_DDL) {
    try {
      await ddl(statement);
    } catch (error) {
      if (!isBenignDdlError(error)) throw error;
    }
  }
  for (const statement of INIT_DEFAULT_RULES_SQL) {
    await runner(statement, []);
  }
}

// -------------------------------------------------------------------- SQL db

/** Thin wrapper: schema bootstrap, error translation, insert / upsert builders. */
export class SqlDb {
  private bootstrap?: Promise<void>;

  constructor(
    private readonly runner: SqlRunner,
    private readonly ddl?: (statement: string) => Promise<unknown>,
  ) {}

  /**
   * Create the tables on first use (idempotent) and seed the organisation
   * floor rules. Index statements are tolerated: MySQL has no
   * `CREATE INDEX IF NOT EXISTS`, so a second run reports a duplicate name.
   */
  private ensureSchema(): Promise<void> {
    if (!this.ddl) return Promise.resolve();
    if (!this.bootstrap) {
      this.bootstrap = runBootstrap(this.ddl, this.runner).catch((error) => {
        this.bootstrap = undefined;
        throw error;
      });
    }
    return this.bootstrap;
  }

  async rows(query: string, params: Params = []): Promise<DbRow[]> {
    await this.ensureSchema();
    try {
      return await this.runner(query, params);
    } catch (error) {
      throw new Error(`[forge-sql] ${errorMessage(error)} :: ${query}`);
    }
  }

  async one<T>(query: string, params: Params, map: (row: DbRow) => T): Promise<T | undefined> {
    const rows = await this.rows(query, params);
    return rows.length > 0 ? map(rows[0]) : undefined;
  }

  async all<T>(query: string, params: Params, map: (row: DbRow) => T): Promise<T[]> {
    return (await this.rows(query, params)).map(map);
  }

  /** Plain INSERT — append-only tables (ledger, trust_event). */
  async insert(table: string, data: DbRow): Promise<void> {
    const columns = Object.keys(data);
    await this.rows(
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) ` +
        `VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => data[column]),
    );
  }

  /**
   * INSERT ... ON DUPLICATE KEY UPDATE. Columns listed in `keys` (primary key)
   * and in `insertOnly` (written once: created_at, or the trust columns of a
   * profile) are never refreshed on conflict.
   */
  async upsert(table: string, data: DbRow, keys = ['id'], insertOnly: string[] = []): Promise<void> {
    const columns = Object.keys(data);
    const skip = new Set([...keys, ...insertOnly]);
    const updated = columns.filter((column) => !skip.has(column));
    await this.rows(
      `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) ` +
        `VALUES (${columns.map(() => '?').join(', ')}) ON DUPLICATE KEY UPDATE ` +
        updated.map((column) => `\`${column}\` = ?`).join(', '),
      [...columns.map((c) => data[c]), ...updated.map((c) => data[c])],
    );
  }
}

/** Join fragments into ` WHERE a = ? AND b = ?`, skipping undefined values. */
export function where(clauses: Clause[], keyword = 'WHERE'): { sql: string; params: Params } {
  const kept = clauses.filter((clause) => clause.value !== undefined && clause.value !== '');
  return {
    sql: kept.length === 0 ? '' : ` ${keyword} ${kept.map((clause) => clause.sql).join(' AND ')}`,
    params: kept.map((clause) => clause.value),
  };
}

/** Sequence for "PA-<year>-nnnnnn" / "RQ-<year>-nnnnnn": rows so far, plus one. */
export async function countSequence(db: SqlDb, table: string, idPrefix: string): Promise<number> {
  const rows = await db.rows(`SELECT COUNT(*) AS \`c\` FROM \`${table}\` WHERE \`id\` LIKE ?`, [
    `${idPrefix}-%`,
  ]);
  return (rows.length > 0 ? dbNumber(rows[0].c) : 0) + 1;
}

