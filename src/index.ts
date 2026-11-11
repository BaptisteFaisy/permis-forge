/**
 * Entry point of the Forge app — every handler referenced by manifest.yml.
 *
 * Three families:
 * 1. the eight MCP actions (rovo:mcp / action), re-exported as they are;
 * 2. the resolvers of the six Jira screens (issue panel, project settings,
 *    project page, simulation console, global page, personal settings);
 * 3. the hook gate (web trigger) and the two triggers.
 *
 * The functions of this file stay thin: the logic lives in src/core (pure,
 * tested), src/storage (adapters), src/mcp (tool handlers) and src/ui (Forge
 * resolvers).
 */
import { verifyChain } from './core/ledger';
import { getRuntimeSync } from './mcp/runtime';
import { registerApprovalMutations } from './ui/approval-mutations';
import { createResolvers } from './ui/resolvers';

// ------------------------------------------------------------------ outils MCP
export {
  checkPermission,
  getPolicy,
  getRequestStatus,
  listPermits,
  getAgentStanding,
} from './mcp/handlers/reads';
export { requestApproval, declareAction, submitPlan } from './mcp/handlers/writes';

// ------------------------------------------------------------------- écrans
const runtime = getRuntimeSync();
const resolver = createResolvers({
  repos: runtime.repos,
  engine: runtime.engine,
  verifyChain,
});
registerApprovalMutations(resolver as any, { repos: runtime.repos, secret: runtime.secret });
const resolverDefinitions =
  typeof (resolver as any)?.getDefinitions === 'function'
    ? (resolver as any).getDefinitions()
    : resolver;

export const resolveIssuePanel = resolverDefinitions;
export const resolveProjectSettings = resolverDefinitions;
export const resolveProjectPage = resolverDefinitions;
export const resolveSimulationConsole = resolverDefinitions;
export const resolveGlobalPage = resolverDefinitions;
export const resolvePersonalSettings = resolverDefinitions;

// ------------------------------------------------------- hook et déclencheurs
export { handleGate } from './hooks/gate';
export { onIssueUpdated, onScheduledMaintenance } from './triggers';
