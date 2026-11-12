/**
 * Adversarial tests for the gate: the product promises "closed by default", so
 * the promise deserves an attack, not an assertion.
 *
 * The generators live in `scripts/fuzz-lib.ts`, shared with the command-line
 * runner (`node scripts/fuzz-gate.mjs`), so a case that fails here is a case an
 * operator can reproduce by hand with the same seed.
 */
import { runFuzz } from '../scripts/fuzz-lib';
import { resetVerificationBudget } from '../src/hooks/gate';
import { handleGate, WebTriggerRequest } from '../src/hooks/gate';
import { createHookToken } from '../src/services/approvals-service';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';

const SEED = 20261112;
const CASES = 300;

describe('gate under fuzz', () => {
  let token: string;

  beforeEach(async () => {
    resetDefaultRepositories();
    resetVerificationBudget();
    const repos = getDefaultRepositories();
    token = (await createHookToken(repos, 'pilot-fuzz', 'fuzz')).token;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it(`never throws and never allows a dangerous payload over ${CASES} seeded cases`, async () => {
    const { violations, checked } = await runFuzz(CASES, SEED, token);

    expect(checked).toBe(CASES);
    // A violation names its case, its reason and its exact input.
    expect(violations.map((item) => `case ${item.index}: ${item.reason}`)).toEqual([]);
  });

  it('holds with a different seed, so it is not tuned to one sequence', async () => {
    const { violations } = await runFuzz(120, SEED + 7, token);
    expect(violations.map((item) => `case ${item.index}: ${item.reason}`)).toEqual([]);
  });

  it('survives a body that is not JSON at all', async () => {
    const response = await handleGate({
      method: 'POST',
      headers: { 'Content-Type': ['application/json'] },
      body: '{not json',
      path: '/public/gate',
      userPath: '',
    } as WebTriggerRequest);

    expect(response.statusCode).not.toBe(200);
  });

  it('refuses a permit verification once the window budget is spent', async () => {
    let last = 200;
    for (let i = 0; i < 61; i++) {
      const response = await handleGate({
        method: 'POST',
        headers: { 'Content-Type': ['application/json'] },
        body: JSON.stringify({ permitId: 'PA-2026-900002' }),
        path: '/public/gate',
        userPath: '',
      } as WebTriggerRequest);
      last = response.statusCode;
    }
    expect(last).toBe(429);
  });
});
