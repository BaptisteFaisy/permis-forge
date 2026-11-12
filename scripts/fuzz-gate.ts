/**
 * Command-line fuzz of the gate — the same cases as `test/gate-fuzz.test.ts`,
 * runnable by hand:
 *
 *   node scripts/fuzz-gate.mjs --cases 2000 --seed 7
 *
 * Offline: in-memory repositories, no network, no Jira site. Exit code 0 when
 * no invariant is broken, 1 with the offending inputs otherwise.
 */
import { resetVerificationBudget } from '../src/hooks/gate';
import { createHookToken } from '../src/services/approvals-service';
import { getDefaultRepositories, resetDefaultRepositories } from '../src/storage';
import { runFuzz } from './fuzz-lib';

// Outside Jest nothing forces the storage backend, and the SQL adapter would be
// picked as soon as `@forge/sql` loads. The fuzz runs offline, on the in-memory
// adapter — the same choice the acceptance demo makes (scripts/scenario-lib.ts).
process.env.PERMIS_OFFLINE = '1';

/** Read a numeric `--flag value` from the command line. */
function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main(): Promise<number> {
  const cases = arg('cases', 500);
  const seed = arg('seed', 20261112);

  resetDefaultRepositories();
  resetVerificationBudget();
  const repos = getDefaultRepositories();
  const { token } = await createHookToken(repos, 'fuzz-cli', 'scripts/fuzz-gate.mjs');

  // The gate logs every refusal it answers; that noise would bury the report.
  const stderr = console.error;
  console.error = () => undefined;
  const { violations, checked } = await runFuzz(cases, seed, token);
  console.error = stderr;

  console.log(`fuzz gate — ${checked} cases, seed ${seed}`);
  if (violations.length === 0) {
    console.log('no violation: no throw, no unexpected status, no dangerous payload allowed');
    return 0;
  }
  for (const violation of violations.slice(0, 20)) {
    console.log(`case ${violation.index}: ${violation.reason}`);
    console.log(`  input: ${JSON.stringify(violation.body).slice(0, 300)}`);
  }
  console.log(`${violations.length} violation(s)`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error('fuzz failed to run:', error);
    process.exit(2);
  },
);
