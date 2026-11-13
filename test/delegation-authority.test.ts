/**
 * A delegation only narrows a permit the caller **holds** (13 November 2026).
 *
 * Before this check, `delegate-permit` looked the parent up by id among *all*
 * permits. An agent could therefore hand a sub-agent a permit issued to
 * another pilot, and the "narrowing only" promise would be relative to a
 * permit the caller never received. The parent is now checked against the
 * caller's identity: same holder profile, same pilot account.
 */
import { delegatePermit } from '../src';
import { issuePermit, newPermitId } from '../src/core/permits';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';

const SECRET = resolveSigningSecret();
const PROJECT = 'PAY';
const ISSUE = 'PAY-42';
const TARGET = 'db/migrations/001_init.sql';

/** A signed, active parent permit held by `holderProfileId` for `pilotAccountId`. */
async function parentPermit(holderProfileId: string, pilotAccountId: string) {
  const repos = getDefaultRepositories();
  const issuedAt = new Date().toISOString();
  const year = new Date(issuedAt).getUTCFullYear();
  const sequence = await repos.permits.nextPermitSequence(year);
  const permit = issuePermit(
    {
      id: newPermitId(sequence, year),
      scope: { actionClass: 'A-08', target: 'db/migrations/*', issueKey: ISSUE, projectId: PROJECT },
      holderProfileId,
      pilotAccountId,
      issuedAt,
      ttlMinutes: 60,
      uses: 3,
    },
    SECRET,
  );
  await repos.permits.savePermit(permit);
  return permit;
}

async function delegate(
  parentPermitId: string,
  context: Record<string, unknown>,
  agentProfile?: string,
): Promise<Record<string, unknown>> {
  const raw = await delegatePermit({
    payload: { parentPermitId, childProfileId: 'child-agent', target: TARGET, agentProfile },
    context,
  });
  return JSON.parse(raw);
}

describe('delegate-permit — only the permit the caller holds', () => {
  beforeEach(() => resetDefaultRepositories());

  it('refuses a permit issued to another pilot', async () => {
    const parent = await parentPermit('build-agent', 'pilot-other');

    const result = await delegate(parent.id, { accountId: 'pilot-1' }, 'build-agent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('PARENT_NOT_HELD');
  });

  it('refuses another agent’s permit, even for the same pilot', async () => {
    const parent = await parentPermit('other-agent', 'pilot-1');

    const result = await delegate(parent.id, { accountId: 'pilot-1' }, 'build-agent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('PARENT_NOT_HELD');
  });

  it('refuses a permit held by a named profile when the caller names none', async () => {
    const parent = await parentPermit('build-agent', 'pilot-1');

    const result = await delegate(parent.id, { accountId: 'pilot-1' });

    expect(result.error).toBe('PARENT_NOT_HELD');
  });

  it('refuses when the caller has no authenticated account', async () => {
    const parent = await parentPermit('build-agent', 'pilot-1');

    const result = await delegate(parent.id, {}, 'build-agent');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('MISSING_PILOT');
  });

  it('still reports a parent that does not exist', async () => {
    const result = await delegate('PA-2026-999999', { accountId: 'pilot-1' }, 'build-agent');

    expect(result.error).toBe('PARENT_NOT_FOUND');
  });

  it('delegates the permit it holds, and the child keeps the same pilot', async () => {
    const parent = await parentPermit('build-agent', 'pilot-1');

    const result = await delegate(parent.id, { accountId: 'pilot-1' }, 'build-agent');

    expect(result.ok).toBe(true);
    const child = (await getDefaultRepositories().permits.listPermits({})).find(
      (permit) => permit.id === result.permitId,
    );
    expect(child?.holderProfileId).toBe('child-agent');
    expect(child?.pilotAccountId).toBe('pilot-1');
  });
});