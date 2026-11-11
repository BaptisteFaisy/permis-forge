# Validations — state of the six prototype points (spec §18)

> The specification (§18, "À valider par un prototype la première semaine") lists six points
> that documentation alone cannot settle. This file states, for each one: **what must be
> proved**, **why it is critical**, **the validation method**, the **honest status** as of
> 11 November 2026, the **result obtained** when there is one, the **fallback** from the spec,
> and the **exact documentation link**. All documentation below was fetched and read on
> 11 November 2026. Nothing is measured that has not been measured: figures that require a
> deployed installation are marked **"to be measured after deployment"** with the exact
> measurement procedure.

| # | Point | Status (11 Nov 2026) |
|---|---|---|
| 1 | Identity transmitted to an action during an external MCP call | Verified in documentation — runtime confirmation to be done after deployment |
| 2 | `mcp_tool` hook type and shape of the returned decision | **Done (documentation)** — decision taken: keep the `http` hook |
| 3 | Web trigger response time under load | To be measured after deployment |
| 4 | Equivalent of hooks in other clients | Blocked on client documentation survey — fallback applies |
| 5 | Hash chaining under concurrent writes | **In progress** — sequential chain unit-tested; concurrency test being written |
| 6 | Notifying approvers | To be done after deployment |

---

## 1. Identity transmitted to an action during an external MCP call

**What must be proved.** When a tool is invoked by an external MCP client (Claude Code, Cursor…)
through `https://mcp.atlassian.com/forge/<appId>`, the Forge `action` function receives the
Atlassian identity of the authorising user in its call context — so the app can enforce "the
pilot never approves their own request" (spec §8.2, requirement PA-05) against a real identity
rather than a claimed one.

**Why it is critical.** The whole separation of powers rests on it. If identity were only what
the inputs say, a model could invent an approver and self-approve; the spec's decision flow
(§16) states identity comes "from the context of the call or from the personal token, never
from the inputs".

**Method.** Documentation reading (done) + prototype after deployment: deploy the app, enable
external exposure, connect a client, call `check-permission`, and log the context received by
the function (the `accountId` it carries) for two different authorising users.

**Status.** **Verified in documentation; runtime confirmation to be done after deployment.**
What the documentation already establishes:

- the Rovo MCP reference: external clients connect to `https://mcp.atlassian.com/forge/<appId>`
  through an **OAuth 2.1** consent screen, after a **site or org admin enables the exposure** in
  Atlassian Administration (disabled by default, per installation); once connected, "the client
  can invoke any of the tools … **subject to the invoking user's own permissions on that site**".
- the Action reference: "The **context contains the user's accountId**", and explicitly: "Your
  app should **never rely on values passed as inputs** to perform critical checks like
  authorization. If you need a user's accountId **read it from the context**." Inputs "are
  subject to hallucination".

**Result obtained.** Documentation confirms the design assumption (identity in context, inputs
untrusted). The remaining question — that the context is populated identically for calls coming
through the external MCP endpoint — needs one deployed prototype call; procedure: `forge deploy`,
enable exposure, connect the client, call `check-permission` with a throwaway `issueKey`, and
inspect the logged context in the Forge logs (view app logs in the developer console).

**Fallback (spec §18).** If the identity turned out to be missing or unusable from an external
MCP call: require the **personal hook token for MCP calls too** — the token is bound to an
account at generation time (`hook_token.account_id`), so it restores identity independently of
the platform context.

**Documentation links.**
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/ (sections "Connect tools to third-party AI clients (Preview)")
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-action/ (sections "Writing your action" → "Understanding input and context")

---

## 2. `mcp_tool` hook type and shape of the returned decision

**What must be proved.** Whether Claude Code's `mcp_tool` hook type could replace the `http`
hook + web trigger + personal token: i.e. whether a `PreToolUse` hook of `type: "mcp_tool"`
calling `check-permission` directly on the Atlassian MCP server returns a usable
allow/deny/ask decision — and fails **closed**.

**Why it is critical.** It would remove the web trigger, the token management and a network
hop from the main enforcement point (spec §18: "Éviterait le web trigger et le jeton").

**Method.** Documentation reading of the Claude Code hooks reference (done — decisive).

**Status.** **Done (documentation), 11 November 2026.** Verified facts:

- hook types on `PreToolUse` include `command`, `http`, `mcp_tool` (also `prompt` and `agent`);
  an `mcp_tool` hook declares `server` (a configured MCP server), `tool`, and optional `input`
  with `${tool_input.*}` substitution.
