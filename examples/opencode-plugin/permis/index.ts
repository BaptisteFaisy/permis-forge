/**
 * Permis d'agir — plugin opencode v2 (partie serveur).
 *
 * Branche le crochet `permission.evaluate` d'opencode sur le gate `permis`.
 * Chaque vérification `edit`/`shell` part vers le gate AVANT que l'action
 * s'exécute ; un refus bloque l'outil, et l'agent voit la raison.
 *
 * Installation (une ligne dans `~/.config/opencode/opencode.json`) :
 *   {
 *     "plugins": ["/chemin/absolu/vers/examples/opencode-plugin/permis"]
 *   }
 * Identifiants : `PERMIS_GATE_URL` + `PERMIS_AGENT_TOKEN` (+ `PERMIS_AGENT_ISSUE`),
 * ou les fichiers `~/.atlassian/permis-gate-url.txt`, `permis-agent-token.txt`,
 * `permis-agent-issue.txt`. Ils sont lus au chargement : redémarrer opencode
 * après les avoir changés (`opencode service restart`).
 */
import { Plugin } from '@opencode/plugin';
import { decidePermission, readConfig, type Effect } from './decide';

/** Sous-ensemble du crochet `evaluate` documenté par opencode (v2). */
interface PermissionEvaluation {
  readonly sessionID: string;
  readonly agent?: string;
  readonly action: string;
  readonly resources: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly source?: { type: 'tool'; messageID: string; id: string };
  effect: Effect;
  message?: string;
}

interface PermissionHookContext {
  location: { directory: string };
  permission: {
    hook(
      name: 'evaluate',
      callback: (event: PermissionEvaluation) => Promise<void> | void,
    ): Promise<unknown>;
  };
}

export default Plugin.define({
  id: 'permis',
  async setup(ctx: PermissionHookContext) {
    const config = readConfig() ?? null;
    await ctx.permission.hook('evaluate', async (event: PermissionEvaluation) => {
      const verdict = await decidePermission(
        {
          action: event.action,
          resources: event.resources,
          cwd: ctx.location.directory,
          current: event.effect,
        },
        config,
      );
      if (!verdict) return;
      event.effect = verdict.effect;
      if (verdict.message) event.message = verdict.message;
    });
  },
});