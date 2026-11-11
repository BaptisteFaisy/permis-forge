/**
 * Forge UI resolver registry (spec §15).
 *
 * This file is deliberately thin: the screens live in `./screens`, the
 * mutations in `./mutations`, the shared formatting in `./format`, the audit
 * helpers in `./audit` and the bilingual strings in `./i18n`. Keeping one
 * implementation per behaviour is what makes the six screens testable offline.
 *
 * Caller identity always comes from the Forge context, never from the payload,
 * and every repository and engine call is injected.
 */
import Resolver from '@forge/resolver';
import { Repositories } from '../core/types';
import { getPrecedentsScreen } from '../services/precedents';
import { DefineFn, registerMutations } from './mutations';
import {
  globalPage,
  issuePanel,
  personalSettings,
  projectPage,
  projectSettings,
  simulationConsole,
} from './screens';

export interface ResolverDeps {
  repos: Repositories;
  engine: any;
  verifyChain: any;
}

/** Screen names registered on the resolver, in manifest order. */
const SCREENS = {
  issuePanel,
  projectSettings,
  projectPage,
  simulationConsole,
  globalPage,
  personalSettings,
} as const;

/** Register every screen and mutation on one Forge Resolver instance. */
export function createResolvers(deps: ResolverDeps): Resolver {
  const resolver = new Resolver();
  const define: DefineFn = (key, handler) => {
    try {
      resolver.define(key, handler);
    } catch (error) {
      // Re-registering the same key happens when tests build several resolvers.
      if (!/already exists/.test(String(error))) throw error;
    }
  };
  for (const [name, screen] of Object.entries(SCREENS)) {
    define(name, ({ payload, context }: any) => (screen as any)(deps, payload, context));
  }
  registerMutations(define, deps);
  define('getPrecedents', ({ payload, context }: any) => getPrecedentsScreen(deps.repos, payload, context));
  return resolver;
}

/** Invoke a resolver definition directly, without the Forge runtime. */
export async function callResolver(
  resolver: any,
  name: string,
  req: { payload?: any; context?: any } = {},
): Promise<any> {
  const payload = req.payload ?? {};
  const context = req.context ?? {};
  if (typeof resolver?.getDefinitions === 'function') {
    const definitions = resolver.getDefinitions();
    const backendPayload = {
      principal: { accountId: context.accountId },
      installContext: context.installContext,
    };
    return definitions({ call: { functionKey: name, payload }, context }, backendPayload);
  }
  const handler = resolver?.functions?.[name];
  if (typeof handler !== 'function') {
    throw new Error(`Resolver has no definition for '${name}'.`);
  }
  return handler({ payload, context });
}
