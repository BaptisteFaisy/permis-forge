/**
 * Core autonomy levels, decisions, and environments.
 *
 * Defines the N0..N5 autonomy spectrum, the hook decisions (allow/ask/deny),
 * and target environment classification.
 */

/** Autonomy level N0 (forbidden) .. N5 (fully autonomous). */
export type AutonomyLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** What the enforcement point does with a decision. */
export type HookDecision = 'allow' | 'ask' | 'deny';

/** Environment a target belongs to. */
export type Environment = 'development' | 'staging' | 'production';
