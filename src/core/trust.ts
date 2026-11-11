/**
 * Trust capital (spec §9).
 *
 * Every agent profile owns a score between 0 and 100. It starts at 50, moves
 * with the events of the ledger and slowly erodes back to 50 when the agent
 * stays silent. A score of 0 suspends the profile: a suspended profile never
 * comes back on its own, a human review is required (see `reviveProfile`).
 *
 * Trust may bend autonomy levels but only inside a narrow band: N0..N2 are
 * never touched, and the read class A-01 is never demoted.
 */
import { isReadClass } from './catalog';
import { AutonomyLevel, TrustEventKind, TrustState } from './types';

/** Lowest reachable score. */
export const TRUST_MIN = 0;
/** Highest reachable score. */
export const TRUST_MAX = 100;
/** Neutral score: starting point and the point erosion drifts back to. */
export const TRUST_NEUTRAL = 50;
/** Above this score a trusted profile may act one step further on its own. */
export const TRUST_PROMOTE_ABOVE = 80;
/** Below this score a barely trusted profile loses its autonomy. */
export const TRUST_DEMOTE_BELOW = 30;

const MS_PER_DAY = 86_400_000;

/** Score impact of each trust event. Erosion is computed apart (see `erodeTrust`). */
export const TRUST_DELTAS: Record<TrustEventKind, number> = {
  'report-confirmed': 1,
  'permit-honored': 2,
  'report-corrected': -2,
  'undeclared-action': -10,
  'out-of-plan': -10,
  incident: -25,
  'forbidden-attempt': -5,
  erosion: 0,
};

/** A brand new profile: neutral score, active. */
export function initialTrustState(profileId: string): TrustState {
  return { profileId, score: TRUST_NEUTRAL, status: 'active' };
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return TRUST_MIN;
  return Math.min(TRUST_MAX, Math.max(TRUST_MIN, score));
}

function currentIso(): string {
  return new Date().toISOString();
}

/**
 * Apply one trust event on a copy of the state.
 *
 * - the score is clamped to 0..100;
 * - a score of 0 suspends the profile;
 * - a suspended profile stays suspended: an event alone never revives it;
 * - every kind but 'erosion' counts as activity and refreshes `lastActivityAt`.
 */
export function applyTrustEvent(
  state: TrustState,
  kind: TrustEventKind,
  at?: string,
): TrustState {
  const score = clampScore(state.score + TRUST_DELTAS[kind]);
  const status = state.status === 'suspended' || score === TRUST_MIN ? 'suspended' : 'active';
  const lastActivityAt = kind === 'erosion' ? state.lastActivityAt : at ?? currentIso();
  return { ...state, score, status, lastActivityAt };
}

/**
 * Human review outcome: the profile becomes active again.
 *
 * The score is kept as-is on purpose: the reviewer adjusts it with trust
 * events (`applyTrustEvent`), the review itself only lifts the suspension.
 */
export function reviveProfile(state: TrustState, at?: string): TrustState {
  return { ...state, status: 'active', lastActivityAt: at ?? currentIso() };
}

/**
 * Trust-driven level adjustment (spec §9).
 *
 * - a trusted profile (score > 80) may go from N3 to N4;
 * - a barely trusted profile (score < 30) loses N4/N5 and falls back to N3;
 * - N0, N1 and N2 are never touched (safety net);
 * - the read class A-01 is never demoted.
 */
export function trustAdjustLevel(
  level: AutonomyLevel,
  score: number,
  actionClass: string,
): AutonomyLevel {
  if (level <= 2) return level;
  if (score > TRUST_PROMOTE_ABOVE && level === 3) return 4;
  if (score < TRUST_DEMOTE_BELOW && !isReadClass(actionClass)) return 3;
  return level;
}

/** Move a score towards the neutral point, by at most `points`, never crossing it. */
function moveTowardsNeutral(score: number, points: number): number {
  if (score < TRUST_NEUTRAL) return Math.min(TRUST_NEUTRAL, score + points);
  if (score > TRUST_NEUTRAL) return Math.max(TRUST_NEUTRAL, score - points);
  return score;
}

/**
 * Slow erosion of an idle profile: the score drifts back to 50, one point per
 * day of inactivity by default. The status never changes here — erosion is
 * not an event, it is the absence of activity.
 */
export function erodeTrust(
  state: TrustState,
  nowIso: string,
  opts?: { pointsPerDay?: number },
): TrustState {
  if (!state.lastActivityAt) return state;
  const last = Date.parse(state.lastActivityAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return state;
  const days = Math.floor((now - last) / MS_PER_DAY);
  if (days <= 0) return state;
  const points = days * (opts?.pointsPerDay ?? 1);
  if (points <= 0) return state;
  return { ...state, score: moveTowardsNeutral(state.score, points) };
}
