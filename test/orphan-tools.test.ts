/**
 * The three capabilities that existed only as services are now reachable:
 * `detect-drift` and `suggest-policy` as read-only MCP tools, `delegate-permit`
 * as a narrowing-only MCP tool, and `apply-drift` / `apply-suggestion` as
 * operator actions.
 *
 * The split is the point of these tests: reading is open to an agent, recording
 * a deviation (which moves the trust capital) and writing a rule (class A-15,
 * N0) are not.
 */
import { declareAction, delegatePermit, detectDrift, submitPlan, suggestPolicy } from '../src';
import { handleAdmin } from '../src/hooks/admin';
import { parseChanges, planActionsFrom } from '../src/mcp/handlers/reads';
import { resolveSigningSecret } from '../src/mcp/runtime';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { issuePermit, newPermitId } from '../src/core/permits';
import { makeEntry } from '../src/core/ledger';

const SECRET = resolveSigningSecret();
const PROJECT = 'PAY';
const ISSUE = 'PAY-42';

/** Call the operator endpoint with the installation secret. */
async function adminCall(body: unknown) {
  const response = await handleAdmin({
    method: 'POST',
    headers: { 'Content-Type': ['application/json'], 'X-Permis-Admin': [SECRET] },
    body: JSON.stringify(body),
    path: '/public/admin',
    userPath: '',
  } as never);
  return { statusCode: response.statusCode, payload: JSON.parse(response.body) };
}

/** A signed, active parent permit covering `db/migrations/*`. */
async function parentPermit(uses = 3, ttlMinutes = 60) {
  const repos = getDefaultRepositories();
  const issuedAt = new Date().toISOString();
  const year = new Date(issuedAt).getUTCFullYear();
  const sequence = await repos.permits.nextPermitSequence(year);
  const permit = issuePermit(
    {
      id: newPermitId(sequence, year),
      scope: { actionClass: 'A-08', target: 'db/migrations/*', issueKey: ISSUE, projectId: PROJECT },
      holderProfileId: 'parent-agent',
      pilotAccountId: 'pilot-1',
      issuedAt,
      ttlMinutes,
      uses,
    },
    SECRET,
  );
  await repos.permits.savePermit(permit);
  return permit;
}

async function ledgerCount(): Promise<number> {
  const repos = getDefaultRepositories();
  return (await repos.ledger.list({ projectId: PROJECT })).length;
}

beforeEach(() => {
  resetDefaultRepositories();
});

describe('detect-drift — read-only enforcement point 4', () => {
  it('reports an observed sensitive change that was never declared', async () => {
    const result = JSON.parse(
      await detectDrift({
        payload: { issueKey: ISSUE, changes: '[{"path":"db/migrations/010_late.sql","source":"ci-diff"}]' },
        context: { accountId: 'pilot-1' },
      }),
    );

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0].kind).toBe('undeclared');
    expect(result.recorded).toBe(false);
  });

  it('writes nothing: a read never moves the trust capital', async () => {
    const before = await ledgerCount();
    await detectDrift({
      payload: { issueKey: ISSUE, changes: '[{"path":"db/migrations/010_late.sql"}]' },
      context: { accountId: 'pilot-1' },
    });
    expect(await ledgerCount()).toBe(before);
  });

  it('finds no drift when the change was declared', async () => {
    await declareAction({
      payload: { issueKey: ISSUE, actionClass: 'A-08', target: 'db/migrations/001.sql', outcome: 'applied' },
      context: { accountId: 'pilot-1' },
    });

    const result = JSON.parse(
      await detectDrift({
        payload: { issueKey: ISSUE, changes: '[{"path":"db/migrations/001.sql"}]' },
        context: { accountId: 'pilot-1' },
      }),
    );
    expect(result.items).toHaveLength(0);
  });

  it('refuses changes it cannot parse, with the reason', async () => {
    const result = JSON.parse(
      await detectDrift({ payload: { issueKey: ISSUE, changes: 'not json' }, context: {} }),
    );
    expect(result.error).toBe('CHANGES_INVALID');
  });
});

