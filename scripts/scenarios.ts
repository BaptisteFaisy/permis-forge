/**
 * The eleven acceptance scenarios of spec §21, run offline against the real
 * decision engine. `node scripts/demo.mjs` prints them; `test/demo.test.ts`
 * asserts them. No network, no Jira site, no Forge runtime.
 */
import { handleGate } from '../src/hooks/gate';
import { buildHookFile } from '../src/core/gate';
import { verifyLedgerIntegrity } from '../src/ui/audit';
import { callResolver, createResolvers } from '../src/ui/resolvers';
import { checkPermission } from '../src/mcp/handlers/reads';
import { makeEntry, verifyChain } from '../src/core/ledger';
import { approveRequest } from '../src/services/approvals-service';
import { issuePermit, newPermitId, revokePermit } from '../src/core/permits';
import { getRuntimeSync } from '../src/mcp/runtime';
import { getDefaultRepositories } from '../src/storage';
import {
  APPROVER,
  ISSUE,
  PILOT,
  PROFILE,
  PROJECT,
  SECRET,
  Scenario,
  World,
  activateKillSwitch,
  addRule,
  caller,
  decide,
  grantPermit,
  makeWorld,
  result,
  seedGateRuntime,
  setTrust,
} from './scenario-lib';

/** 1. A migration announced as a code edit is reclassified, and told. */
async function scenario1() {
  const world = makeWorld();
  const decision = await decide(world, 'db/migrations/001_init.sql', 'A-02');
  const ok =
    decision.classification.actionClass === 'A-08' &&
    decision.classification.reclassified === true &&
    decision.level === 2;
  return result(1, 'Reclassification of a migration announced as A-02', ok,
    `class ${decision.classification.actionClass} (declared A-02), level N${decision.level}, reason: ${decision.classification.reason}`);
}

/** 2. The pilot cannot approve their own request; a third party can. */
async function scenario2() {
  const world = makeWorld();
  // The policy names the role allowed to approve migrations (spec §8.2).
  await addRule(world, { id: 'mig-approver', actionClass: 'A-08', level: 2, approverRole: 'tech-lead' });
  const decision = await decide(world, 'db/migrations/002_add_index.sql');
  const requestId = decision.requestId ?? '';
  const asPilot = await approveAs(world, requestId, PILOT, true);
  const pilotBlocked = asPilot.ok === false && asPilot.error === 'PILOT_CANNOT_APPROVE';
  const asThirdParty = await approveAs(world, requestId, APPROVER, false);
  const ok = pilotBlocked && asThirdParty.ok === true && Boolean(asThirdParty.permit?.id);
  return result(2, 'Approval on the ticket, pilot excluded', ok,
    `request ${requestId} created; pilot refused (${asPilot.error}); ${APPROVER} granted permit ${asThirdParty.permit?.id}`);
}

/** Approve a request as a given account; `isPilot` reproduces self-approval. */
async function approveAs(world: World, requestId: string, accountId: string, isPilot: boolean) {
  return approveRequest({
    repos: world.repos,
    secret: SECRET,
    requestId,
    approver: { accountId, roles: ['tech-lead'], isPilot },
    reason: 'Demo approval',
    ttlMinutes: 30,
    uses: 1,
    now: world.now,
  });
}

/** 3. A permit lets the action through once, then refuses the second. */
async function scenario3() {
  const world = makeWorld();
  const target = 'db/migrations/003_rename.sql';
  await grantPermit(world, 'A-08', target, { uses: 1 });
  const first = await decide(world, target);
  const second = await decide(world, target);
  return result(3, 'Permit consumed on first use', first.decision === 'allow' && second.decision === 'deny',
    `first: ${first.decision} (permit ${first.permitConsumed}); second: ${second.decision}, request ${second.requestId}`);
}

/** 4. An expired or revoked permit lets nothing through. */
async function scenario4() {
  const world = makeWorld();
  const expiredTarget = 'db/migrations/004_expired.sql';
  await grantPermit(world, 'A-08', expiredTarget, { issuedAt: '2026-11-11T06:00:00.000Z', ttlMinutes: 30 });
  const expired = await decide(world, expiredTarget);
  const revokedTarget = 'db/migrations/005_revoked.sql';
  const permit = await grantPermit(world, 'A-08', revokedTarget);
  await world.repos.permits.savePermit(revokePermit(permit, world.now));
  const revoked = await decide(world, revokedTarget);
  return result(4, 'Expired and revoked permits refuse', expired.decision === 'deny' && revoked.decision === 'deny',
    `expired permit: ${expired.decision}; revoked permit: ${revoked.decision}`);
}

/** 5. A-10 (secrets) is refused whatever the trust capital. */
async function scenario5() {
  const world = makeWorld();
  await setTrust(world, 100);
  const decision = await decide(world, '.env.production', 'A-10');
  return result(5, 'Secrets stay forbidden at trust 100', decision.decision === 'deny' && decision.level === 0,
    `class ${decision.classification.actionClass}, level N${decision.level}, trust 100 → ${decision.decision}`);
}

/** 6. Emergency stop: everything beyond reading is refused, permit or not. */
async function scenario6() {
  const world = makeWorld();
  const target = 'db/migrations/006_during_stop.sql';
  await grantPermit(world, 'A-08', target);
  await activateKillSwitch(world);
  const write = await decide(world, target);
  const read = await decide(world, 'src/index.ts', 'A-01');
  return result(6, 'Emergency stop overrides permits', write.decision === 'deny' && read.decision === 'allow',
    `migration with a valid permit: ${write.decision} (N${write.level}); reading: ${read.decision}`);
}

