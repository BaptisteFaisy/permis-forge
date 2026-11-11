/**
 * Emergency brake (spec §12).
 *
 * The kill switch stops every write action of a project (or of the whole org)
 * without destroying the permits already issued: they are suspended and come
 * back when the brake is released. Reading (A-01) is never blocked — an agent
 * must always be able to look at what is going on.
 *
 * Two rules protect the brake itself:
 * - activating it and releasing it both require a written reason;
 * - releasing it may require a different person than the one who activated it.
 */
import { isReadClass } from './catalog';
import { KillSwitchState, KillSwitchToggle, RuleScope } from './types';

/** Error thrown when no reason is given for activating or releasing the brake. */
export const REASON_REQUIRED = 'REASON_REQUIRED';
/** Error thrown when the same person tries to release the brake they activated. */
export const DIFFERENT_PERSON_REQUIRED = 'DIFFERENT_PERSON_REQUIRED';

/**
 * True when the brake is down for the given project: either an org-wide brake
 * is active, or a project brake targets that very project.
 */
export function killSwitchActiveFor(states: KillSwitchState[], projectId: string): boolean {
  return states.some(
    (state) =>
      state.active &&
      (state.scope === 'org' || (state.scope === 'project' && state.projectId === projectId)),
  );
}

/**
 * True when the brake blocks the given action class. Only the read class
 * A-01 goes through.
 */
export function killSwitchBlocks(actionClass: string): boolean {
  return !isReadClass(actionClass);
}

/**
 * Activate or release the brake.
 *
 * @throws Error(REASON_REQUIRED) when the reason is missing or blank.
 * @throws Error(DIFFERENT_PERSON_REQUIRED) when releasing requires another
 *         person and the current holder is the one asking.
 */
export function toggleKillSwitch(
  target: { scope: RuleScope; projectId?: string },
  current: KillSwitchState | undefined,
  toggle: KillSwitchToggle,
): KillSwitchState {
  const reason = (toggle.reason ?? '').trim();
  if (!reason) throw new Error(REASON_REQUIRED);
  if (!toggle.activate && toggle.requireDifferentPerson && current?.by === toggle.by) {
    throw new Error(DIFFERENT_PERSON_REQUIRED);
  }
  const projectId = target.scope === 'project' ? target.projectId : undefined;
  return {
    scope: target.scope,
    projectId,
    active: toggle.activate,
    by: toggle.by,
    reason,
    at: toggle.at ?? new Date().toISOString(),
  };
}
