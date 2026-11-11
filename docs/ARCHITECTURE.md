# Architecture

Permis d'agir is a **single Atlassian Forge app installed on Jira**. It owns the policy, the
approvals, the permits and the ledger; it exposes them to agents through an MCP module and a web
trigger used by the client hook.

> The product specification (in French) is kept verbatim in [`SPEC.md`](SPEC.md). Section numbers
> below refer to it.

---

## 1. Forge modules

The manifest follows the sketch of §16; it is validated with `forge lint` before each deployment.
The nine MCP tools are declared once and reused by three modules — the `action` module (one
entry per tool, one Forge function each), the `rovo:mcp` server and the `rovo:skill` that tells
the agent how to use them:

```yaml
modules:
  function:                   # one Forge function per tool, per screen, per trigger
  action:                     # the eight tools, one entry each
    - key: check-permission
      function: check-permission-fn
      actionVerb: GET
      inputs: { issueKey, actionClass, target, description, command }
    # … get-policy, request-approval, get-request-status, list-permits,
    #   declare-action, submit-plan, get-agent-standing
  rovo:mcp:
    - key: permis-mcp
      name: Permis d'agir
      tools: [check-permission, get-policy, request-approval, get-request-status,
              list-permits, declare-action, submit-plan, get-agent-standing]
  rovo:skill:                 # usage instructions for the agent
  rovo:agent:                 # the "Permis d'agir" Rovo agent
  webtrigger:
    - key: gate               # hook entry point and CI verification
      function: gate-fn
      urlFormat: v2
      response: { type: dynamic }
  jira:issuePanel:
  jira:projectSettingsPage:
  jira:projectPage:
  jira:globalPage:
  jira:personalSettingsPage: # generation of the personal hook token
  trigger:                    # avi:jira:updated:issue (ticket status, related incidents)
  scheduledTrigger:           # permit expiry, trust erosion, chain verification
  sql:                        # engine: mysql
  llm:                        # classification of free-form descriptions
```

| Module | Role |
|---|---|
| `action` | The eight tools, one entry each, with their inputs and their verb (GET / CREATE). Forge actions accept only strings, integers, numbers and booleans, and run for 55 s at most. |
| `rovo:mcp` | The MCP server exposing those tools to external clients at `https://mcp.atlassian.com/forge/<appId>` (OAuth 2.1, after an administrator activates the installation) |
| `rovo:skill` | The instructions the agent follows: ask before acting, announce the request number, declare afterwards |
| `rovo:agent` | The "Permis d'agir" Rovo agent, to query the policy and the ledger from Rovo Chat |
| `webtrigger: gate` | The HTTP entry point used by the Claude Code hook and by CI verification |
| `jira:*` | Issue panel, project settings, project page, global page, personal settings |
| `trigger` / `scheduledTrigger` | Ticket status changes; nightly permit expiry, trust erosion and chain verification |
| `sql` | The Forge SQL tables of §17 |
| `llm` | Proposes a class when the agent gives only a free-form description |

---

## 2. Decision flow

Every call — from MCP, from the hook, from the simulation console or from CI — goes through the
same five steps (§16):

1. **The call arrives** through MCP or through the hook. The identity comes from the context of
   the call (Atlassian account) or from the personal token of the hook, **never from the inputs**.
2. **The action is classified**, then reclassified if the target or the command requires it
   (deterministic patterns first; the `llm` module only for free-form descriptions; the most
   restrictive class wins on doubt).
3. **The applicable rules are resolved** — organisation rules first as a floor, then project rules.
   The **most restrictive** applicable level wins; without a matching rule the default level of the
   class applies; if the kill switch is active, everything above reading becomes N0.
4. **A valid permit that covers exactly this action is looked up** and, if it exists, one usage is
   consumed.
5. **The decision is written to the ledger**, then returned with its reason and the next step to
   take.

The same pipeline feeds the four enforcement points: the MCP tool (1), the hook (2), the merge
gate or CI step (3) and the after-the-fact detection (4).

---

## 3. Data model (Forge SQL)

| Table | Main columns |
|---|---|
| `policy_rule` | id, scope (organisation, project), project_id, action_class, zone_id, conditions_json, level, mode |
| `zone` | id, project_id, name, path_patterns, component, environment |
| `agent_profile` | id, project_id, name, client, trust_score, status |
| `request` | id, issue_id, profile_id, pilot_account_id, action_class, target, justification, plan, status, created_at |
| `approval` | id, request_id, approver_account_id, role, decision, reason, at |
| `permit` | id, request_id, scope_json, expires_at, uses_left, signature, revoked_at |
| `ledger` | seq, at, kind, project_id, issue_id, profile_id, pilot_account_id, action_class, target, rule_id, decision, permit_id, prev_hash, hash |
| `trust_event` | id, profile_id, delta, reason, ledger_seq, at |
| `kill_switch` | scope, project_id, active, by, reason, at |
| `hook_token` | account_id, token_hash, created_at, last_used_at |