/** 7. The hook refuses a data deletion without a permit, allows it with one. */
async function scenario7() {
  const { repos, token } = await seedGateRuntime();
  const command = 'psql -c "DELETE FROM sessions WHERE created_at < now()"';
  const without = await postHook(command, token, ISSUE);
  const sequence = await repos.permits.nextPermitSequence(2026);
  await repos.permits.savePermit(issuePermit({
    id: newPermitId(sequence, 2026),
    scope: { actionClass: 'A-09', target: command, issueKey: ISSUE, projectId: PROJECT },
    holderProfileId: 'default',
    pilotAccountId: PILOT,
    issuedAt: new Date().toISOString(),
    ttlMinutes: 30,
    uses: 1,
  }, SECRET));
  const withPermit = await postHook(command, token, ISSUE);
  const noTicket = await postHook(command, token, undefined);
  return result(7, 'Hook gate: deletion blocked, then allowed with a permit',
    without === 'deny' && withPermit === 'allow' && noTicket === 'deny',
    `without permit: ${without}; with permit: ${withPermit}; without a ticket: ${noTicket} (spec §20)`);
}

/** POST one hook event to the gate; the ticket travels in a header. */
async function postHook(command: string, token?: string, issueKey?: string): Promise<string> {
  const headers: Record<string, string[]> = { 'Content-Type': ['application/json'] };
  if (token) headers.Authorization = [`Bearer ${token}`];
  if (issueKey) headers['X-Permis-Issue'] = [issueKey];
  const response = await handleGate({
    method: 'POST',
    headers,
    body: JSON.stringify({ toolName: 'Bash', args: { command }, cwd: '/tmp/demo' }),
    path: '/public/gate',
    userPath: '',
  });
  if (response.statusCode !== 200) return `http-${response.statusCode}`;
  const body = JSON.parse(response.body);
  return String(body?.hookSpecificOutput?.permissionDecision ?? 'none');
}

/** 8. If the app does not answer, the hook blocks the action. */
async function scenario8() {
  const hooksFile = buildHookFile({ gateUrl: 'https://install.webtrigger.atlassian.app/gate' });
  const onFailure = hooksFile.hooks.PreToolUse[0].hooks[0].onFailure;
  const noToken = await postHook('git status');
  return result(8, 'Closed by default when the app does not answer',
    onFailure === 'block' && noToken === 'http-401',
    `generated hook onFailure="${onFailure}"; gate without a token answered ${noToken} (non-2xx → blocked)`);
}

/** 9. Rewriting a journal entry shows a broken chain. */
async function scenario9() {
  const world = makeWorld();
  await decide(world, 'db/migrations/007_audit.sql');
  await decide(world, 'src/service.ts', 'A-02');
  const entries = await world.repos.ledger.list({ projectId: PROJECT });
  const tampered = entries.map((entry, index) =>
    index === 0 ? { ...entry, target: 'db/migrations/REWRITTEN.sql' } : entry);
  const verification = verifyChain(tampered);
  const screen = verifyLedgerIntegrity(tampered, verifyChain);
  return result(9, 'Tampered journal entry breaks the chain',
    verification.valid === false && screen.valid === false && screen.firstBreak?.seq === 1,
    `chain valid=${verification.valid}, first break at seq ${screen.firstBreak?.seq}`);
}

/** 10. The simulation console answers like the MCP tool. */
async function scenario10() {
  await seedGateRuntime();
  const repos = getDefaultRepositories();
  const runtime = getRuntimeSync();
  const resolver = createResolvers({ repos, engine: runtime.engine, verifyChain });
  const payload = { target: 'db/migrations/008_console.sql', actionClass: 'A-02', issueKey: ISSUE };
  const simulated = await callResolver(resolver, 'simulationConsole', { payload: { ...payload, projectId: PROJECT } });
  const mcpRaw = await checkPermission({ payload, context: { accountId: PILOT } });
  const mcp = JSON.parse(mcpRaw);
  return result(10, 'Simulation console matches the MCP tool',
    simulated.decision === mcp.decision && simulated.level === mcp.level,
    `console: ${simulated.decision} N${simulated.level}; MCP: ${mcp.decision} N${mcp.level}`);
}

/** 11. In observe mode nothing is blocked and everything is journaled. */
async function scenario11() {
  const world = makeWorld();
  await addRule(world, { id: 'observe-migrations', actionClass: 'A-08', level: 2, mode: 'observe' });
  const decision = await decide(world, 'db/migrations/009_observe.sql');
  const entries = await world.repos.ledger.list({ projectId: PROJECT });
  const journaled = entries.some((entry) => entry.detail?.observeOnly === true);
  return result(11, 'Observe mode decides, journals, blocks nothing',
    decision.decision === 'allow' && journaled && decision.requestId === undefined,
    `decision ${decision.decision}, observeOnly=${decision.resolution.observeOnly}, journaled=${journaled}`);
}

export const SCENARIOS: Scenario[] = [
  { id: 1, title: 'Reclassification', run: scenario1 },
  { id: 2, title: 'Approval without the pilot', run: scenario2 },
  { id: 3, title: 'Single-use permit', run: scenario3 },
  { id: 4, title: 'Expired and revoked permits', run: scenario4 },
  { id: 5, title: 'Secrets stay forbidden', run: scenario5 },
  { id: 6, title: 'Emergency stop', run: scenario6 },
  { id: 7, title: 'Hook gate', run: scenario7 },
  { id: 8, title: 'Closed by default', run: scenario8 },
  { id: 9, title: 'Tamper-evident journal', run: scenario9 },
  { id: 10, title: 'Console matches MCP', run: scenario10 },
  { id: 11, title: 'Observe mode', run: scenario11 },
];

export async function runScenarios() {
  const results = [];
  for (const scenario of SCENARIOS) {
    results.push(await scenario.run());
  }
  return results;
}

export { makeEntry, PROFILE, PROJECT };
