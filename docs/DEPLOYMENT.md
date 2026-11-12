# Deploying the app to a Jira site

Everything below runs from a clone of this repository. The app has never been
deployed from a machine that stores your Atlassian credentials in the repo: the
token is read from the environment or from `~/.atlassian-api-token` (mode 600)
and is never printed, never committed.

## 1. Prerequisites

| Item | Requirement |
|---|---|
| Node.js | `^22.23.4`, `^24.22.1` or `>=26.12.1` (the Forge CLI refuses older runtimes) |
| Forge CLI | `@forge/cli` 15.x (`npm i -g @forge/cli`) |
| Atlassian account | an API token from https://id.atlassian.com/manage-profile/security/api-tokens |
| Jira Cloud site | `https://<your-site>.atlassian.net`, with permission to install apps |

```bash
node --version                      # must satisfy the ranges above
forge --version                     # 15.x
npm run install:all                 # full install: the front-end bundle needs the UI Kit packages
```

`npm run install:ci` (`npm ci --omit=optional`) is enough for tests and type checking, but
`forge deploy` builds the UI Kit screens and needs `@forge/react`, `@forge/bridge` and `react`,
which are declared as `optionalDependencies` (~1.6 GB installed) so that CI stays inside its
5-minute budget.

## 2. Credentials

Two equivalent ways; the scripts in `scripts/` accept either.

```bash
# A. environment (current shell only)
export FORGE_EMAIL="you@example.com"
export FORGE_SITE="your-site.atlassian.net"
export FORGE_API_TOKEN="$(cat ~/.atlassian-api-token)"

# B. files read by scripts/deploy.sh (never committed)
printf 'email=you@example.com\nsite=your-site.atlassian.net\n' > ~/.atlassian-login
chmod 600 ~/.atlassian-login
printf '%s' 'YOUR_API_TOKEN' > ~/.atlassian-api-token
chmod 600 ~/.atlassian-api-token
```

## 3. One command

```bash
bash scripts/deploy.sh --dry-run     # print the plan, change nothing
bash scripts/deploy.sh --lint        # validate the manifest only
bash scripts/deploy.sh               # login, lint, register, deploy, install
```

Or the explicit sequence:

```bash
forge login --email "$FORGE_EMAIL" --token "$FORGE_API_TOKEN" --non-interactive
forge lint
forge deploy --non-interactive
forge install --site "$FORGE_SITE" --product jira --non-interactive
```

## 4. The app id

