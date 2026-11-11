/**
 * Personal hook token tool — `create-hook-token`.
 *
 * The token identifies the pilot on the hook gate. It is normally issued from
 * the personal settings screen; this tool offers the same self-service to an
 * agent-driven workflow (Rovo chat or an external MCP client), because the
 * caller identity comes from the Atlassian context and never from the inputs
 * (spec §16): you can only ever mint a token for yourself.
 *
 * The plaintext token is returned once and never stored — only its SHA-256
 * hash is kept, so a leaked database cannot be replayed against the gate.
 */
import { createHookToken } from '../../services/approvals-service';
import { getRuntime, resolveAccountId, toJson } from '../runtime';
import { HandlerArgs } from './reads';

/** create-hook-token — mint a personal gate token for the calling account. */
export async function createToken({ payload, context }: HandlerArgs): Promise<string> {
  const runtime = await getRuntime();
  const accountId = resolveAccountId(context);
  if (accountId === 'unknown') {
    return toJson({
      ok: false,
      error: 'IDENTITY_REQUIRED',
      guidance:
        'The caller identity is missing from the Atlassian context. ' +
        'Generate the token from the personal settings screen instead.',
    });
  }
  const label = typeof payload?.label === 'string' && payload.label.trim().length > 0
    ? payload.label.trim().slice(0, 60)
    : undefined;
  const created = await createHookToken(runtime.repos, accountId, label);
  const existing = await runtime.repos.hookTokens.listForAccount(accountId);
  return toJson({
    ok: true,
    accountId,
    // Shown once: store it in PERMIS_AGENT_TOKEN on the machine that runs the agent.
    token: created.token,
    tokenHash: created.hash,
    tokenCount: existing.length,
    usage: {
      environmentVariable: 'PERMIS_AGENT_TOKEN',
      header: 'Authorization: Bearer $PERMIS_AGENT_TOKEN',
      ticketHeader: 'X-Permis-Issue: <ISSUE-KEY> (required for actions beyond N4)',
    },
    notice:
      'This token is shown once and only its hash is stored. Rotate it by creating a new one ' +
      'if it ever leaks.',
  });
}
