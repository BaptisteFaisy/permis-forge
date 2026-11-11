import {
  DIFFERENT_PERSON_REQUIRED,
  REASON_REQUIRED,
  killSwitchActiveFor,
  killSwitchBlocks,
  toggleKillSwitch,
} from '../src/core/killswitch';
import { KillSwitchState } from '../src/core/types';

const ORG_DOWN: KillSwitchState = { scope: 'org', active: true, by: 'alice', reason: 'incident', at: '2026-01-01T00:00:00.000Z' };
const PROJECT_A_DOWN: KillSwitchState = {
  scope: 'project',
  projectId: 'PROJ-A',
  active: true,
  by: 'alice',
  reason: 'deploy window',
  at: '2026-01-01T00:00:00.000Z',
};

describe('kill switch', () => {
  it('blocks every project when an org-wide brake is active', () => {
    expect(killSwitchActiveFor([ORG_DOWN], 'PROJ-A')).toBe(true);
    expect(killSwitchActiveFor([ORG_DOWN], 'PROJ-Z')).toBe(true);
  });

  it('blocks only the project a project brake targets', () => {
    expect(killSwitchActiveFor([PROJECT_A_DOWN], 'PROJ-A')).toBe(true);
    expect(killSwitchActiveFor([PROJECT_A_DOWN], 'PROJ-B')).toBe(false);
  });

  it('ignores released brakes and unrelated projects', () => {
    expect(killSwitchActiveFor([{ ...ORG_DOWN, active: false }], 'PROJ-A')).toBe(false);
    expect(killSwitchActiveFor([{ ...PROJECT_A_DOWN, active: false }], 'PROJ-A')).toBe(false);
    expect(killSwitchActiveFor([], 'PROJ-A')).toBe(false);
    expect(killSwitchActiveFor([{ scope: 'project', active: true }], 'PROJ-A')).toBe(false);
  });

  it('blocks every action class except reading', () => {
    expect(killSwitchBlocks('A-01')).toBe(false);
    expect(killSwitchBlocks('A-02')).toBe(true);
    expect(killSwitchBlocks('A-12')).toBe(true);
    expect(killSwitchBlocks('X-custom')).toBe(true);
  });

  it('activates the brake with a reason and an author', () => {
    const state = toggleKillSwitch(
      { scope: 'project', projectId: 'PROJ-A' },
      undefined,
      { activate: true, by: 'alice', reason: 'incident INC-42', at: '2026-01-02T10:00:00.000Z' },
    );
    expect(state).toEqual({
      scope: 'project',
      projectId: 'PROJ-A',
      active: true,
      by: 'alice',
      reason: 'incident INC-42',
      at: '2026-01-02T10:00:00.000Z',
    });
  });

  it('drops the project id for an org-wide brake and stamps the date', () => {
    const state = toggleKillSwitch({ scope: 'org', projectId: 'PROJ-A' }, undefined, {
      activate: true,
      by: 'alice',
      reason: 'org-wide incident',
    });
    expect(state.scope).toBe('org');
    expect(state.projectId).toBeUndefined();
    expect(state.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('requires a reason for activation and for release alike', () => {
    const release = (reason: string) =>
      toggleKillSwitch({ scope: 'org' }, ORG_DOWN, { activate: false, by: 'bob', reason });
    expect(() => release('')).toThrow(new Error(REASON_REQUIRED));
    expect(() => release('   ')).toThrow(new Error(REASON_REQUIRED));
    expect(() => release(undefined as unknown as string)).toThrow(new Error(REASON_REQUIRED));
    expect(() => release('incident closed')).not.toThrow();
    const activate = (reason: string) =>
      toggleKillSwitch({ scope: 'project', projectId: 'PROJ-A' }, undefined, { activate: true, by: 'alice', reason });
    expect(() => activate('')).toThrow(new Error(REASON_REQUIRED));
  });

  it('refuses a release by the very person who pulled the brake', () => {
    expect(() =>
      toggleKillSwitch({ scope: 'org' }, ORG_DOWN, {
        activate: false,
        by: 'alice',
        reason: 'all clear',
        requireDifferentPerson: true,
      }),
    ).toThrow(new Error(DIFFERENT_PERSON_REQUIRED));
  });

  it('accepts a release from somebody else', () => {
    const released = toggleKillSwitch({ scope: 'org' }, ORG_DOWN, {
      activate: false,
      by: 'bob',
      reason: 'all clear',
      requireDifferentPerson: true,
      at: '2026-01-03T09:00:00.000Z',
    });
    expect(released).toEqual({
      scope: 'org',
      projectId: undefined,
      active: false,
      by: 'bob',
      reason: 'all clear',
      at: '2026-01-03T09:00:00.000Z',
    });
    expect(killSwitchActiveFor([released], 'PROJ-A')).toBe(false);
  });

  it('lets the same person release when the project does not require a different one', () => {
    const released = toggleKillSwitch({ scope: 'org' }, ORG_DOWN, {
      activate: false,
      by: 'alice',
      reason: 'all clear',
    });
    expect(released.active).toBe(false);
    expect(released.by).toBe('alice');
  });
});
