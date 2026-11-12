# Hook setup — enforcing the policy on the workstation

The MCP tool (enforcement point 1) only works if the agent cooperates. **The hook (enforcement
point 2) does not need the agent's goodwill**: Claude Code runs it before every tool call, and
the app answers *allow*, *ask* or *deny*.

> The product specification (in French) is kept verbatim in [`SPEC.md`](SPEC.md). Section numbers
> below refer to it.

---

## 1. How Claude Code `PreToolUse` hooks work

Claude Code executes a hook **before each tool call**. The hook can refuse the call, let it
through, or ask the user to confirm. It can be a command, an HTTP request or an MCP tool call, and
it can be narrowed to the tools and arguments you care about.

Verified capabilities of the mechanism (§18):

- the event is **`PreToolUse`**;
- filtering by **tool name** — MCP tools included — and by **arguments**;
- hook types: `command`, `http` and `mcp_tool`;
- a refusal is expressed either by an **exit code** or by the decision **`deny`** / `ask` /
  **`allow`**;
- the option **`onFailure: "block"`** makes the gate closed by default.

Permis d'agir uses the **`http`** type, because the decision must come from the policy stored in
Jira — not from a copy of it in the repository.

---

## 2. The generated hooks file

The app generates the hooks file **from the project policy**, and the project settings page
downloads it. It is meant to be committed to the repository as `.claude/settings.json` (merged
with the settings you already have):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "http",
            "url": "https://<installation>.webtrigger.atlassian.app/<chemin>/gate",
            "timeout": 10,
            "onFailure": "block",
            "headers": { "Authorization": "Bearer $PERMIS_AGENT_TOKEN" },
            "allowedEnvVars": ["PERMIS_AGENT_TOKEN"]
          }
        ]
      }
    ]
  }
}
```

| Field | Meaning |
|---|---|
| `matcher` | The tools the gate watches. Only sensitive tools are listed, so that ordinary work is never interrupted. |
| `type: "http"` | The decision is fetched from the app's web trigger. |
| `url` | The installation-specific gate URL, as given in the generated file. |
| `timeout` | 10 seconds. |
| `onFailure: "block"` | **Closed by default**: if the app does not answer, the call is blocked. |
| `headers.Authorization` | `Bearer $PERMIS_AGENT_TOKEN` — the token of the pilot, read from the environment. |
| `allowedEnvVars` | The environment variable the hook is allowed to read. |

The URL is specific to the installation (`<installation>.webtrigger.atlassian.app`), and the path
is the one carried by the generated file.

---

## 3. From autonomy level to hook decision

| Level | Decision returned by the gate |
|---|---|
| N5, N4 | **Allow** (N4: the action is logged) |
| N3 | **Ask** the pilot to confirm |
| N2, N1 **with a valid permit** | **Allow**, and the permit usage is decremented |
| N2, N1 **without a permit** | **Deny**, with the number of the request that was created |
| N0 | **Deny**, with the reason |

The body of the answer follows the Claude Code HTTP-hook format:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "no valid permit covers this action Request: RQ-2026-000512 Level: N2"
  }
}
```

The reason line carries the refusal reason, then the number of the request that was created
(`RQ-<year>-<sequence>`), then the level.

In observation mode the gate answers `allow` for everything and records what it *would* have
blocked.

---

## 4. When the app does not answer

`onFailure: "block"` makes the door closed by default: **if the app is unreachable, times out or
answers with an error, the sensitive action does not happen.**

This is deliberate: the alternative — letting the call through when the policy cannot be checked —
would silently disable the whole point of the product. The trade-off is discussed in the
specification (§10): the hooks file only filters the sensitive tools and patterns, so that a
blocked call is always one a human would have had to sign off anyway.

---

## 5. Generating a personal token

Each developer generates their own token in the **personal settings page** of the app
(`jira:personalSettingsPage`, §15):

