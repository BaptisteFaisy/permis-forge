/**
 * Trust capital state and events.
 *
 * Models the per-profile trust score (0..100, starts at 50), the kinds of events
 * that move it (with their deltas), and the persisted trust state.
 */

export type TrustEventKind =
  | 'report-confirmed'   // +1
  | 'permit-honored'     // +2
  | 'report-corrected'   // -2
  | 'undeclared-action'  // -10
  | 'out-of-plan'        // -10
  | 'incident'           // -25
  | 'forbidden-attempt'  // -5
  | 'erosion';           // slow drift back to 50

export interface TrustState {
  profileId: string;
  /** 0..100, starts at 50. */
  score: number;
  status: 'active' | 'suspended';
  lastActivityAt?: string;
}

export interface TrustEvent {
  id?: string;
  profileId: string;
  kind: TrustEventKind;
  delta: number;
  reason?: string;
  ledgerSeq?: number;
  at: string;
}
