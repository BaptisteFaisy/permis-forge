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

## 7. What the token is — and is not

The personal token **identifies the pilot**. It does **not** grant any right by itself (§16).

- It says *who* called the gate, so the ledger can attach the action to a human and to an agent
  profile.
- It does not authorise the action: the decision comes from the policy and from the permits.
- It does not let the pilot approve their own request: that check is on the approval side, not on
  the token.
- The agent never sees it as a capability: the file it protects (class **A-15**) cannot be edited
  by an agent, and the token only lives in the developer's environment.

---

## 8. Security notes

- **The hooks file is protected by class A-15** ("edit the policy itself", N0). An agent that
  tries to modify `.claude/settings.json` is refused and the attempt is logged and lowers the
  trust capital of its profile.
- The hook sends **tool names, paths and commands** — never the content of the files. Commands are
  masked by pattern (tokens, passwords) before being stored (§19).
- The token is stored hashed; only its hash is kept by the app.
- The gate is closed by default: `onFailure: "block"`.
- The URL of the gate is installation-specific and the endpoint is not platform-authenticated, so
  it must be treated as a sensitive internal endpoint: pair it with the personal token, and rotate
  the token if it leaks.
- Only the tools listed in the `matcher` are watched. Widening the matcher widens the audit
  surface but also the number of interrupted calls: the recommended matcher covers `Bash`, `Edit`
  and `Write`.
