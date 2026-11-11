/**
 * Shared contracts for the "Permis d'agir" (Agent Permits) Forge app.
 *
 * This file is the BARREL: every core module imports its types from here and
 * nowhere else, so the pure decision logic stays unit-testable outside the
 * Forge runtime. The actual definitions live in src/core/model/ — one file per
 * domain (levels, actions, policy, permits, ledger, trust, killswitch,
 * requests, gate, plan, decision, profiles, storage).
 *
 * Naming follows the product spec (docs/SPEC.md): action classes A-01..A-15,
 * autonomy levels N0..N5, permits, chained ledger, trust capital, kill switch.
 *
 * Convention: levels are numbers 0..5 — LOWER IS MORE RESTRICT. The most
 * restrictive applicable rule always wins (min of levels).
 */

export * from './model/levels';
export * from './model/actions';
export * from './model/policy';
export * from './model/permits';
export * from './model/ledger';
export * from './model/trust';
export * from './model/killswitch';
export * from './model/requests';
export * from './model/gate';
export * from './model/plan';
export * from './model/decision';
export * from './model/profiles';
export * from './model/storage';