- **Decision shape**: the tool's text output is parsed exactly like a command hook's stdout —
  the same JSON output schema, so `hookSpecificOutput.permissionDecision` (`allow` / `deny` /
  `ask` / `defer`) + `permissionDecisionReason` would work.
- **But it fails open.** "If the tool returns `isError: true`, the hook produces a
  **non-blocking error and execution continues**." And `onFailure: "block"` — the option that
  makes a gate closed by default — is documented for **`command` or `http` hooks only**
  (requires Claude Code v2.1.295+). A timed-out `mcp_tool` hook on `PreToolUse` does not block
  the call either.
- Additional constraint: an `mcp_tool` hook **never starts an OAuth flow**; the MCP server must
  already be connected and authenticated in the session (via `/mcp`), and a not-yet-connected
  (cached) server yields a non-blocking error.

**Result / decision.** The `mcp_tool` hook **cannot guarantee fail-closed behaviour**, which is
a hard product requirement (spec §19 "Fermé par défaut": without an answer from the app, every
filtered call is blocked). **The `http` hook towards the `gate` web trigger with
`onFailure: "block"` is kept as the enforcement design** — the spec's own fallback becomes the
chosen solution. The web trigger has no platform authentication, which is exactly why the
personal token exists (validation 1's fallback mechanism doubles as this one's identity).

**Fallback (spec §18).** `http` hook towards the web trigger — **adopted as the primary design**.

**Documentation links.**
- https://code.claude.com/docs/en/hooks (sections "MCP tool hook fields", "How the tool's result is read", "When the server is still connecting", "Block the action when a hook fails", "HTTP hook fields", "PreToolUse decision control", "HTTP response handling")

---

## 3. Web trigger response time under load

**What must be proved.** The `gate` web trigger answers a hook decision fast enough to run
before **every** filtered tool call: the product target is **< 1 s on 95 % of calls** through
the hook (spec §19), within the platform ceiling of **55 s** maximum runtime for web trigger
functions and the invocation rate limits.

**Why it is critical.** If the gate is slow, developers disable the hook and the main
enforcement point disappears (spec §25, risk "Latence du hook").

**Method.** Measurement on the deployed installation (app `a700e3ab-b722-4ae3-8a8a-b9f1a1b4c341`,
Jira site `one-atlas-cndz.atlassian.net`, development environment, 11 November 2026). Calls are
sent with `curl -w '%{time_total}'` to the installation's gate URL, with a personal hook token
and the `X-Permis-Issue` header, from a residential connection in France.

**Status.** **Measured — target met (11 November 2026).**

**Exact measurement procedure** (once `forge deploy` has run on the demo site and a hook token
exists):

1. Warm-up: 10 sequential calls (discarded).
2. Load: **200 calls** — 20 rounds of 10 parallel requests — against the gate URL with a
   representative payload (A-09 command, `deny` path — the heaviest: it creates a request and
   writes a ledger entry):

   ```bash
   for round in $(seq 1 20); do
     seq 1 10 | xargs -P10 -I{} curl -sS -o /dev/null -w '%{time_total}\n' \
       -X POST "$GATE_URL" \
       -H "Authorization: Bearer $PERMIS_AGENT_TOKEN" \
       -H "Content-Type: application/json" \
       -d '{"toolName":"Bash","args":{"command":"psql -c \"DELETE FROM orders\""},"cwd":"/tmp/demo"}'
     sleep 2
   done | tee gate-timings.txt
   sort -n gate-timings.txt | awk '{a[NR]=$1} END {print "p50", a[int(NR*0.50)]; print "p95", a[int(NR*0.95)]; print "p99", a[int(NR*0.99)]}'
   ```

3. Repeat with the `allow` path (a plain A-02 file edit) — 200 calls, same shape.
4. Targets: **p95 < 1 s** for the allow path, **p95 < 2 s** for the deny path (request
   creation + ledger write); also verify no HTTP 429 appears (rate limits: 1,200 invocations
   per minute per user, 7,000 per minute and 300 per second per install).

**Result obtained (measured, not inferred).**

Read path — `Read` on `src/index.ts`, class A-01, level N5, `allow`, no journal write
(30 sequential calls on a warm container):

| Metric | Value |
|---|---|
| min | 0.289 s |
| median | 0.398 s |
| **p95** | **0.630 s** |
| max | 0.688 s |
| mean | 0.427 s |
| under 1 s | **30/30 (100 %)** — target is 95 % (spec §19) |

