/**
 * Storage facade — pick the adapter for the current runtime.
 *
 * Inside Forge (FORGE_ENVIRONMENT is set by the runtime) the SQL adapter is
 * used; everywhere else — unit tests, the simulation console run locally, a
 * script — the in-memory adapter keeps every decision testable offline.
 */
import { Repositories } from '../core/types';
import { createMemoryRepositories } from './memory';

export * from './memory';
export * from './sql';
export * from './schema';

/**
 * True when the code runs inside the Forge runtime.
 *
 * Forge exposes user variables as FORGE_USER_VAR_* and sets no reliable
 * "am I in Forge" flag, so the choice is explicit and defaults to the safe
 * side: PERMIS_STORAGE wins, then known offline contexts (jest workers, the
 * acceptance demo) opt out, and otherwise the SQL adapter is used when the SDK
 * actually loads.
 */
export function isForgeRuntime(): boolean {
  const forced = process.env?.PERMIS_STORAGE;
  if (forced === 'sql') return true;
  if (forced === 'memory') return false;
  if (process.env?.JEST_WORKER_ID || process.env?.PERMIS_OFFLINE === '1') return false;
  return canLoadForgeSql();
}

/** Can the Forge SQL SDK be loaded in this process? */
export function canLoadForgeSql(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forgeSql = require('@forge/sql');
    const client = forgeSql?.sql ?? forgeSql?.default?.sql ?? forgeSql?.default;
    return typeof client?.prepare === 'function' || typeof client?.executeRaw === 'function';
  } catch {
    return false;
  }
}

/** Lazily built singleton so one process shares one storage instance. */
let singleton: Repositories | undefined;

export function getDefaultRepositories(): Repositories {
  if (singleton) return singleton;
  let instance: Repositories;
  if (isForgeRuntime()) {
    // Imported lazily: @forge/sql must not be loaded outside the runtime.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createSqlRepositories } = require('./sql');
    instance = createSqlRepositories();
  } else {
    instance = createMemoryRepositories();
  }
  singleton = instance;
  return instance;
}

/** Test helper: drop the cached instance. */
export function resetDefaultRepositories(): void {
  singleton = undefined;
}

/**
 * Create the tables and seed the organisation floor rules on demand.
 *
 * The query path bootstraps reactively (only when a table is reported missing),
 * because replaying DDL on every cold start trips the Forge SQL rate limit
 * (429 RATE_LIMIT_EXCEEDED, observed live on the installation). This explicit
 * form is what the operator endpoint calls once after a first install, so the
 * very first decision does not pay for the DDL.
 */
export async function ensureSchema(): Promise<{ ok: boolean; detail: string }> {
  if (!isForgeRuntime()) return { ok: true, detail: 'memory adapter: no schema to create' };
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { bootstrapSqlSchema } = require('./sql-client');
    const result = await bootstrapSqlSchema();
    return {
      ok: true,
      detail: `${result.tables} tables (${result.statements} DDL statements), ${result.rules} organisation rules`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
