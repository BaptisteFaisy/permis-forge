import {
  TRUST_DELTAS,
  applyTrustEvent,
  erodeTrust,
  initialTrustState,
  reviveProfile,
  trustAdjustLevel,
} from '../src/core/trust';
import { TrustState } from '../src/core/types';

/** Build a state at a given score, optionally with a last activity date. */
function stateAt(score: number, lastActivityAt?: string, status: TrustState['status'] = 'active'): TrustState {
  return { profileId: 'prof-1', score, status, lastActivityAt };
}

const DAY = '2026-01-01T00:00:00.000Z';
const DAY_PLUS_10 = '2026-01-11T00:00:00.000Z';

describe('trust capital', () => {
  it('starts every profile at 50 and active', () => {
    expect(initialTrustState('prof-1')).toEqual({ profileId: 'prof-1', score: 50, status: 'active' });
  });

  it('carries the documented deltas', () => {
    expect(TRUST_DELTAS).toEqual({
      'report-confirmed': 1,
      'permit-honored': 2,
      'report-corrected': -2,
      'undeclared-action': -10,
      'out-of-plan': -10,
      incident: -25,
      'forbidden-attempt': -5,
      erosion: 0,
    });
  });

  it('applies +1, +2 and -2', () => {
    expect(applyTrustEvent(stateAt(50), 'report-confirmed', DAY).score).toBe(51);
    expect(applyTrustEvent(stateAt(50), 'permit-honored', DAY).score).toBe(52);
    expect(applyTrustEvent(stateAt(50), 'report-corrected', DAY).score).toBe(48);
  });

  it('applies the heavy penalties (-10, -25, -5)', () => {
    expect(applyTrustEvent(stateAt(50), 'undeclared-action', DAY).score).toBe(40);
    expect(applyTrustEvent(stateAt(50), 'out-of-plan', DAY).score).toBe(40);
    expect(applyTrustEvent(stateAt(50), 'incident', DAY).score).toBe(25);
    expect(applyTrustEvent(stateAt(50), 'forbidden-attempt', DAY).score).toBe(45);
  });

  it('clamps the score to 0..100', () => {
    expect(applyTrustEvent(stateAt(100), 'permit-honored', DAY).score).toBe(100);
    expect(applyTrustEvent(stateAt(99), 'permit-honored', DAY).score).toBe(100);
    expect(applyTrustEvent(stateAt(10), 'incident', DAY).score).toBe(0);
    expect(applyTrustEvent(stateAt(2), 'report-corrected', DAY).score).toBe(0);
  });

  it('suspends the profile when the score hits 0', () => {
    const next = applyTrustEvent(stateAt(10), 'incident', DAY);
    expect(next).toEqual({ profileId: 'prof-1', score: 0, status: 'suspended', lastActivityAt: DAY });
  });

  it('never revives a suspended profile on its own', () => {
    let state = applyTrustEvent(stateAt(5), 'incident', DAY);
    expect(state.status).toBe('suspended');
    state = applyTrustEvent(state, 'permit-honored', DAY_PLUS_10);
    expect(state.score).toBe(2);
    expect(state.status).toBe('suspended');
  });

  it('does not mutate the state it receives', () => {
    const before = stateAt(50, DAY);
    const next = applyTrustEvent(before, 'permit-honored', DAY_PLUS_10);
    expect(next).not.toBe(before);
    expect(before).toEqual({ profileId: 'prof-1', score: 50, status: 'active', lastActivityAt: DAY });
  });

  it('records the activity date, except for erosion', () => {
    const active = applyTrustEvent(stateAt(50), 'report-confirmed', DAY_PLUS_10);
    expect(active.lastActivityAt).toBe(DAY_PLUS_10);
    const idle = applyTrustEvent(stateAt(50, DAY), 'erosion');
    expect(idle.score).toBe(50);
    expect(idle.lastActivityAt).toBe(DAY);
    expect(applyTrustEvent(stateAt(50), 'erosion').lastActivityAt).toBeUndefined();
  });

  it('defaults the activity date to now', () => {
    expect(applyTrustEvent(stateAt(50), 'report-confirmed').lastActivityAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('revives only through a human review, keeping the score', () => {
    const suspended = applyTrustEvent(stateAt(5), 'incident', DAY);
    const revived = reviveProfile(suspended, DAY_PLUS_10);
    expect(revived).toEqual({ profileId: 'prof-1', score: 0, status: 'active', lastActivityAt: DAY_PLUS_10 });
    expect(revived.score).toBe(suspended.score);
  });

  it('adjusts levels with trust only inside the allowed band', () => {
    // A trusted profile may step from N3 to N4.
    expect(trustAdjustLevel(3, 85, 'A-02')).toBe(4);
    expect(trustAdjustLevel(3, 80, 'A-02')).toBe(3);
    // N2 and below are never touched.
    expect(trustAdjustLevel(2, 85, 'A-02')).toBe(2);
    expect(trustAdjustLevel(1, 85, 'A-02')).toBe(1);
    expect(trustAdjustLevel(0, 85, 'A-02')).toBe(0);
    // A barely trusted profile loses N4/N5, except for reading.
    expect(trustAdjustLevel(4, 20, 'A-02')).toBe(3);
    expect(trustAdjustLevel(5, 20, 'A-02')).toBe(3);
    expect(trustAdjustLevel(4, 20, 'A-01')).toBe(4);
    expect(trustAdjustLevel(5, 20, 'A-01')).toBe(5);
    expect(trustAdjustLevel(2, 20, 'A-02')).toBe(2);
    expect(trustAdjustLevel(1, 20, 'A-02')).toBe(1);
    // Nothing happens in the neutral band.
    expect(trustAdjustLevel(4, 50, 'A-02')).toBe(4);
    expect(trustAdjustLevel(3, 50, 'A-02')).toBe(3);
  });

  it('erodes an idle profile towards 50 without crossing it', () => {
    expect(erodeTrust(stateAt(80, DAY), DAY_PLUS_10).score).toBe(70);
    expect(erodeTrust(stateAt(80, DAY), DAY_PLUS_10, { pointsPerDay: 3 }).score).toBe(50);
    expect(erodeTrust(stateAt(80, DAY), DAY_PLUS_10, { pointsPerDay: 20 }).score).toBe(50);
  });

  it('erodes a punished profile back up towards 50', () => {
    expect(erodeTrust(stateAt(20, DAY), DAY_PLUS_10).score).toBe(30);
    expect(erodeTrust(stateAt(20, DAY), DAY_PLUS_10, { pointsPerDay: 10 }).score).toBe(50);
    expect(erodeTrust(stateAt(20, DAY), DAY_PLUS_10, { pointsPerDay: 20 }).score).toBe(50);
  });

  it('leaves the state untouched when there is no activity to measure', () => {
    const idle = stateAt(80);
    expect(erodeTrust(idle, DAY_PLUS_10)).toBe(idle);
    expect(erodeTrust(stateAt(80, DAY), DAY).score).toBe(80);
    expect(erodeTrust(stateAt(80, DAY), '2025-12-31T00:00:00.000Z').score).toBe(80);
    expect(erodeTrust(stateAt(50, DAY), DAY_PLUS_10).score).toBe(50);
  });

  it('never changes the status while eroding', () => {
    const suspended = stateAt(0, DAY, 'suspended');
    const eroded = erodeTrust(suspended, DAY_PLUS_10);
    expect(eroded.status).toBe('suspended');
    // Erosion pulls the score up towards 50, it never crosses it.
    expect(eroded.score).toBe(10);
  });
});