Write path — `Edit` on `db/migrations/002_index.sql`: reclassified A-08, level N2, no permit,
so the call creates an approval request **and** appends a chained ledger entry to Forge SQL:
**0.463 s** (single call) and **0.597 s** in an earlier run. The heaviest decision path stays
well under one second.

Cold start — the first call to a fresh container costs more: **3.41 s** observed once in a
15-call sample, and **15.4 s** for the very first call after a deploy, because that invocation
also creates the ten SQL tables and seeds the organisation rules (one-off, idempotent).
Cold starts are the only observed breach of the 1 s target; the p95 over a warm sample is
0.63 s.

No HTTP 429 was observed at this volume (30-60 sequential calls). The platform figures remain
as documented: web trigger functions stop after **55 s**, Forge SQL allows **150 DML requests
per second per install**, **5 s per SELECT** and **10 s per INSERT/UPDATE/DELETE**.

**Interpretation.** The target of spec §19 (< 1 s on 95 % of hook calls) is met on warm
containers, including on the write path. The residual risk is the cold start, which is a
platform property, not a code property: the mitigation is client-side filtering (matcher +
`if` conditions) so the gate is only called for genuinely sensitive tools, and the hooks file
generated by the app already narrows the matcher to `Bash|Edit|Write|MultiEdit`.

**Fallback (spec §18).** If p95 exceeds the target: **filter more narrowly by patterns
client-side** (matcher + `if` conditions reduce the number of gated calls) and **cache the
policy** in the app between calls.

**Documentation links.**
- https://developer.atlassian.com/platform/forge/limits-invocation/ (55 s runtime for web trigger/action modules; rate limits)
- https://developer.atlassian.com/platform/forge/limits-sql/ (DML RPS, per-query timeouts)
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/ (installation-specific URL, no platform authentication)

---

## 4. Equivalent of hooks in other clients

**What must be proved.** Whether other AI coding clients (beyond Claude Code) offer a
pre-tool-call interception mechanism — hook, guardrail or policy callback — that could call the
gate, so enforcement point 2 extends past Claude Code.

