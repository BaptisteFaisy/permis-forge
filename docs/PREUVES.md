# Proof log — what each step demonstrated

Every entry below states one step, the command that was run, the result that was
observed, and where the evidence lives. A claim that has no entry here is a
claim, not a fact.

The proof is deliberately *re-runnable*: each entry names a command you can type
again, and the interesting ones are also wired into CI, so a stale number fails
the pull request instead of waiting to be read.

---

## 1. The documentation is now verified, not asserted (12 November 2026)

**Problem.** The prose carried numbers that had gone stale without anyone
noticing: `9 tables` since `token_revocation` was added, `364 offline unit tests
in 30 Jest suites` when the suite had grown to 502 in 40, `18 checks, 18 OK`
when the harness now runs 26. A number written by hand decays silently.

<!-- claims: historique -->

**What was built.** `scripts/verify-claims.mjs` reads every number written in
`docs/`, recomputes the truth from the repository (jest, `manifest.yml`, the
parsed `SCHEMA_DDL`, the scenario list) and fails when the two disagree. Live
claims — the deployed app version, the number of checks the live harness
actually passes — are verified with `--live` against the real installation.

Two escape hatches, both explicit and visible in the documents:
- a section or paragraph carries the `claims: historique` marker (the exact
  comment syntax is in the script header): it is not audited, because it
  describes a dated state, not the current one;
- a claim can declare `exclude:` for platform limits — `50 tools at most` is
  Atlassian's ceiling, not our tool count.

**What it found on the first run** — nine stale claims:

<!-- claims: historique -->

| Document | Claimed | Reality |
|---|---|---|
| `docs/SUBMISSION.md` | 364 tests in 30 suites | 502 tests in 40 suites |
| `docs/SUBMISSION.md` (×2) | 9 tables | 10 tables |
| `docs/DEMO-SCRIPT.md` | 9 tables | 10 tables |
| `docs/VALIDATIONS.md` | 9 tables / 25 DDL statements | dated record — marked historical |

**Proof** — the audit is green after the corrections, and it is part of CI:

```console
$ node scripts/verify-claims.mjs
Vérificateur d'affirmations — docs confrontées à la réalité
✔ tests        docs/SUBMISSION.md:110  doc: tests=502 suites=40  réel: tests=502 suites=40
✔ tables       docs/DEMO-SCRIPT.md:189  doc: tables=10  réel: tables=10
✔ tables       docs/DEPLOYMENT.md:278  doc: tables=10  réel: tables=10
✔ tables       docs/SUBMISSION.md:107  doc: tables=10  réel: tables=10
✔ tables       docs/SUBMISSION.md:123  doc: tables=10  réel: tables=10
✔ ddl          docs/DEPLOYMENT.md:278  doc: statements=24  réel: statements=24

6 affirmation(s) vérifiée(s), 0 périmée(s), 0 erreur(s).
```

**Where the evidence lives.** `scripts/verify-claims.mjs`, the `Affirmations des
docs` step of the `ci` workflow, and `scripts/deploy.sh`, which now writes the
version the CLI actually published to `~/.atlassian/permis-deploy-state.json`
so the deployed version quoted in the docs is checkable too.

---

## 2. The app is deployed in production too, and the harness passes there (12 November 2026)

<!-- claims: historique -->

*Section datée : elle décrit le déploiement et l'exécution de ce jour-là ; l'état courant est en §4.*

**What was done.** The app was deployed to the **production** environment (app version **2.1.0**)
and installed on the same site — installation `61ad469d-974c-4c30-a272-7b3416b66262`. The
production installation starts empty, so `scripts/bootstrap-installation.sh` (new) creates the
schema, loads the policy seed, and prints the state it obtained. The development deployment was
refreshed at the same time (app version **2.25.0**), so the deployed code is exactly `main`.

**Two traps, both worth knowing.**

- The app variable `PERMIS_AGENT_SECRET` is **per environment**: production had none, so the
  first production deployment came up with no signing secret. Setting the variable is not enough —
  the deployment has to be redone for it to apply.
- A production installation gets **no web trigger URL** at install time. `forge webtrigger create`
  is what mints one, per installation — the development installation has its own pair, and they
  are not interchangeable.

**Proof** — the same 26 checks, replayed against the production installation, through the real
web triggers and Forge SQL:

<!-- claims: historique -->

```console
$ PERMIS_ADMIN_FILE=~/.atlassian/permis-admin-url-prod.txt \
  PERMIS_GATE_FILE=~/.atlassian/permis-gate-url-prod.txt \
  bash scripts/regression-live.sh
Régression live — projet PAY, ticket PAY-42
…
Régression live : 26 OK, 0 échec(s)
TOUT EST VERT
```

