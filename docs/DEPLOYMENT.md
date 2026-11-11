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
```

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

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Not logged in` on `forge lint` | no keychain and no env vars | `forge login --email … --token …`, or export `FORGE_API_TOKEN` |
| `Unsupported Node.js version` | Node outside the supported ranges | install Node 22.23.4+, 24.22.1+ or 26.12.1+ |
| deploy rejects the manifest | placeholder `app.id` | mint or register a real id (section 4) |
| hook always blocks | app unreachable, or `onFailure: block` doing its job | check the web trigger URL, then the token; a blocked action with no answer is the intended fail-closed behaviour |
| permits fail signature check | secret changed between issue and verify | keep one `PERMIS_AGENT_SECRET` per installation; rotating it invalidates outstanding permits |
