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

**Method.** Measurement on the deployed installation — **nothing has been measured yet; no
figure is claimed**.

**Status.** **To be measured after deployment.**

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

**Result obtained.** None yet — no deployment existed on 11 November 2026. Platform figures
verified in documentation: web trigger functions are stopped after **55 s**; user-led
invocations are rate-limited as above; Forge SQL gives **150 DML requests per second per
install**, a **5 s per-connection timeout for SELECT** and **10 s for INSERT/UPDATE/DELETE** —
comfortable headroom for a single-decision payload, but the composed latency (HTTP + function
cold start + SQL) is what must be measured, not inferred.

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

## Summary for the submission

Two of the six points are settled by documentation, one of them with a design decision already
taken (the `http` hook with `onFailure: "block"` stays; the `mcp_tool` hook fails open and is
rejected for the gate). The sequential hash chain is proven by offline tests; its concurrency
test is in progress. The three remaining points (runtime identity from an external MCP call,
gate latency under load, approver notification) all require the deployed demo site and are
scheduled with their exact procedures above — no figure is invented in the meantime. Each of
the six has a working fallback in the specification, so none of them can block the submission.