*(This run predates the four verification checks of §4: the harness now runs 30.)*

and the bootstrap of that fresh installation:

```console
$ PERMIS_ADMIN_FILE=~/.atlassian/permis-admin-url-prod.txt bash scripts/bootstrap-installation.sh
Amorçage de l'installation — projet PAY
1. Schéma
  [OK]    tables créées (DDL rejoué une fois)
2. Politique
  [OK]    zones et règles chargés, aucun refus
3. État
  [OK]    chaîne du journal intacte
  état : {"projectId":"PAY","rules":14,"zones":7,"permits":0,"ledgerEntries":26,"pendingRequests":3,"chainValid":true,"chainChecked":26,"storage":"auto"}
Amorçage : 3 OK, 0 échec(s)
```

**Where the evidence lives.** `scripts/bootstrap-installation.sh`,
`scripts/deploy.sh --environment <env>` (it records the published version in
`~/.atlassian/permis-deploy-state.json`), and the live mode of `scripts/verify-claims.mjs`,
which now checks the versions quoted in the docs against that file:

```console
✔ app-version  docs/SUBMISSION.md:121  doc: version=2.25.0 env=development  réel: version=2.25.0
✔ app-version  docs/SUBMISSION.md:122  doc: version=2.1.0 env=production  réel: version=2.1.0
✔ live-replay  docs/SUBMISSION.md:126  doc: checks=26  réel: checks=26
```

*(Those are the versions of that run; §4 carries the current ones.)*

---

## 4. The CI verification no longer reads the permits of another project (12 November 2026)

**The defect.** The verification path is unauthenticated on purpose — a CI runner
holds the gate URL, not a pilot's token — but the permit lookup ignored the
project: `listPermits({})` returned **every** permit of the installation. A check
that asked about a permit id therefore got the full state of a permit that had
nothing to do with it: `found`, `valid`, `signatureValid`, `usesLeft`, `revoked`,
`suspended`.

**Observed on the production installation, before the fix** — a check of project
`PAY` asking about a permit of project `ENGS`:

```console
$ curl -sS -X POST "$GATE" -H 'X-Permis-Issue: PAY-42' \
    -d '{"permitId":"PA-2026-000001","paths":["db/migrations/777_probe.sql"]}'
{"permitId":"PA-2026-000001","found":true,"valid":true,"covers":true,"uncovered":[],
 "signatureValid":true,"expired":false,"revoked":false,"suspended":false,"usesLeft":1}
```

**After the fix**, the verification names its project (`projectId`, or the issue
key in `X-Permis-Issue`) and the lookup is limited to it. Same installation,
same permit, same requests:

```console
$ curl -sS -X POST "$GATE" -H 'X-Permis-Issue: PAY-42' \
    -d '{"permitId":"PA-2026-000001","paths":["db/migrations/777_probe.sql"]}'
{"permitId":"PA-2026-000001","found":false,"valid":false,"covers":false}

$ curl -sS -X POST "$GATE" -d '{"permitId":"PA-2026-000001"}' -w ' [HTTP %{http_code}]'
{"error":"PROJECT_REQUIRED","note":"A permit verification must name its project: send projectId, or the issue key in X-Permis-Issue."} [HTTP 400]

$ curl -sS -X POST "$GATE" -d '{"permitId":"PA-2026-000001","projectId":"ENGS"}'
{"permitId":"PA-2026-000001","found":true,"valid":true,"covers":true,"uncovered":[],
 "signatureValid":true,"expired":false,"revoked":false,"suspended":false,"usesLeft":1}
```

The last line is the point: the legitimate use still works. The check that
guarded `ENGS` still verifies its permit; the check that guarded `PAY` learns
nothing about it.

**Proof** — the property is now part of the live harness (30 checks, run against
both installations on 12 November 2026):

```console
5. Vérification CI (point d'application n°3)
  [OK]    permis émis pour la vérification (PA-2026-000002)
  [OK]    vérification du permis du projet : trouvé et valide
  [OK]    vérification depuis un autre projet : invisible
  [OK]    vérification sans projet : refus 400

Régression live : 30 OK, 0 échec(s)
TOUT EST VERT
```

**Where the evidence lives.** `src/hooks/gate.ts` (`verificationProject()`),
`scripts/regression-live.sh` (the four checks), `test/gate-handler.test.ts`
(the three unit tests) and `examples/ci/verify-permit.yml` (the CI example now
sends the project, `PERMIS_PROJECT`).

---

## 5. The test environment is the real one, not a rehearsal (12 November 2026)