Relations are expressed by columns (`project_id`, `issue_id`, `profile_id`, `request_id`),
**not** by foreign keys: Forge SQL has no foreign keys (§18).

---

## 4. Module map

The code separates the *decision logic* from the *platform*, so that the rules can be tested
without a Forge runtime.

| Path | Responsibility | Platform? | State (11 Nov 2026) |
|---|---|---|---|
| `src/core/` | Pure TypeScript: action-class catalogue, glob matching, approvals, kill switch, trust capital, plan-first evaluation, hook mapping, permits and ledger model | No | Present |
| `src/storage/` | Repository adapters over `@forge/sql` (`schema.ts` defines the ten tables), plus an in-memory adapter (`memory.ts`) used by the tests | Yes (`@forge/sql`) | Schema and in-memory adapter present |
| `src/ui/` | Forge resolvers: issue panel, project settings page, project page, global page, personal settings page, simulation console | Yes (`@forge/resolver`) | In progress |
| `src/mcp/` | Tool definitions, runtime wiring and the handlers of the nine MCP tools (6 reads, 3 writes) | Yes | Present |
| `src/hooks/` | The `webtrigger` gate handler: reads the personal token, maps the hook event, answers *allow* / *ask* / *deny* | Yes | Present |
| `src/triggers.ts` | Issue-update trigger and nightly maintenance (permit expiry, trust erosion, chain verification) | Yes | Present |
| `src/index.ts` | Entry point: every handler referenced by `manifest.yml`, re-exported thin | Yes | Present |
| `manifest.yml` | Forge manifest (§1 above) | — | Present |

`src/core` defines the repository *interfaces* (`PolicyRepository`, `ZoneRepository`,
`ProfileRepository`, `RequestRepository`, `PermitRepository`, `LedgerRepository`,
`TrustRepository`, `KillSwitchRepository`, `HookTokenRepository`), so the same decision code runs
against Forge SQL in production and against the in-memory adapter in the tests.

---

## 5. The hash-chained ledger

The ledger is append-only and tamper-evident: each entry contains the fingerprint of the previous
one, so any deletion or modification breaks the chain and the verification screen shows where.

**Genesis.** The first entry of a project chain has no predecessor: its `prev_hash` is the
genesis value (a fixed constant such as 64 zeroes) and its `hash` is computed from it.

**Canonical JSON.** The fingerprint is computed over a *canonical* serialisation of the entry, not
over the raw row: keys sorted, no insignificant whitespace, numbers and booleans in a fixed form,
`null` distinct from an absent field. The canonical form of an entry is therefore reproducible
across runs and across languages.

**Digest.** `hash = sha256(canonical_json(entry_without_hash_field))`, hex-encoded. The entry
stored in `ledger.hash` is that digest, and `ledger.prev_hash` is the `hash` of the previous entry
(`seq - 1`). The chain for a project is therefore:

```
seq 1: prev_hash = GENESIS,          hash = sha256(canon(entry 1))
seq 2: prev_hash = hash(entry 1),    hash = sha256(canon(entry 2))
seq 3: prev_hash = hash(entry 2),    hash = sha256(canon(entry 3))
```

**Verification.** The nightly scheduled trigger walks the chain in sequence order and recomputes
each digest: the first entry whose recomputed hash differs from the stored one, or whose
`prev_hash` does not match the previous entry, is reported as the **first break**. Verification
also answers the audit question "who authorised this action, on what basis, and was the agent
allowed to do it alone?" by replaying the chain.

**Concurrent writes.** Hash chaining under concurrent writes is one of the points to validate in
the first week (§18). The fallback is a **single-consumer queue** that allocates the sequence
number, so that two entries can never claim the same `seq` and interleave their hashes.

**Nothing is editable.** A correction is a new entry that points back to the one it corrects; the
chain is never rewritten.

---

## 6. Permit signing

A permit is the proof that a human authorised a specific action, for a specific target, for a
limited time and a limited number of usages (§8.3).

| Field | Content |
|---|---|
| Identifier | `PA-2026-000417` |
| Scope | Class, exact target, ticket |
| Duration | 2 hours by default, adjustable by the approver |
| Usages | 1 by default |
| Holder | Agent profile and pilot |
| Signature | Fingerprint computed with an installation secret |

**Signing.** The signature is an **HMAC-SHA256** over the canonical JSON of the signed fields —
identifier, scope (class, exact target, ticket), expiry timestamp, initial usage count, holder
(profile and pilot) — keyed with the **installation secret**. The secret never leaves the
installation; only the signature is stored, next to the fields it covers.

**Checking a permit.** A permit is valid when it is not revoked, `expires_at` is in the future,
the holder matches the caller, the scope covers **exactly** the action (class + exact target +
ticket) and usages remain. A permit granted for one file does not cover another: that is a
refusal and a logged deviation.