describe('parseChanges and planActionsFrom', () => {
  it('accepts a JSON array and a real array alike', () => {
    expect(parseChanges('[{"path":"a.sql"}]')).toEqual([{ path: 'a.sql' }]);
    expect(parseChanges([{ command: 'git push' }])).toEqual([{ command: 'git push' }]);
  });

  it('rejects anything that is not a list of changes', () => {
    expect(parseChanges('{"path":"a.sql"}')).toBeUndefined();
    expect(parseChanges('[{"source":"ci"}]')).toBeUndefined();
    expect(parseChanges('')).toBeUndefined();
  });

  it('recovers the plan actions of the last submission from the ledger', async () => {
    const repos = getDefaultRepositories();
    const plan = JSON.stringify([
      { order: 1, actionClass: 'A-08', target: 'db/migrations/001.sql' },
      { order: 2, actionClass: 'A-02', target: 'src/index.ts' },
    ]);
    const prev = await repos.ledger.lastEntry(PROJECT);
    await repos.ledger.append(
      makeEntry({ kind: 'plan-submitted', projectId: PROJECT, issueId: ISSUE, detail: { plan }, at: new Date().toISOString() }, prev),
    );

    const entries = await repos.ledger.list({ projectId: PROJECT, issueId: ISSUE });
    const actions = planActionsFrom(entries, ISSUE);
    expect(actions).toHaveLength(2);
    expect(actions[1].target).toBe('src/index.ts');
  });

  it('returns no action when no plan was submitted', () => {
    expect(planActionsFrom([], ISSUE)).toEqual([]);
  });
});

describe('submit-plan journals the plan text', () => {
  it('so drift detection can compare an observed change with the approved plan', async () => {
    await submitPlan({
      payload: { issueKey: ISSUE, plan: '- A-08 db/migrations/001.sql' },
      context: { accountId: 'pilot-1' },
    });

    const repos = getDefaultRepositories();
    const entries = await repos.ledger.list({ projectId: PROJECT, issueId: ISSUE });
    const submission = entries.find((entry) => entry.kind === 'plan-submitted');
    const detail = submission?.detail as Record<string, unknown> | undefined;
    expect(typeof detail?.plan).toBe('string');
    expect(planActionsFrom(entries, ISSUE).length).toBeGreaterThan(0);
  });
});