`manifest.yml` ships with a placeholder `app.id`. A real deployment needs an id
minted by Atlassian, because the id identifies the app on the Marketplace and in
every installation URL (including the hook's web trigger URL).

Two paths:

```bash
# A. register an app you already created in the developer console
forge register

# B. mint a fresh id in a throwaway directory, then copy it into manifest.yml
cd "$(mktemp -d)" && forge create --template jira-issue-panel --accept-terms
grep '^  id:' manifest.yml          # ari:cloud:ecosystem::app/<real-uuid>
```

Paste the real `ari:cloud:ecosystem::app/<uuid>` into `manifest.yml`, commit it,
then `forge deploy`. Changing the id afterwards creates a *different* app: the
installed one keeps its own id, its own web trigger URL and its own data.

## 5. After the first deploy

1. **Personal hook token** — Jira → your profile → *Permis d'agir* personal
   settings → generate. The plaintext token is shown once; only its SHA-256 hash
   is stored. Export it where your agent runs:
   ```bash
   export PERMIS_AGENT_TOKEN="<shown-once-token>"
   ```
2. **Web trigger URL** — needed by the generated hooks file:
   ```bash
   forge webtrigger create     # pick the site, then the `gate` function
   ```
   Put that URL in `examples/hooks/claude-code-settings.json` (or regenerate the
   file from the project settings screen) and drop it in the target repository.
3. **Signing secret** — permits are HMAC-SHA256 signed with an installation
   secret. Set it as an app environment variable so the fallback development
   secret is never used in production:
   ```bash
   # Forge app environment variables are set in the developer console, or:
   forge variables set --key PERMIS_AGENT_SECRET --value "$(openssl rand -hex 32)"
   ```
4. **Seed the policy** — load `examples/policy/seed-payments.json` through the
   project settings screen (`saveZone`, `saveRule`) or with the resolver
   directly. Without rules, every class falls back to its catalogue default.
5. **MCP from an external client** — an administrator must enable external
   exposure for the installation; clients then connect to
   `https://mcp.atlassian.com/forge/<appId>` using OAuth 2.1
   (see `examples/mcp/client-config.json`).

## 6. Smoke test without leaving the terminal

```bash
node scripts/demo.mjs          # the 11 acceptance scenarios, offline
npx jest                       # 30 suites, unit tests, no network
node scripts/check-manifest.mjs
```

Once the app is deployed, replay the acceptance checks **against the real
installation** — web triggers, Forge SQL, project policy and all:

```bash
bash scripts/regression-live.sh
# 30 checks: storage and chain integrity, operator authentication, personal
# token, gate decisions (migration refused, read allowed, A-10 and A-15 at N0,
# CI file reclassified A-07, observe mode, per-project policy, no token = 401),
# and the six Jira screens through their resolvers.
```

It reads three local files and prints no secret:

| File | Content |
|---|---|
| `~/.atlassian/permis-gate-url.txt` | gate web trigger URL |
| `~/.atlassian/permis-admin-url.txt` | operator web trigger URL |
| `~/.atlassian/permis-signing-secret` | installation secret (`X-Permis-Admin`) |

Override the target project with `PROJECT=… ISSUE=… bash scripts/regression-live.sh`.
The observe-mode and project-rule checks need a seeded policy: load
`examples/policy/seed-payments.json` first with the `seed-policy` operator action.

Then, against the deployed app, the hook gate answers a plain POST:

```bash
curl -sS -X POST "$GATE_URL" \
  -H "Authorization: Bearer $PERMIS_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"Bash","args":{"command":"git reset --hard HEAD~3"},"cwd":"/tmp/demo"}'
```

Expect a `deny` with a request id: the door is closed by default, and a
destructive git operation is class A-12 (forbidden).

## 6b. This installation, as deployed on 12 November 2026

The app is live; these are the real values, so anyone picking the project up can resume without
guessing. The secrets themselves stay out of the repository.

| Item | Value |
|---|---|
| App id | `ari:cloud:ecosystem::app/a700e3ab-b722-4ae3-8a8a-b9f1a1b4c341` |
| Developer Space | `laddition` (`abf72fff-edaf-4259-900c-743702f0d1f2`) |
| Site | `one-atlas-cndz.atlassian.net` (Jira) |
| Environment | `development` — app version **2.26.0** (Forge major version 2), deployed 12 November 2026 |
| Installation id | `d2d079ea-988f-4b26-8e34-a5db0dd7cdb0` |
| Environment | `production` — app version **2.2.0**, installed 12 November 2026 (the version a judge installs from the Marketplace) |
| Installation id | `61ad469d-974c-4c30-a272-7b3416b66262` |
| Gate URL | `https://<installation>.webtrigger.atlassian.app/public/<gate-key>` — stored locally in `~/.atlassian/permis-gate-url.txt`, mode 600 |
| Operator URL | same host, separate key — `~/.atlassian/permis-admin-url.txt` |
| Production URLs | same two files, `…-prod.txt` suffix — `~/.atlassian/permis-gate-url-prod.txt`, `~/.atlassian/permis-admin-url-prod.txt` |
| Signing secret | app variable `PERMIS_AGENT_SECRET`, encrypted — set **per environment** (`forge variables set -e <env>`), local copy in `~/.atlassian/permis-signing-secret` |
| Deployed versions | written by `scripts/deploy.sh` to `~/.atlassian/permis-deploy-state.json` — the file the docs auditor checks |
| CLI credentials | `FORGE_EMAIL` + `FORGE_API_TOKEN` (no keychain on this host, so the CLI uses environment variables) |

> A **new installation starts empty**: no tables, no policy. `scripts/bootstrap-installation.sh`
> performs the two operator actions that make it usable (`bootstrap-schema`, then `seed-policy`
> from `examples/policy/seed-payments.json`) and prints the resulting state. It is idempotent —
> re-running it against a live installation changes nothing and still passes.

Commands actually used:

```bash
export FORGE_EMAIL=…                      # Atlassian account email
export FORGE_API_TOKEN="$(tr -d '\r\n' < ~/.atlassian-api-token)"
export PATH=~/tools/node-v26.12.1-linux-x64/bin:$PATH   # Node >= 26.12.1 for the CLI
```

> The app version is printed by `forge deploy` (`The version of your app [2.26.0] …`); it is not
> stored in `manifest.yml` or `package.json`, and `forge version list` shows only major versions.
> Read it from the deployment command — `scripts/deploy.sh` does that for you and records it in
> `~/.atlassian/permis-deploy-state.json`.
>
> The Node version matters: the CLI refuses `^22.23.4 || ^24.22.1 || >=26.12.1` outside that
> range, and the `node` first in `PATH` on this host is **26.9.0** — the CLI answers
> *"Unsupported Node.js version"* and exits. Two recipes work:
>
> ```bash
> export PATH=~/tools/node-v26.12.1-linux-x64/bin:$PATH
> forge version list
>
> # or, without touching PATH:
> ~/tools/node-v26.12.1-linux-x64/bin/node \
>   ~/.local/opt/lib/node_modules/@forge/cli/out/bin/cli.js version list
> ```
>
> `forge version list`, `forge install list` and `forge environments list` are the three commands
> that answer the questions this document asks — the app id, the installation id, and which
> environment is actually installed. (`forge app:info` does not exist in CLI 15.1.0.)

forge developer-spaces list
forge create permis-agir-mint -t blank -d app -y -s <developer-space-id>   # mints the real app id
forge lint
forge variables set PERMIS_AGENT_SECRET "$(cat ~/.atlassian/permis-signing-secret)" --encrypt -e development
forge deploy --non-interactive
forge install --site one-atlas-cndz.atlassian.net --product jira --environment development --non-interactive
forge webtrigger create -f gate  -s one-atlas-cndz.atlassian.net -p jira
forge webtrigger create -f admin -s one-atlas-cndz.atlassian.net -p jira
forge logs -e development -n 40
```

The same sequence, for production — note that the **app variable is per environment**, so it has
to be set again before the production deployment, and the deployment has to be redone for the new
variable to apply:

```bash
forge variables set PERMIS_AGENT_SECRET "$(cat ~/.atlassian/permis-signing-secret)" --encrypt -e production
forge deploy -e production --non-interactive
forge install --site one-atlas-cndz.atlassian.net --product jira -e production --non-interactive
forge webtrigger create -f gate  -e production -s one-atlas-cndz.atlassian.net -p jira
forge webtrigger create -f admin -e production -s one-atlas-cndz.atlassian.net -p jira

# the production installation starts empty — schema, then policy
PERMIS_ADMIN_FILE=~/.atlassian/permis-admin-url-prod.txt bash scripts/bootstrap-installation.sh
```

`scripts/deploy.sh --environment <development|production>` does the same thing and records the
published version in `~/.atlassian/permis-deploy-state.json`.

### The operator entry point

`src/hooks/admin.ts` is a **second** web trigger, separate from the gate, for bootstrapping and
demonstrating an installation before any screen is reachable. Its operations are listed by the
endpoint itself when it receives an unknown one (`ALLOWED_ACTIONS`):
`status`, `health`, `screen` (read-only), then `bootstrap-schema`, `seed-policy`, `mint-token`,
`approve-request`, `deny-request`, `revoke-permit`, `revoke-token`, `apply-drift` and
`apply-suggestion`.

The split is not cosmetic: recording a deviation moves the trust capital and applying a policy
suggestion writes a rule (class **A-15**, N0). Neither is reachable by an agent — they live here,
behind the installation secret, precisely so that the MCP surface can stay open for reading.

Every call must present the installation secret in `X-Permis-Admin`; the comparison is
constant-time and a wrong secret is refused with 401. Approvals still go through
`src/services/approvals-service.ts`, so the pilot of a request cannot approve it and a denial
still requires a written reason. The endpoint cannot write policy rules: there is no operation
for that, so it cannot be used to widen anyone's rights.

Treat it as an operator surface: keep the URL and the secret private, rotate the secret if
either leaks, and consider removing the module from the manifest for a production listing — the
screens are the intended route for everyday use.

```bash
curl -sS -X POST "$ADMIN_URL" -H 'Content-Type: application/json' \
  -H "X-Permis-Admin: $(cat ~/.atlassian/permis-signing-secret)" \
  -d '{"action":"status","projectId":"PAY"}'
```

### What the first deploy taught us

Two defects only a real deployment could reveal, both fixed:

1. **Web trigger wire format.** Forge passes a plain object `{method, headers, body, path,
   userPath}` where `body` is a string and each header value is an **array**; the function must
   return `{statusCode, headers, body}`. Using the Fetch `Request`/`Response` API instead makes
   the platform answer **HTTP 424 Failed Dependency** with no useful message. `src/hooks/gate.ts`
   now speaks the Forge format and still accepts a Fetch `Request` so the tests run offline.
2. **Runtime detection.** There is no `FORGE_ENVIRONMENT` variable; Forge exposes app variables
   as `FORGE_USER_VAR_*`. The adapter selection now defaults to Forge SQL, with jest workers and
   the offline demo opting out explicitly (`PERMIS_OFFLINE=1`, `PERMIS_STORAGE=memory|sql`).
   Without that fix a deployed app would have run on the in-memory adapter and lost every
   decision between invocations.

Also worth knowing: the first call to a fresh container used to create the nine tables and seed
the organisation floor rules, which cost **15.4 s** once — and then broke the app (next item).

3. **Forge SQL rate-limits DDL, and containers are short-lived.** The first implementation replayed
   the whole `CREATE TABLE IF NOT EXISTS` / seed script on **every** cold start. Forge SQL
   answered `429 RATE_LIMIT_EXCEEDED` — surfaced as
   `Limits for the current installation have been exceeded` — and *every* gated action failed
   closed, while read-only operator calls still worked (they issue no DDL). The schema is now
   created **reactively**: a query runs first, and only if it reports a missing table
   (`1146` / "doesn't exist") does the bootstrap run once per container, then the query is
   retried. On the normal path the app issues **no DDL at all**.

   **A schema addition needs one explicit bootstrap on an installed site.** The reactive
   bootstrap triggers on a *missing-table* error (`1146`), but Forge SQL answers some absent-table
   queries with a generic "Unknown SQL execution error" naming the table instead. When that
   happens the bootstrap does not fire and every call touching the new table fails — closed, so
   nothing leaks, but the app is unusable until the schema exists. Adding the `token_revocation`
   table broke the live installation exactly this way, and the live harness caught it on its first
   run. After any change to `SCHEMA_DDL`, run once per installation:

   ```bash
   curl -sS -X POST "$ADMIN_URL" -H "X-Permis-Admin: $SECRET" -d '{"action":"bootstrap-schema"}'
   # {"ok":true,"detail":"10 tables (24 DDL statements), 5 organisation rules"}
   ```

   **Consequence for schema evolution.** Forge SQL has no `ALTER TABLE`: a column cannot be added
   to a table an installation already has, because the reactive bootstrap only creates what is
   missing and never reshapes an existing table. A new field therefore goes into a **new table**,
   which reaches an installed app with no migration — the first query that reports it missing
   creates it. That is why revoked tokens live in `token_revocation` rather than in a `revoked_at`
   column of `hook_token`.
   After a fresh install, an operator can create the schema explicitly instead of letting the
   first request pay for it:

   ```bash
   curl -sS -X POST "$ADMIN_URL" -H 'Content-Type: application/json' \
     -H "X-Permis-Admin: $(cat ~/.atlassian/permis-signing-secret)" \
     -d '{"action":"bootstrap-schema"}'
   ```

Diagnosing this was only possible because the gate logs the exception before answering: a
`catch` that returns a clean 500 without `console.error` leaves nothing in `forge logs`.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Not logged in` on `forge lint` | no keychain and no env vars | `forge login --email … --token …`, or export `FORGE_API_TOKEN` |
| `Unsupported Node.js version` | Node outside the supported ranges | install Node 22.23.4+, 24.22.1+ or 26.12.1+ |
| deploy rejects the manifest | placeholder `app.id` | mint or register a real id (section 4) |
| hook always blocks | app unreachable, or `onFailure: block` doing its job | check the web trigger URL, then the token; a blocked action with no answer is the intended fail-closed behaviour |
| permits fail signature check | secret changed between issue and verify | keep one `PERMIS_AGENT_SECRET` per installation; rotating it invalidates outstanding permits |
