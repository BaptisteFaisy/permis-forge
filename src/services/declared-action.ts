/**
 * Declared actions (spec §10, enforcement point 4).
 *
 * An action that was not declared is an action nobody can audit. Two paths
 * write the declaration, and they must write the same thing: the `declare-action`
 * MCP tool (the agent declares itself) and the gate's `declare` mode (the
 * client hook reports the action after it ran). One implementation, so the
 * ledger cannot end up with two shapes of the same entry.
 */
import { makeEntry } from '../core/ledger';
import { maskSecrets } from '../core/mask';
import { LedgerEntry, Repositories } from '../core/types';

export interface DeclaredActionInput {
  projectId: string;
  issueKey?: string;
  profileId: string;
  pilotAccountId: string;
  actionClass: string;
  target: string;
  /** What happened, in one sentence. Never a secret. */
  outcome: string;
  permitId?: string;
  at: string;
}

/** Write the declaration into the chained ledger and return the entry. */
export async function recordDeclaredAction(
  repos: Repositories,
  input: DeclaredActionInput,
): Promise<LedgerEntry> {
  const prev = await repos.ledger.lastEntry(input.projectId);
  const entry = makeEntry(
    {
      kind: 'action-declared',
      projectId: input.projectId,
      issueId: input.issueKey,
      profileId: input.profileId,
      pilotAccountId: input.pilotAccountId,
      actionClass: input.actionClass,
      target: maskSecrets(input.target),
      permitId: input.permitId,
      detail: { outcome: maskSecrets(input.outcome) },
      at: input.at,
    },
    prev,
  );
  await repos.ledger.append(entry);
  return entry;
}