**What was still simulated.** The harness drove the real web triggers and the
real Forge SQL, but three things were still made up: the pilot was a fake
account (`557058:regression`), the approval card was assumed to be posted rather
than verified, and the agent was a `curl` that carried a hand-written payload.

**What changed.**

1. **The pilot is a real account.** The harness mints its token for the account
   id read from `~/.atlassian/permis-pilot-account.txt` — a real Atlassian
   account on the site. The ledger, the requests and the approval cards now
   carry a real identity, not a fixture.
2. **The notification is verified, not assumed.** The app posts the approval
   card on the ticket through the Jira REST API; the harness re-reads the
   ticket's comments and checks that the card for the request it just created
   is really there.
3. **The rule "the pilot does not approve their own request" is played with the
   real identity** (PA-05): the harness approves with the pilot's own account
   id and checks that the app refuses.

**Proof** — the production installation, twice in a row:

```console
5. Vérification CI (point d'application n°3)
  [OK]    permis émis pour la vérification (PA-2026-000005)
  [OK]    vérification du permis du projet : trouvé et valide
  [OK]    vérification depuis un autre projet : invisible
  [OK]    vérification sans projet : refus 400
6. Notification approbateur (vrai ticket)
  [OK]    carte d'approbation RQ-2026-000027 postée sur le vrai ticket PAY-42
7. Le pilote n'approuve pas sa propre demande
  [OK]    auto-approbation du pilote refusée (RQ-2026-000028)

Régression live : 32 OK, 0 échec(s)
TOUT EST VERT
```

**Two defects found by running it for real.**

- **My check was wrong, not the app.** The first run reported the approval card
  as missing. It was not: the card was on the ticket. The check read
  `comment?maxResults=20`, which returns the *first* twenty comments of a
  ticket that now has fifty-seven — the card was past the window. Reading the
  end of a paginated list is the fix (`fields=comment` for the total, then
  `startAt`).
- **The harness was not replayable.** The verification section asked for a
  permit on a fixed path; the permit issued by the *previous* run still covered
  it, the door opened, no request was created, and the four checks failed on the
  second run. Same family as the drift trap fixed earlier: a fixed target
  against an idempotent mechanism. The path now carries a timestamp.

**Also fixed for the real client.** The generated Claude Code hook sent only
`Authorization`; it never named the ticket, so a real agent could never use the
permit flow (anything beyond N4 is refused without a ticket). The hook now
sends `X-Permis-Issue` from `PERMIS_AGENT_ISSUE`, like the command bridge
already did, and the gate refuses an unexpanded `$PERMIS_AGENT_ISSUE` instead
of treating it as a ticket.

**The client integration now runs natively on opencode and ZeroClaw.** Neither
ships a tool hook, but both consume MCP tools — so `scripts/permis-mcp-server.mjs`
(a zero-dependency stdio MCP server) serves `check-permission` / `declare-action`
locally and calls the `gate` web trigger. With opencode, a real agent called
`check-permission`, the gate refused (`pay-migrations-approval`, N2,
`RQ-2026-000087`), and the file was not written — the product's own flow, no
Claude Code involved:

```console
⚙ tools.permis["check-permission"]({ action: "Edit", target: "db/migrations/910_probe.sql", … })
🚫 Permission denied — edit blocked.
| Decision | deny | Request ID | RQ-2026-000087 | Required level | N2 |
The file db/migrations/910_probe.sql was not modified.
```

The server is registered for both clients (`opencode.json` → `mcp.permis`;
`~/.zeroclaw/config.toml` → `[[mcp.servers]] permis` + bundle `permis` for
agent `b`), reading its credentials from `~/.atlassian/`. Documented in
HOOK-SETUP §12, with the honest caveat: the MCP path is cooperative by nature
(that is the product's model — the agent asks, drift catches the rest); the
mechanical guarantee stays with the hook.

**And a real client ran — `opencode` v2.1.1, a real model — and found two things.**

- The shipped `examples/hooks/gate-bridge.sh` **failed open**: it printed the
  denial on stdout but exited **0**, so a client that reads only the exit code
  ran the action anyway. Fixed (exit 2 on a refusal), pinned by
  `test/gate-bridge.test.ts`.
- opencode has no tool hook (`tool.execute.before` is gone in v2; its plugin
  API is effect-based and has no pre-tool interception), so the gate had to sit
  in a wrapper script. The agent read the wrapper as prompt injection, refused
  to run it, and edited the file directly — a truthful demonstration that a
  *wrapper* is cooperative, and the mechanical guarantee only exists in the
  client's own hook. (opencode's default model config was also broken:
  `combo/claude-opus-5-5` no longer exists at the provider; `ag/claude-sonnet-4-6`
  works.)