1. Open your personal settings for the app in Jira.
2. Generate a token for the hook.
3. **The token is shown once.** Only its **hash** is stored (`hook_token.token_hash`), together
   with the account, the creation date and the last use date.
4. Put it in your environment:

   ```bash
   export PERMIS_AGENT_TOKEN=<token shown once>
   ```

   Add it to your shell profile or your CI variables so that the hook can send it.

Because only the hash is stored, a lost token cannot be recovered: generate a new one. Revoking a
token simply stops the `hook_token` row from matching.

---

## 6. Testing the gate manually with `curl`

The gate is a plain HTTP endpoint, so you can exercise it without Claude Code. The hook event
carries the **tool name, the arguments (command, file path) and the working directory** — the app
never asks for the content of the files (§16).

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $PERMIS_AGENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "toolName": "Bash",
        "args": { "command": "psql -c \"DELETE FROM orders\"" },
        "cwd": "/home/dev/payments"
      }' \
  "https://<installation>.webtrigger.atlassian.app/<chemin>/gate"
```

The answer is the decision body shown in §3: `allow`, `ask` or `deny`, with the reason and the
level.

Useful variations:

| What you want to check | `args` to send |
|---|---|
| A data deletion (A-09) | `{"command": "psql -c \"DELETE FROM orders\""}` |
| A schema migration (A-08) | `{"command": "alembic upgrade 0002_add_orders"}` or `{"file_path": "db/migrations/0002_add_orders.sql"}` |
| A file edit (A-02) | `{"file_path": "src/payments/charge.ts"}` |
| A test being disabled (A-04) | `{"file_path": "test/payments/charge.test.ts"}` |

Without the `Authorization` header the call is rejected: the web trigger has **no platform
authentication by default** (§18), so the personal token is what identifies the caller.

---

## 6b. Telling the gate which ticket the action serves

The client payload carries the tool name, its arguments and the working
directory — never a Jira key. Yet an action beyond N4 without a ticket is
refused (spec §20: "Action sans ticket : refusée au-delà de N4"), so the gate
accepts the ticket out of band:

| Transport | Value | Used by |
|---|---|---|
| `X-Permis-Issue` request header | the issue key, e.g. `PAY-42` | `examples/hooks/gate-bridge.sh` sends it from `$PERMIS_AGENT_ISSUE` |
| `issueKey` field in the POST body | the issue key | direct `curl` calls and the MCP tools |

```bash
export PERMIS_AGENT_TOKEN=<shown once>
export PERMIS_AGENT_GATE_URL="https://<installation>.webtrigger.atlassian.app/<path>/gate"
export PERMIS_AGENT_ISSUE=PAY-42      # optional, but required beyond N4
```

Without a ticket the gate still answers, and still decides: reading stays
allowed, and anything beyond N4 is refused with the invitation to cite a
ticket. That refusal is journaled like any other decision.

---

## 7. What the token is — and is not

The personal token **identifies the pilot**. It does **not** grant any right by itself (§16).

- It says *who* called the gate, so the ledger can attach the action to a human and to an agent
  profile.
- It does not authorise the action: the decision comes from the policy and from the permits.
- It does not let the pilot approve their own request: that check is on the approval side, not on
  the token.
- The agent never sees it as a capability: the file it protects (class **A-15**) cannot be edited
  by an agent, and the token only lives in the developer's environment.
- **It can be revoked.** A lost laptop, a leaked environment, a contractor leaving: an operator
  revokes the token and the gate refuses it from the next call, with `TOKEN_REVOKED` rather than
  `UNKNOWN_TOKEN` — so the pilot looks for a revocation instead of a typo. Revocation works from
  the plaintext token or from its hash, since the plaintext is never stored.

---

## 8. Security notes

- **The hooks file is protected by class A-15** ("edit the policy itself", N0). An agent that
  tries to modify `.claude/settings.json` is refused and the attempt is logged and lowers the
  trust capital of its profile.
- The hook sends **tool names, paths and commands** — never the content of the files. Commands are
  masked by pattern (tokens, passwords) before being stored (§19).
- The token is stored hashed; only its hash is kept by the app, and one hashing implementation is
  shared by the gate, the operator endpoint and the minting service (`src/core/tokens.ts`) — three
  places hashing the same secret must not drift apart.
- The gate is closed by default: `onFailure: "block"`.
- The URL of the gate is installation-specific and the endpoint is not platform-authenticated, so
  it must be treated as a sensitive internal endpoint: pair it with the personal token, **revoke
  the token if it leaks** (`revoke-token` on the operator endpoint), and rotate it.
- The permit-verification path — the one that needs no token, for CI — carries a budget of 60
  calls per minute. Beyond it the gate answers **429**, which fails a CI check: the safe direction,
  since an unverifiable permit must not let a pull request through. The budget is per container and
  Forge may run several, so it blunts bulk enumeration of sequential permit ids rather than
  guaranteeing a hard ceiling. Authenticated decisions are never throttled: a pilot's hook must not
  be slowed down by someone else's CI.
- Only the tools listed in the `matcher` are watched. Widening the matcher widens the audit
  surface but also the number of interrupted calls: the recommended matcher covers `Bash`, `Edit`
  and `Write`.

---

## 9. Other clients — the same gate, a command bridge

Claude Code is not the only client able to load a Claude Code hooks configuration: **Cursor**
reads `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json` when
*Settings → Agents → Third-Party Imports → "Include Third-Party Plugins, Skills, and Other
Configs"* is enabled (on by default). It maps the hook names (`PreToolUse` → `preToolUse`,
`PostToolUse` → `postToolUse`, `Stop` → `stop`, …), accepts the nested `hookSpecificOutput`
answer format, and honours `exit code 2` as a block.

What Cursor does **not** document as supported is the `http` hook type — it lists command-based
and prompt-based hooks. That is why `examples/hooks/gate-bridge.sh` exists: a small POSIX
bridge that reads the hook payload on stdin, POSTs it to the gate, prints the gate's answer and
exits 2 when the action must be blocked (or when the gate is unreachable — the bridge fails
closed, like `onFailure: "block"`).

```jsonc
// .cursor/hooks.json — Cursor, native format
{
  "version": 1,
  "hooks": {
    "preToolUse": [
      {
        "command": ".cursor/hooks/gate-bridge.sh",
        "matcher": "Shell|Write|Read",
        "timeout": 15,
        "failClosed": true
      }
    ]
  }
}
```

For Claude Code the HTTP form stays the simplest (no extra process), and the bridge is only
needed for clients that cannot call an HTTP endpoint from a hook.

### Version and allowlist notes (verified 11 November 2026)

| Fact | Consequence for this setup |
|---|---|
| `onFailure: "block"` on command and HTTP hooks requires Claude Code **v2.1.295+** | check the client version before relying on fail-closed behaviour; below that version, use the bridge with `exit 2` (honoured by both clients) |
| `allowedHttpHookUrls` and `httpHookAllowedEnvVars` are settings-level allowlists applied to HTTP hooks from **every** source | in a managed (enterprise) setup, the gate URL and `PERMIS_AGENT_TOKEN` must be added to those allowlists, otherwise the HTTP hook never fires |
| Hooks also run **inside subagents**; the payload then carries `agent_id` and `agent_type` | the gate can attribute an action to a sub-agent — this is what makes a delegation chain (a narrower permit for a child agent) enforceable |
| Cursor merges responses from all sources: any `deny` wins over `ask`, `ask` over `allow` | a project-level hook can tighten a user-level one, never loosen it — the same precedence as the policy grid |

Sources: https://code.claude.com/docs/en/hooks — https://cursor.com/docs/hooks —
https://cursor.com/docs/reference/third-party-hooks

---

## 10. The merge gate — verifying a permit from CI (enforcement point 3)

The hook enforces the policy on the workstation. A workstation can be switched off, so spec §10
adds a second, later gate: a pull request that touches a sensitive zone must carry a **valid
permit**. An app installed on Jira cannot call the forge API (§18), so this check runs on the
forge side — a CI step asks the gate, and the gate answers.

### The call

```bash
curl -sS -X POST "$PERMIS_GATE_URL" \
  -H 'Content-Type: application/json' \
  -d '{"permitId":"PA-2026-000417","paths":["db/migrations/001.sql","src/index.ts"]}'