describe('delegate-permit — narrowing only', () => {
  it('issues a narrower child permit and journals the link', async () => {
    const parent = await parentPermit();
    const result = JSON.parse(
      await delegatePermit({
        payload: { parentPermitId: parent.id, childProfileId: 'child-agent', target: 'db/migrations/001.sql', ttlMinutes: 15, uses: 1 },
        context: { accountId: 'pilot-1' },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.parentPermitId).toBe(parent.id);
    expect(result.permitId).toMatch(/^PA-\d{4}-\d{6}$/);
    expect(result.usesLeft).toBe(1);

    const repos = getDefaultRepositories();
    const entries = await repos.ledger.list({ projectId: PROJECT });
    const link = entries.find((entry) => (entry.detail as any)?.parentPermitId === parent.id);
    expect(link?.kind).toBe('permit-issued');
  });

  it('refuses a target wider than the parent scope', async () => {
    const parent = await parentPermit();
    const result = JSON.parse(
      await delegatePermit({
        payload: { parentPermitId: parent.id, childProfileId: 'child-agent', target: 'secrets/prod.env' },
        context: { accountId: 'pilot-1' },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('TARGET_TOO_WIDE');
    expect(result.note).toContain('never receives more');
  });

  it('refuses more uses than the parent has left', async () => {
    const parent = await parentPermit(2);
    const result = JSON.parse(
      await delegatePermit({
        payload: { parentPermitId: parent.id, childProfileId: 'child-agent', target: 'db/migrations/001.sql', uses: 5 },
        context: { accountId: 'pilot-1' },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('USES_TOO_MANY');
  });

  it('refuses an expiry past the parent', async () => {
    const parent = await parentPermit(3, 30);
    const result = JSON.parse(
      await delegatePermit({
        payload: { parentPermitId: parent.id, childProfileId: 'child-agent', target: 'db/migrations/001.sql', ttlMinutes: 600 },
        context: { accountId: 'pilot-1' },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('EXPIRY_TOO_LATE');
  });

  it('answers PARENT_NOT_FOUND rather than inventing a permit', async () => {
    const result = JSON.parse(
      await delegatePermit({
        payload: { parentPermitId: 'PA-2026-999999', childProfileId: 'child-agent', target: 'db/migrations/001.sql' },
        context: { accountId: 'pilot-1' },
      }),
    );
    expect(result.error).toBe('PARENT_NOT_FOUND');
  });

  it('requires the three inputs that define the delegation', async () => {
    const result = JSON.parse(
      await delegatePermit({ payload: { parentPermitId: 'PA-2026-000001' }, context: {} }),
    );
    expect(result.error).toBe('MISSING_INPUT');
  });
});

describe('suggest-policy — read-only proposals', () => {
  /** 20 granted approvals on A-05 (default N3): enough history to propose a relaxation. */
  async function seedGrantedHistory(actionClass: string, count = 20): Promise<void> {
    const repos = getDefaultRepositories();
    for (let i = 0; i < count; i++) {
      const prev = await repos.ledger.lastEntry(PROJECT);
      await repos.ledger.append(
        makeEntry(
          {
            kind: 'approval',
            projectId: PROJECT,
            issueId: ISSUE,
            actionClass,
            target: `package.json#${i}`,
            decision: 'allow',
            at: new Date(Date.now() - i * 3_600_000).toISOString(),
          },
          prev,
        ),
      );
    }
  }

  it('says plainly that nothing can be proposed without history', async () => {
    const result = JSON.parse(
      await suggestPolicy({ payload: { projectKey: PROJECT }, context: { accountId: 'pilot-1' } }),
    );

    expect(result.projectId).toBe(PROJECT);
    expect(result.count).toBe(0);
    expect(result.suggestions).toEqual([]);
    expect(result.note).toContain('No class has enough history');
  });

  it('proposes from the history, with its evidence, and says who may apply it', async () => {
    await seedGrantedHistory('A-05');

    const result = JSON.parse(
      await suggestPolicy({ payload: { projectKey: PROJECT, days: 30 }, context: { accountId: 'pilot-1' } }),
    );

    expect(result.count).toBeGreaterThan(0);
    const proposal = result.suggestions.find((item: any) => item.actionClass === 'A-05');
    expect(proposal).toBeDefined();
    expect(proposal.evidence.requests).toBe(20);
    expect(proposal.evidence.granted).toBe(20);
    expect(proposal.currentLevel).toBe('N3');
    // Reading is open to an agent; applying is class A-15 (N0).
    expect(result.note).toContain('A-15');
  });
});

describe('operator actions: apply-drift and apply-suggestion', () => {
  it('apply-drift records the gap and moves the trust capital', async () => {
    const before = await ledgerCount();
    const { statusCode, payload } = await adminCall({
      action: 'apply-drift',
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: 'default',
      changes: [{ path: 'db/migrations/010_late.sql', source: 'ci-diff' }],
      by: 'operator',
    });

    expect(statusCode).toBe(200);
    expect(payload.penalized).toBeGreaterThan(0);
    expect(await ledgerCount()).toBeGreaterThan(before);
  });

  it('apply-drift is idempotent: a repeated CI run does not drain trust', async () => {
    const body = {
      action: 'apply-drift',
      projectId: PROJECT,
      issueKey: ISSUE,
      profileId: 'default',
      changes: [{ path: 'db/migrations/010_late.sql' }],
      by: 'operator',
    };
    const first = await adminCall(body);
    const second = await adminCall(body);

    expect(first.payload.penalized).toBeGreaterThan(0);
    expect(second.payload.penalized).toBe(0);
    expect(second.payload.skipped).toBe(first.payload.penalized);
  });

  it('apply-drift refuses changes it cannot parse', async () => {
    const { statusCode, payload } = await adminCall({
      action: 'apply-drift',
      projectId: PROJECT,
      changes: 'not json',
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toBe('CHANGES_INVALID');
  });

  it('apply-suggestion requires a named author', async () => {
    const { statusCode, payload } = await adminCall({
      action: 'apply-suggestion',
      projectId: PROJECT,
      suggestionId: 'whatever',
    });
    expect(statusCode).toBe(400);
    expect(payload.error).toBe('ACTOR_REQUIRED');
  });

  it('apply-suggestion answers 404 for a suggestion the history does not support', async () => {
    const { statusCode, payload } = await adminCall({
      action: 'apply-suggestion',
      projectId: PROJECT,
      suggestionId: 'PS-2026-999999',
      by: 'operator',
    });
    expect(statusCode).toBe(404);
    expect(payload.error).toBe('SUGGESTION_NOT_FOUND');
  });

  it('lists both actions among the allowed operator commands', async () => {
    const { payload } = await adminCall({ action: 'nope', projectId: PROJECT });
    expect(payload.error).toBe('UNKNOWN_ACTION');
    expect(payload.allowed).toEqual(expect.arrayContaining(['apply-drift', 'apply-suggestion']));
  });
});