**Usage decrement.** When a permit covers an action, one usage is consumed in the same
transaction that writes the ledger entry. The remaining count is what `list-permits` returns.
Consumption is idempotent per decision: one decision consumes at most one usage.

**Revocation.** `revoked_at` is set on the permit row; a revoked permit never lets anything
through, even before its expiry. Revocation itself is written to the ledger.

**Expiry.** Permits expire on their own (`expires_at`); the scheduled trigger also marks them as
expired. A permit that expires **during** an execution does not interrupt the action in flight —
the next one is refused (§20).

---

## 7. Trust capital rules

Trust capital is a score per agent profile, from 0 to 100, initialised at 50 (§9).

| Event | Effect |
|---|---|
| Action declared, report confirmed by a human | +1 |
| Request granted and executed in line with the permit | +2 |
| Report corrected by the reviewer | −2 |
| Sensitive action discovered without a declaration | −10 |
| Action outside the approved plan | −10 |
| Incident attached to an agent action | −25 |
| Attempt on a forbidden class | −5 |

Rules that surround it:

- each variation is written to `trust_event` (with `delta`, `reason`, `ledger_seq`) and explained
  in the ledger;
- **trust capital never opens a class set to N0, N1 or N2** — it only moves N3 → N4 and N4/N5 →
  N3;
- above 80, classes set to N3 move to N4; below 30, classes set to N4 and N5 (reading excluded)
  move to N3; at 0 the profile is suspended until human review;
- in the absence of activity, the score erodes slowly back towards 50 (scheduled trigger);
- the effects are opt-in per project: a project may decide not to let trust capital change its
  policy at all.

---

## 8. Limits and constraints

### Verified in the documentation (§18, 10–11 November 2026)

| Area | Constraint | Consequence for the design |
|---|---|---|
| `rovo:mcp` | In Preview, one module per app, 50 tools at most; external access at `https://mcp.atlassian.com/forge/<appId>` in OAuth 2.1, after an administrator activates the installation | One MCP module with the eight tools; admin activation is part of the setup |
| External MCP call | A tool runs with the rights of the user who authorised the client | Identity is read from the call context, never from the inputs |
| Forge action | Inputs limited to strings, integers, numbers and booleans; 55 s; inputs may be invented by the model | The identity is read from the context; the action only carries data |
| Automation-triggered agents | They may only call `GET` actions | Mutations are exposed as creations (`request-approval`, `declare-action`, `submit-plan`) |
| Web trigger | Installation-specific URL, **no platform authentication by default**, 55 s | The hook calls it with a **personal token**; the token identifies the pilot and grants no right by itself |
| Claude Code hooks | `PreToolUse` event, filtering by tool name (MCP tools included) and by arguments, types `command`, `http` and `mcp_tool`, refusal by exit code or by the `deny` / `ask` / `allow` decision, option `onFailure: "block"` | The gate is an `http` hook with `onFailure: "block"` |
| Forge SQL | 1 GiB per installation in production, 5 s per SELECT, no foreign keys | Relations by columns; the policy and the hot path are cached |
| Jira + Bitbucket | A Forge app installed on Jira **cannot call the Bitbucket API** | Enforcement point 3 (merge gate) requires a **companion app on the Bitbucket side** |

### To validate with a prototype in the first week (§18)

| Point | Why it matters | Fallback |
|---|---|---|
| Identity transmitted to an action during an external MCP call | Underpins the ban on self-approval | Require a personal token for MCP too |
| `mcp_tool` hook: shape of the returned decision | Would remove the web trigger and the token | `http` hook towards the web trigger |
| Web trigger response time under load | The hook runs on every filtered tool call | Filter by patterns client-side, cache the policy |
| Equivalent hooks in other clients | Scope beyond Claude Code | Points 1, 3 and 4 of §10 |
| Hash chaining under concurrent writes | Ledger integrity | Sequence number allocated by a single-consumer queue |
| Notifying approvers | Approval latency | Mention in an issue comment |

### Non-functional requirements (§19)

- **Speed**: decision in under 2 s over MCP, under 1 s through the hook in 95 % of cases.
- **Closed by default**: without an answer from the app, every tool call filtered by the hook is
  blocked. The hooks file only filters sensitive tools and patterns so that normal work is not
  interrupted.
- **Separation of powers**: the pilot does not approve; whoever sets the policy is traced; the
  agent touches neither the policy nor the hooks.
- **Integrity**: chained ledger, verified every night, no deletion.
- **Sobriety**: the app receives tool names, paths and commands — never the content of the files.
  Commands are masked by pattern before storage (tokens, passwords).
- **Explainability**: no refusal without a cited rule and a next step.
- **Languages**: the interface is available in English and French; the submission is in English.