```

`paths` is optional and accepts an array or a newline/comma separated string.

```json
{
  "permitId": "PA-2026-000417",
  "found": true,
  "valid": true,
  "covers": false,
  "uncovered": ["src/index.ts"],
  "signatureValid": true,
  "expired": false,
  "revoked": false,
  "suspended": false,
  "usesLeft": 1
}
```

| Field | Meaning |
|---|---|
| `found` | The permit id exists in this installation. An unknown id answers `found: false, valid: false, covers: false` — never a 404, so a CI step can treat both cases the same way. |
| `valid` | Is the permit itself usable: `signatureValid && !expired && usesLeft > 0 && !revoked && !suspended`. |
| `covers` | Are **all** the submitted `paths` inside the permit scope. `true` when no path is submitted, so a caller that only wants validity is unaffected. |
| `uncovered` | The paths that fall outside the scope — the reason a merge gate refuses, named. |
| `signatureValid` | The HMAC-SHA256 over the signed fields still matches with the installation secret — the permit was not rewritten. |
| `expired` / `revoked` / `suspended` / `usesLeft` | Why an invalid permit is invalid. No refusal without a reason. |

**A merge gate must check both.** `valid` alone would let any live permit through any pull
request: an agent holding a permit for one migration could ship the whole repository under it.
The gate answers `covers` for exactly that, and the check fails on `!valid || !covers`.

`usesLeft: 0` with `valid: false` is the normal end of a single-use permit that has already been
spent: the action happened, the proof is closed. Verification does **not** consume a use — a pull
request is pushed many times before it merges, and the use is spent by the action itself, through
the hook. A CI check therefore runs while the permit still has uses left.

### The ready-to-use workflow

[`examples/ci/verify-permit.yml`](../examples/ci/verify-permit.yml) is a complete GitHub Actions
workflow, verified live against the deployed installation (a spent permit answered `valid: false`,
a freshly approved one `valid: true`). Copy it into `.github/workflows/` of the repository you want
to guard and set **one** secret, `PERMIS_GATE_URL`.

It extracts the `PA-2026-000417` an agent cites in its pull request description, asks the gate, and
fails the check when the answer is not `valid`. It is triggered by the unprivileged `pull_request`
event and holds `contents: read` + `pull-requests: read` only: the step reads a description and
calls an endpoint, so it needs no write access and must not run with elevated privileges.

### Why no token, and what that costs

Verification mode is reachable **without** a personal token. That is deliberate: a CI runner cannot
hold a developer's token, and a web trigger has no platform authentication, so possession of the
gate URL *is* the credential.

The consequence is honest and worth stating: permit ids are sequential, so anyone holding the gate
URL has an enumeration oracle. The answer is therefore **minimised** — it says whether a permit is
valid and why, but never its `scope`. A caller cannot learn *which target* a permit authorises (the
file, the command, the ticket) by guessing ids. `covers` narrows that a little: a caller who
supplies candidate paths learns whether they fall inside the scope of a permit they already named.
That is the price of a merge gate that can explain its refusal, and it discloses far less than the
scope itself — the paths of a pull request are public in the pull request. Deciding an action still
requires the pilot's personal token; only the yes/no verification is open.

Keep the gate URL in a CI secret, not in the workflow file.
