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

```console
$ PERMIS_ADMIN_FILE=~/.atlassian/permis-admin-url-prod.txt \
  PERMIS_GATE_FILE=~/.atlassian/permis-gate-url-prod.txt \
  bash scripts/regression-live.sh
Régression live — projet PAY, ticket PAY-42
…
Régression live : 26 OK, 0 échec(s)
TOUT EST VERT
```

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

---

## 3. The live harness passes against the real installation (12 November 2026)

**What was run.** `bash scripts/regression-live.sh` — 26 checks against the
deployed installation, through the real web triggers and Forge SQL, no Jira UI
and no in-memory adapter. It exits non-zero if a single check fails.

**Proof.**

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

`docs/SUBMISSION.md` now quotes **26 checks, 26 OK** — the number the harness
actually prints, which the live mode of the claims verifier re-checks.
