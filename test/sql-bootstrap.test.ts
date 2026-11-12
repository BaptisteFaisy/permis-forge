/**
 * Unit tests for the reactive Forge SQL schema bootstrap.
 *
 * The regression these guard against is real and was observed on the deployed
 * installation: replaying the whole DDL (23 statements) on every cold start made
 * Forge SQL answer `429 RATE_LIMIT_EXCEEDED`, and every gated action failed
 * closed. The schema must therefore be created only when a query reports a
 * missing table, and never on the happy path.
 */
import { SqlDb, bootstrapSqlSchema } from '../src/storage/sql-client';
import { INIT_DEFAULT_RULES_SQL, SCHEMA_DDL } from '../src/storage/schema';

interface FakeClient {
  ddlCalls: string[];
  queries: string[];
  failUntilTableCreated: boolean;
  prepare: (query: string) => { bindParams: (...args: unknown[]) => { execute: () => Promise<{ rows: unknown[] }> } };
  executeDDL: (statement: string) => Promise<{ rows: unknown[] }>;
}

/** A SQL client that mimics Forge: tables missing until the DDL has run. */
function fakeClient(options: { failUntilTableCreated: boolean }): FakeClient {
  const created = new Set<string>();
  const client: FakeClient = {
    ddlCalls: [],
    queries: [],
    failUntilTableCreated: options.failUntilTableCreated,
    prepare(query: string) {
      return {
        bindParams: () => ({
          execute: async () => {
            client.queries.push(query);
            const table = /FROM\s+`?(\w+)`?/i.exec(query)?.[1] ?? '';
            if (client.failUntilTableCreated && table && !created.has(table)) {
              throw new Error(`Table '${table}' doesn't exist (1146)`);
            }
            return { rows: [] };
          },
        }),
      };
    },
    executeDDL: async (statement: string) => {
      client.ddlCalls.push(statement);
      const table = /CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(statement)?.[1];
      if (table) created.add(table);
      return { rows: [] };
    },
  };
  return client;
}

function dbOf(client: FakeClient): SqlDb {
  return new SqlDb(
    async (query) => {
      const statement = client.prepare(query).bindParams();
      const result = await statement.execute();
      return result.rows as never[];
    },
    (statement) => client.executeDDL(statement),
  );
}

describe('reactive schema bootstrap', () => {
  it('issues no DDL at all when the tables already exist', async () => {
    const client = fakeClient({ failUntilTableCreated: false });
    const db = dbOf(client);

    await db.rows('SELECT * FROM `policy_rule`', []);
    await db.rows('SELECT * FROM `ledger`', []);

    expect(client.ddlCalls).toHaveLength(0);
  });

  it('bootstraps once when a query reports a missing table, then retries', async () => {
    const client = fakeClient({ failUntilTableCreated: true });
    const db = dbOf(client);

    await db.rows('SELECT * FROM `policy_rule`', []);

    expect(client.ddlCalls.length).toBeGreaterThan(0);
    // The failed SELECT is retried once the schema exists (the bootstrap also
    // runs five INSERTs through the same runner, hence the SELECT filter).
    const selects = client.queries.filter(
      (query) => query.startsWith('SELECT') && query.includes('policy_rule'),
    );
    expect(selects).toHaveLength(2);
  });

  it('does not replay the DDL for the next queries of the same container', async () => {
    const client = fakeClient({ failUntilTableCreated: true });
    const db = dbOf(client);

    await db.rows('SELECT * FROM `policy_rule`', []);
    const afterFirst = client.ddlCalls.length;
    await db.rows('SELECT * FROM `zone`', []);
    await db.rows('SELECT * FROM `permit`', []);

    expect(client.ddlCalls.length).toBe(afterFirst);
  });

  it('translates a non-schema failure instead of bootstrapping', async () => {
    const client = fakeClient({ failUntilTableCreated: false });
    const db = dbOf(client);
    client.prepare = () => {
      throw new Error('connection reset');
    };

    await expect(db.rows('SELECT 1', [])).rejects.toThrow(/\[forge-sql\]/);
    expect(client.ddlCalls).toHaveLength(0);
  });
});

describe('bootstrapSqlSchema', () => {
  it('creates every table and seeds the organisation floor rules', async () => {
    const client = fakeClient({ failUntilTableCreated: false });
    const result = await bootstrapSqlSchema(client);

    expect(result.statements).toBe(SCHEMA_DDL.length);
    expect(result.tables).toBe(SCHEMA_DDL.filter((s) => /CREATE TABLE/i.test(s)).length);
    expect(result.tables).toBeLessThan(result.statements);
    expect(result.rules).toBe(INIT_DEFAULT_RULES_SQL.length);
    expect(client.ddlCalls).toHaveLength(SCHEMA_DDL.length);
  });

  it('tolerates a duplicate index instead of failing the install', async () => {
    const client = fakeClient({ failUntilTableCreated: false });
    client.executeDDL = async (statement: string) => {
      client.ddlCalls.push(statement);
      if (/CREATE INDEX/i.test(statement)) throw new Error("Duplicate key name 'idx_x' (1061)");
      return { rows: [] };
    };

    await expect(bootstrapSqlSchema(client)).resolves.toBeDefined();
  });

  it('refuses a client without a DDL endpoint', async () => {
    await expect(bootstrapSqlSchema({ prepare: () => undefined })).rejects.toThrow(/DDL/);
  });
});
