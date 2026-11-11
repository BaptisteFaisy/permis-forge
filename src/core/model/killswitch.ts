/**
 * Kill switch state and toggle contracts.
 *
 * The kill switch is the emergency stop: when active, everything is denied
 * (or frozen) at org or project scope, and permits are suspended, not destroyed.
 */

import type { RuleScope } from './policy';

export interface KillSwitchState {
  scope: RuleScope;
  projectId?: string;
  active: boolean;
  by?: string;
  reason?: string;
  at?: string;
}

export interface KillSwitchToggle {
  activate: boolean;
  by: string;
  reason: string;
  at?: string;
  /** Project setting: lifting requires someone else (spec §12). */
  requireDifferentPerson?: boolean;
}