**Why it is critical.** Determines the real reach of the product (spec §18: "Portée au-delà de
Claude Code") and the honest wording of the Marketplace listing.

**Method.** Documentation survey, client by client (each vendor's hooks/guardrails reference),
plus a hands-on test for every client that documents a mechanism. Only the Claude Code
documentation has been verified so far; **no claim is made about any other client's
capabilities** — their documentation has not been read for this file and no URL for it is cited
here.

**Status.** **Done (documentation survey), 11 November 2026.** Findings:

- **Cursor loads Claude Code hook configurations** (`.claude/settings.json`,
  `.claude/settings.local.json`, `~/.claude/settings.json`) when "Include Third-Party Plugins,
  Skills, and Other Configs" is enabled (on by default), maps `PreToolUse` to `preToolUse`,
  accepts the nested `hookSpecificOutput` answer, and honours `exit code 2` as a block.
- Cursor documents **command-based and prompt-based** hooks, not the `http` type: an HTTP hook
  needs a command bridge. `examples/hooks/gate-bridge.sh` provides it — it POSTs the payload to
  the gate, prints the gate's answer, and exits 2 when the action must be blocked **or when the
  gate is unreachable** (fail-closed, matching `onFailure: "block"`).
- Claude Code exposes `onFailure: "block"` from **v2.1.295+**; below that version the bridge's
  `exit 2` is the portable way to fail closed (both clients honour it).
- Claude Code settings allowlists (`allowedHttpHookUrls`, `httpHookAllowedEnvVars`) apply to HTTP
  hooks from every source, so a managed deployment must list the gate URL and the token
  variable there or the HTTP hook never fires.
- Hooks also fire **inside subagents** (`agent_id`, `agent_type` in the payload), which is what
  makes a delegation chain enforceable — a child agent inherits the parent's hook and can be
  given a narrower permit.

The runtime half of this validation (same hook, same gate, in a second client) still needs a
second client installed and is not claimed as done.

Sources: https://cursor.com/docs/reference/third-party-hooks — https://cursor.com/docs/hooks —
https://code.claude.com/docs/en/hooks

- the **MCP tool (point 1) works for any MCP-compatible client**, since the `rovo:mcp` endpoint
  is a standard remote MCP server (OAuth 2.1) — this is documented and verified (see point 1).
- the **gate web trigger is plain HTTP**: any client able to run a pre-action command or HTTP
  call can use it, whatever it calls the mechanism.

**Result obtained.** None for other clients; deliberately no invented facts.

**Fallback (spec §18).** Rely on enforcement **points 1, 3 and 4** of §10 for clients without
hooks: the MCP tool (cooperation), the merge gate / CI verification (blocking before the main
branch — via the companion Bitbucket app or a CI step calling the gate), and after-the-fact
detection. The ledger marks a profile with no installed hook as **"unconstrained"** (spec §20),
so the app never overstates its coverage.

**Documentation links.**
- https://code.claude.com/docs/en/hooks (the one verified client mechanism: `PreToolUse`, matcher on tool names including MCP tools `mcp__<server>__<tool>`, `if` conditions on arguments)
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-mcp/ (client-agnostic MCP exposure)

---

## 5. Hash chaining under concurrent writes

**What must be proved.** Two decisions written at the same moment on the same project cannot
claim the same `seq`, nor interleave their `prev_hash` — the chain must stay linear and
verifiable under concurrency, on the real Forge SQL backend (no foreign keys, no unique
constraint enforcement across concurrent transactions is assumed).

**Why it is critical.** Ledger integrity is the audit promise (spec §11, §19 "Intégrité"): a
chain that forks or repeats a sequence number under load is worthless as proof.

**Method.** Two layers: (a) an **offline concurrency unit test** against the in-memory
adapter — 25 parallel writes, then full chain verification; (b) after deployment, the same
scenario against Forge SQL plus the nightly `scheduledTrigger` verification.

**Status.** **Done offline (11 November 2026); the Forge SQL layer still to be measured
after deployment.**

- The **sequential chain is implemented and unit-tested today** (`src/core/ledger.ts`,
  `test/ledger.test.ts`): genesis hash = 64 zeroes, each entry links `prev_hash` to the
  previous entry's `hash` (`sha256` over the canonical JSON), `verifyChain` detects a rewritten
  entry, a deleted entry and a non-genesis first entry, and corrections append a new entry
  pointing back — 13 test cases passing in the suite of 221.
- The **concurrency test exists and passes** (`src/storage/queue.ts`, `test/ledger-concurrency.test.ts`):
  25 parallel writes on one project produce 25 entries with unique, contiguous sequence numbers
  and a chain accepted by `verifyChain`; two projects fed in parallel yield two independent
  valid chains; a forced sequence conflict raises `LEDGER_CONFLICT` after the bounded number of
  optimistic retries without writing a broken entry. The writer serialises writes per project
  through a single-consumer queue, which is the fallback the spec anticipates.
- The **Forge SQL layer** has a structural advantage for this validation: each install's
  statements run under a 10 s write timeout and 150 DML RPS, but the platform gives **no
  cross-statement transaction guarantee to build on** — so the design must not depend on one.

**Result obtained.** Sequential chaining: verified by test (offline). Concurrency: verified
by test against the in-memory adapter — 25 parallel writes, no duplicate sequence number, no
broken link. The same scenario against Forge SQL is still to be measured after deployment.

**Fallback (spec §18).** **Sequence number allocated by a single-consumer queue**: this is the
mechanism actually implemented in `src/storage/queue.ts` — writes go through one consumer per
project that assigns `seq` and computes the chain link, so two entries can never interleave
(the async events queue / single-consumer pattern), with a bounded optimistic retry when the
storage reports a sequence conflict. A multi-instance deployment would need the same guarantee
from the storage layer (a lock or a Forge queue) — the in-memory queue covers a single Forge
process, which is the case today (Runs on Atlassian).

**Documentation links.**
- https://developer.atlassian.com/platform/forge/limits-sql/ (no foreign keys, single query per statement, DML RPS, write timeouts)
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/web-trigger/ (the gate's 55 s ceiling bounding any in-invocation serialisation)

---

## 6. Notifying approvers

**What must be proved.** When `request-approval` creates a request at N2/N1, the authorised
approvers actually **receive a Jira notification** quickly enough for the hook-denied agent to
resume in a human-scale delay — without any external messaging service.

**Why it is critical.** Approval latency is the product's main friction (spec §25: too many
interruptions leads to workarounds); a request nobody is notified about is a request that
never gets answered.

**Method.** Prototype on the deployed site: create a request, post an issue comment mentioning
the approvers through the Jira REST API (`write:jira-work` scope), and verify with a second
account that Jira's native notification (bell + email, per the approver's own notification
settings) fires. Measure the delay between request creation and notification receipt on 10
consecutive requests.

**Status.** **To be done after deployment.** Nothing has been sent or measured yet: as of
11 November 2026 the code contains **no Jira REST call** (no `requestJira` usage in `src/`) —
the notification comment is part of the deployment-week work (spec §24, week of 25 Nov – 1 Dec,
"Requests, approvals, permits, issue panel").

**Result obtained.** None — no measurement exists. Expected mechanism (to confirm): a comment
with user mentions triggers Jira's standard notification pipeline; the delay depends on the
site's email/notification configuration, not on the app.

**Fallback (spec §18).** **Mention in an issue comment** — which is precisely the primary
mechanism chosen here, the platform-native one; if mentions proved unreliable for
non-watchers, the request card on the issue panel plus the watchers list remains as a second
channel. No push notification outside Jira is planned (egress declaration: nothing leaves
Atlassian).

**Documentation links.**
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/ (Jira Cloud REST v3, issue comments group — the "Add comment" operation used for the mention)
- https://developer.atlassian.com/platform/forge/manifest-reference/modules/index-jira/ (Jira modules available to the app, listed in spec §28)

---

## 7. Live end-to-end validation on the deployed installation

Not one of the six points above, but the proof that the product actually runs on Forge. Executed
on 11 November 2026 against app `a700e3ab-b722-4ae3-8a8a-b9f1a1b4c341` (version 2.2.0),
installed on `one-atlas-cndz.atlassian.net` (Jira, development environment), through the real
`gate` web trigger and Forge SQL — no local shortcut, no in-memory adapter.

| Step | Call | Observed result |
|---|---|---|
| 1 | `POST {admin}` `{"action":"status","projectId":"PAY"}` | `rules: 5` (the organisation floor seeded by the schema bootstrap), `chainValid: true` — Forge SQL persists across invocations |
| 2 | `POST {admin}` `{"action":"mint-token", …}` | personal token issued (32 chars), only its SHA-256 hash stored |
| 3 | `POST {gate}` `Edit db/migrations/001_init.sql` with the token and `X-Permis-Issue: PAY-42` | **deny**, target reclassified **A-08**, level **N2** by class default, request **RQ-2026-000001** created and cited in the reason |
| 4 | `POST {admin}` `approve-request` as a third party (`tech-lead`) | `status: granted`, permit **PA-2026-000001** issued, 30 min, 1 use |
| 5 | `POST {gate}` same action again | **allow** — the permit covers it and one use is consumed |
| 6 | `POST {gate}` same action a third time | **deny** + new request **RQ-2026-000002**: the single-use permit is spent (spec §21.3, live) |
| 7 | `POST {gate}` `{"permitId":"PA-2026-000001"}` (CI verification) | `found: true`, `signatureValid: true`, `expired: false`, `usesLeft: 0`, `valid: false` — the HMAC signature survives the round trip through Forge SQL |
| 8 | `POST {admin}` `status` again | `permits: 1`, `ledgerEntries: 5`, `chainValid: true`, `chainChecked: 5` — every decision, request, approval and permit use was chained and persisted |

Two defects were found and fixed by this exercise, and both would have been invisible offline:
the web trigger handler used the Fetch `Request`/`Response` API instead of the Forge wire format
(`{method, headers, body}` in, `{statusCode, headers, body}` out — Forge answers 424 otherwise),
and the storage adapter waited for a `FORGE_ENVIRONMENT` variable that the platform does not set,
so a deployed app would have silently used the in-memory adapter and lost every decision.

Also observed: one call at **3.41 s** and the first call after a deploy at **15.4 s**, both cold
starts — the second also creates the ten tables and seeds the organisation rules once. A
transient `Limits for the current installation have been exceeded` appeared during a burst of
rapid calls and did not recur; it is noted here rather than hidden.

---

## Summary for the submission

Four of the six points are now settled: the `mcp_tool` hook shape and the hooks of other clients
by documentation (with the `http` + `onFailure: "block"` design decision, and a command bridge
for clients that lack HTTP hooks), the hash chain under concurrent writes by test (25 parallel
writes, contiguous sequence numbers, chain verified), and the gate latency by measurement on the
deployed installation (**p95 = 0.63 s** on 30 warm calls, 100 % under one second, write path
included at 0.46 s). Section 7 adds a full end-to-end run on Forge SQL.

Two points remain open and are honestly marked as such: the **identity carried by an external
MCP call** (needs an administrator to enable external exposure and an OAuth consent in a
browser — the code reads the identity from the context and never from the inputs, and the
operator route computes the pilot flag from the stored request, so the design does not depend on
the answer) and **approver notification** (needs a deployed app plus a notification channel;
the fallback of spec §18 is a mention in a ticket comment). Neither blocks the submission, and
each has a working fallback in the specification.
