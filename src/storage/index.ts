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

/** True when running inside the Forge runtime. */
export function isForgeRuntime(): boolean {
  return typeof process !== 'undefined' && Boolean(process.env?.FORGE_ENVIRONMENT);
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
