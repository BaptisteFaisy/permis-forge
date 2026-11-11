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
npx jest                       # 18 suites, unit tests, no network
node scripts/check-manifest.mjs
```

Then, against the deployed app, the hook gate answers a plain POST:

```bash
curl -sS -X POST "$GATE_URL" \
  -H "Authorization: Bearer $PERMIS_AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"toolName":"Bash","args":{"command":"git reset --hard HEAD~3"},"cwd":"/tmp/demo"}'
```

Expect a `deny` with a request id: the door is closed by default, and a
destructive git operation is class A-12 (forbidden).

## 6b. This installation, as deployed on 11 November 2026

The app is live; these are the real values, so anyone picking the project up can resume without
guessing. The secrets themselves stay out of the repository.

| Item | Value |
|---|---|
| App id | `ari:cloud:ecosystem::app/a700e3ab-b722-4ae3-8a8a-b9f1a1b4c341` |
| Developer Space | `laddition` (`abf72fff-edaf-4259-900c-743702f0d1f2`) |
| Site | `one-atlas-cndz.atlassian.net` (Jira) |
| Environment | `development`, version 2.2.0 |
| Installation id | `d2d079ea-988f-4b26-8e34-a5db0dd7cdb0` |
| Gate URL | `https://<installation>.webtrigger.atlassian.app/public/<gate-key>` — stored locally in `~/.atlassian/permis-gate-url.txt`, mode 600 |
| Operator URL | same host, separate key — `~/.atlassian/permis-admin-url.txt` |
| Signing secret | app variable `PERMIS_AGENT_SECRET`, encrypted; local copy in `~/.atlassian/permis-signing-secret` |
| CLI credentials | `FORGE_EMAIL` + `FORGE_API_TOKEN` (no keychain on this host, so the CLI uses environment variables) |

Commands actually used:

```bash
export FORGE_EMAIL=…                      # Atlassian account email
export FORGE_API_TOKEN="$(tr -d '\r\n' < ~/.atlassian-api-token)"
export PATH=~/tools/node-v26.12.1-linux-x64/bin:$PATH   # Node >= 26.12.1 for the CLI

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

### The operator entry point

`src/hooks/admin.ts` is a **second** web trigger, separate from the gate, for bootstrapping and
demonstrating an installation before any screen is reachable. It accepts five operations:
`status`, `health`, `bootstrap-schema`, `seed-policy`, `screen`, `mint-token`,
`approve-request`, `deny-request` and `revoke-permit`.

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

Also worth knowing: the first call to a fresh container used to create the ten tables and seed
the organisation floor rules, which cost **15.4 s** once — and then broke the app (next item).

3. **Forge SQL rate-limits DDL, and containers are short-lived.** The first implementation replayed
   the fifteen `CREATE TABLE IF NOT EXISTS` / seed statements on **every** cold start. Forge SQL
   answered `429 RATE_LIMIT_EXCEEDED` — surfaced as
   `Limits for the current installation have been exceeded` — and *every* gated action failed
   closed, while read-only operator calls still worked (they issue no DDL). The schema is now
   created **reactively**: a query runs first, and only if it reports a missing table
   (`1146` / "doesn't exist") does the bootstrap run once per container, then the query is
   retried. On the normal path the app issues **no DDL at all**.
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