**Still open on the code side.** The delegation path (`delegate-permit`) does
not check that the caller owns the permit it delegates: it looks the parent up
by id among *all* permits. An agent could therefore delegate a permit issued to
another pilot — the "narrowing only" promise would then be relative to a permit
the caller does not hold. It is a real finding, confirmed by reading the code;
it is not fixed here, because the live path to it (the Rovo MCP endpoint)
requires the administrator OAuth activation that is still pending.

**What is still not real, and why.**

| Gap | Blocker |
|---|---|
| A real agent client driving the hook end to end | Claude Code 2.1.318 is installed and its binary does support the `http` hook type, but its OAuth session has expired — it answers *"Failed to authenticate"*. One re-login away. |
| A **second** human approving | The site has a single pilotable account (the project lead). Granting a permit needs someone else; the harness still grants as an operator identity, and the rule that the pilot cannot self-approve is proven with the real account. |
| The Jira screens rendered by a browser | The harness calls the screen resolvers through the app (`screen` action), not the UI Kit bundle in a real browser: that needs an interactive Jira session. |
| The external MCP endpoint | Still the administrator OAuth activation. |

---

## 3. The live harness passes against the real installation (12 November 2026)

**What was run.** `bash scripts/regression-live.sh` — 30 checks against the
deployed installation, through the real web triggers and Forge SQL, no Jira UI
and no in-memory adapter. It exits non-zero if a single check fails.

**Proof.**

<!-- claims: historique -->

```console
$ bash scripts/regression-live.sh
Régression live — projet PAY, ticket PAY-42
1. Stockage et intégrité
  [OK]    les 9 sondes de dépôt répondent (10 tables)
  [OK]    chaîne du journal intacte
  [OK]    secret opérateur invalide refusé (401)
…
Régression live : 26 OK, 0 échec(s)
TOUT EST VERT
```

*(That run predates the four verification checks of §4: the harness now runs 30.)*

`docs/SUBMISSION.md` now quotes **30 checks, 30 OK** — the number the harness
actually prints, which the live mode of the claims verifier re-checks.

## 6. opencode is gated mechanically now — proven both ways (13 November 2026)

**What the 12 November conclusion missed.** The last run behind §5 concluded that opencode had no
pre-tool hook, so only the cooperative MCP path applied. opencode v2.1.1 does have one:
`permission.evaluate`, a plugin hook that runs before the action (HOOK-SETUP §13). The plugin is
`examples/opencode-plugin/permis/`.

**The proof runs the same plugin, the same model and the same configuration twice** and changes only
the target path. opencode's own rules allow everything (`{"action":"*","resource":"*","effect":"allow"}`),
so the *only* thing that can block a write is the plugin asking the gate.

Run A — a path the policy refuses (`pay-migrations-approval`, N2):

```console
> build · ag/claude-sonnet-4-6
✗ Write db/migrations/912_probe_plugin.sql failed
Error: Permis d'agir: Project rule pay-migrations-approval applied to A-08: level N2.
No valid permit covers this action. Request: RQ-2026-000090 Level: N2
…
=== APRÈS A ===
FICHIER ABSENT (bloqué par le gate)
```

Run B — a path the policy allows (N5), same command shape:

```console
> build · ag/claude-sonnet-4-6
← Write README.demo.md
Created file successfully: README.demo.md
…
=== APRÈS B ===
FICHIER ECRIT :
bonjour depuis permis.
```

**What this establishes.** The refusal happens *before* the write (the file never appears), the reason
reaches the model, and the gate stays a gate: an allowed path is written normally. Nine unit tests
(`test/permis-opencode-plugin.test.ts`) pin the action mapping, the tightening rule and every
fail-closed case against a stub gate, with no network.

**What it does not establish.** The mechanism is per client: an opencode session without the plugin is
bound only by the merge gate. And the plugin reads its credentials when it loads — a rotated token
needs a restart, the same rule as the hook (§7 of HOOK-SETUP).

**And on the workstation.** The same plugin is wired into
`~/.config/opencode/opencode.json` (`"plugins": ["…/examples/opencode-plugin/permis"]`, backup kept)
and the background service was restarted. A run from a directory with **no project config** — only
the global one — was still refused on a migration path:

```console
✗ Write db/migrations/913_probe_global.sql failed
Error: Permis d'agir: Project rule pay-migrations-approval applied to A-08: level N2.
No valid permit covers this action. Request: RQ-2026-000091 Level: N2
FICHIER ABSENT (bloqué par le gate, via le plugin global)
```

The gate is therefore in force for every opencode session on this machine, not only inside a
demonstration directory.
