/**
 * Mutations of the Jira screens: grant, deny, revoke.
 *
 * The personal hook token is issued by the screens module (src/ui/resolvers.ts).
 *
 * They are registered on the same resolver as the read-only screens, so the
 * Forge screens share one definition map. Identity comes from the call
 * context (the Atlassian account), never from the payload; the pilot flag is
 * computed by comparing the account with the pilot of the request, which is
 * what makes self-approval impossible (spec PA-05).
 */
import { approveRequest, denyRequest, revokePermit } from '../services/approvals-service';
import { ApprovalRequest, Repositories } from '../core/types';

interface ResolverLike {
  define: (key: string, handler: (request: any) => Promise<unknown>) => void;
}

export interface MutationDeps {
  repos: Repositories;
  secret: string;
}

function accountIdOf(context: any): string {
  const id = context?.accountId ?? context?.extension?.accountId;
  return typeof id === 'string' && id.length > 0 ? id : 'unknown';
}

function rolesOf(payload: any): string[] {
  const roles = payload?.roles;
  return Array.isArray(roles) && roles.length > 0 ? roles.map(String) : ['user'];
}

async function requestPilot(repos: Repositories, requestId: string): Promise<string | undefined> {
  const request = await repos.requests.get(requestId);
  return (request as ApprovalRequest | undefined)?.pilotAccountId;
}

/** Register the write-side mutations on a Forge resolver. */
export function registerApprovalMutations(resolver: ResolverLike, deps: MutationDeps): void {
  resolver.define('grantRequest', async ({ payload, context }: any) => {
    const accountId = accountIdOf(context);
    const requestId = String(payload?.requestId ?? '');
    const pilotAccountId = await requestPilot(deps.repos, requestId);
    const outcome = await approveRequest({
      repos: deps.repos,
      secret: deps.secret,
      requestId,
      approver: { accountId, roles: rolesOf(payload), isPilot: pilotAccountId === accountId },
      reason: payload?.reason,
      ttlMinutes: typeof payload?.ttlMinutes === 'number' ? payload.ttlMinutes : undefined,
      uses: typeof payload?.uses === 'number' ? payload.uses : undefined,
    });
    return {
      ok: outcome.ok,
      error: outcome.error,
      requestId,
      status: outcome.request?.status,
      permit: outcome.permit?.id,
    };
  });

  resolver.define('denyRequest', async ({ payload, context }: any) => {
    const accountId = accountIdOf(context);
    const requestId = String(payload?.requestId ?? '');
    const pilotAccountId = await requestPilot(deps.repos, requestId);
    const outcome = await denyRequest({
      repos: deps.repos,
      secret: deps.secret,
      requestId,
      approver: { accountId, roles: rolesOf(payload), isPilot: pilotAccountId === accountId },
      reason: payload?.reason,
    });
    return { ok: outcome.ok, error: outcome.error, requestId, status: outcome.request?.status };
  });

  resolver.define('revokePermit', async ({ payload, context }: any) => {
    const accountId = accountIdOf(context);
    const permitId = String(payload?.permitId ?? '');
    const outcome = await revokePermit(deps.repos, permitId, accountId, payload?.reason);
    return { ok: outcome.ok, permitId, revoked: Boolean(outcome.permit?.revokedAt) };
  });

}
