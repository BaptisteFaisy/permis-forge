# Judges guide — how to test Permis d'agir

Four ways to try the app, from the lightest to the strictest. All of them exercise the same
policy engine; they differ only in who asks.

> The product specification (in French) is kept verbatim in [`SPEC.md`](SPEC.md). The four
> testing paths below are §23 and the eleven acceptance scenarios are §21.

---

## 0. Where the app is running

The app is deployed, not merely described. It is installed on a real Jira site
(`one-atlas-cndz.atlassian.net`, development environment) and everything below can be replayed
against it.

| What | Where |
|---|---|
| Sample project | `PAY`, with ticket `PAY-42` |
| Replay the live checks | `bash scripts/regression-live.sh` — 18 checks against the deployed installation, through the real web triggers and Forge SQL |
| Replay the scenarios offline | `node scripts/demo.mjs` — 11/11, no network needed |
| Read the evidence | [`VALIDATIONS.md`](VALIDATIONS.md) — what was measured, on which date, and with which limits |

Three gaps are stated rather than hidden: the identity carried by an **external** MCP call
needs an administrator to enable external exposure (Way B below), the delivery delay of the
approval notification to a second human account is not measured, and the six screens are
verified through their resolvers against Forge SQL rather than by clicking them in a browser.

---

## 1. Four ways to test

### Way A — Inside Jira only (no installation)

Everything a human uses lives in Jira. Use the sample ticket of the project provided with the
submission.

1. **Simulation console** (`jira:projectPage`): enter an action class, a target and a ticket.
   You get the decision, the level, the rule that was applied and any reclassification.
2. **Policy grid** (`jira:projectSettingsPage`): the classes × zones grid, the approvers per
   class, the default durations, the mode of each rule (`enforce` / `observe`), and the download of
   the hooks file.
3. **Rovo agent**: ask in Rovo Chat, for example *"What did the agents do on the Payments project
   this week?"*, *"Why was request PA-2026-000417 refused?"*, *"Is an agent allowed to change the
   CI here?"*, *"Which rules are most often overridden?"*.
4. **Request and approval on the ticket**: open the issue panel of the sample ticket, look at a
   pending request card (what / why / how / risk / precedents / who), grant or refuse it.
5. **Ledger** (`jira:projectPage`): the full chain of decisions, requests, approvals, permits and
   declared actions, filterable by ticket, agent, class, zone and period, exportable to CSV and to
   a Confluence page.
6. **Kill switch**: press it, then run the same action through the console again.

### Way B — With an MCP client

1. An administrator **activates the external exposure** of the `rovo:mcp` module for the
   installation.
2. The client is pointed at `https://mcp.atlassian.com/forge/<appId>` and authenticates with
   **OAuth 2.1**.
3. Call `check-permission` with an `issueKey`, an `actionClass` and a `target`, then compare the
   answer with the simulation console for the same action (scenario 10).
4. Optionally call `get-policy`, `request-approval`, `get-request-status`, `list-permits`,
   `declare-action`, `submit-plan`, `get-agent-standing`, `detect-drift`, `delegate-permit`
   and `suggest-policy`. The last three are read-only: recording a deviation and applying a
   policy change are operator actions, never agent ones.

A tool runs with the rights of the user who authorised the client, and the identity is read from
the call context — never from the inputs.

### Way C — With the hook (enforcement on the workstation)

1. Download the hooks file generated from the project policy and put it in the
   `.claude/settings.json` of a test repository.
2. Export your personal token: `export PERMIS_AGENT_TOKEN=<token>`.
3. Ask Claude Code to do something sensitive (delete a test, run a `DELETE`, touch a file under
   `migrations/`) and watch the gate answer *allow*, *ask* or *deny* — with the reason and the
   request number when it denies.
4. You can also call the gate by hand with `curl`; see [`HOOK-SETUP.md`](HOOK-SETUP.md).

### Way D — With a CI step (enforcement point 3)

The hook is the main enforcement point, but a workstation can be switched off. The merge gate
is the late one: a pull request that touches a sensitive zone must carry a valid permit.

1. Copy [`examples/ci/verify-permit.yml`](../examples/ci/verify-permit.yml) into
   `.github/workflows/` of the repository you want to guard.
2. Set the `PERMIS_GATE_URL` repository secret to the gate URL of the installation.
3. Open a pull request whose description cites a permit, in the form
   `Permis-Agent: PA-2026-000417`.
4. The workflow asks the gate whether that permit is still valid, and **fails the check** when
   it is not — expired, revoked, suspended, or already spent. It holds read-only permissions
   and runs on the unprivileged pull request event.

The answer never exposes what the permit authorises: it says whether the permit is valid and
why, not the target it covers.

---

## 2. The eleven acceptance scenarios

Tick each box; the expected observable behaviour is stated for each one.

| # | Scenario | Expected observable behaviour |
|---|---|---|
| ☐ 1 | **Reclassification is not trusted** | An A-08 action on a file under `migrations/`, announced by the agent as A-02, is **reclassified as A-08** and the answer **says so**: the level shown is the one of A-08, the rule that was applied is quoted, and the reason for the reclassification is stated. |
| ☐ 2 | **Separation of powers** | An N2 action creates a request that **appears on the ticket**. The pilot **cannot** grant it; an **authorised approver** can. Both outcomes are written to the ledger. |
| ☐ 3 | **A permit is used up** | The permit granted for a target lets **that action through once**, then **refuses the second** attempt on the same target. `list-permits` shows the usage count going from 1 to 0. |
| ☐ 4 | **Expired or revoked permits** | An expired or revoked permit **lets nothing through**: the answer is a refusal, and the reason says whether it was expired or revoked. |
| ☐ 5 | **Forbidden classes stay forbidden** | An A-10 action ("touch secrets or access") is **refused whatever the trust capital** of the profile — including a profile at 100. |
| ☐ 6 | **Kill switch** | With the kill switch active, **every action above reading is refused, including with a valid permit**. Reading (A-01) still goes through. Pending requests are frozen, in-flight permits suspended, and a banner appears on the affected tickets. |
| ☐ 7 | **The hook blocks, then lets through** | The hook **refuses** a data-deletion command **without a permit** and **lets it through with one**. In both cases the answer names the level and, on refusal, the request number that was created. |
| ☐ 8 | **Closed by default** | With the app unreachable (or the endpoint misconfigured), the hook **blocks the action** rather than letting it through: `onFailure: "block"` keeps the door closed. |
| ☐ 9 | **Tamper evidence** | Modifying a ledger entry **in the database** makes a **chain break appear on the verification screen**, pointing at the first broken sequence number. No entry can be edited through the UI. |
| ☐ 10 | **One decision, everywhere** | The simulation console returns the **same decision as the MCP tool** for the same action (same level, same rule, same classification). |
| ☐ 11 | **Observation mode** | With a rule in observation mode, **nothing is blocked and everything is logged**: the console and the hook answer *allow*, the ledger records the decision the policy would have taken, and the 30-day report shows what would have been blocked. |

---

## 3. Where each scenario is observable

| Scenario | Console | Ticket panel | MCP tool | Hook | Ledger |
|---|---|---|---|---|---|
| 1 Reclassification | ✔ | ✔ | `check-permission` | — | ✔ |
| 2 Separation of powers | — | ✔ | `request-approval`, `get-request-status` | — | ✔ |
| 3 Permit used up | ✔ | ✔ | `list-permits`, `check-permission` | ✔ | ✔ |
| 4 Expired / revoked | ✔ | ✔ | `list-permits` | ✔ | ✔ |
| 5 Forbidden class | ✔ | — | `check-permission` | ✔ | ✔ |
| 6 Kill switch | ✔ | ✔ | `check-permission` | ✔ | ✔ |
| 7 Hook allow / deny | — | ✔ | — | ✔ | ✔ |
| 8 App not answering | — | — | — | ✔ | — |
| 9 Chain break | — | — | — | — | ✔ (verification screen) |
| 10 Same decision | ✔ | — | `check-permission` | — | ✔ |
| 11 Observation mode | ✔ | ✔ | `check-permission` | ✔ | ✔ |

---

## 4. A five-minute path

If you only have five minutes, start with `bash scripts/regression-live.sh` — it replays 18
checks against the deployed installation and tells you which line of the policy engine is
broken if one is. Then, by hand:

1. Run **scenario 1** in the simulation console: an A-08 announced as A-02 is reclassified and the
   answer explains it.
2. Open the **sample ticket**: the pending N2 request shows the one-card summary; try to grant it
   as the pilot, then as the approver (**scenario 2**).
3. Call the gate with `curl` twice, once with a valid permit and once without (**scenario 7**), then
   once more after the permit usage is consumed (**scenario 3**).
4. Press the **kill switch** and re-run the same action (**scenario 6**).
5. Open the **ledger** and look at the chain of the whole sequence, from the request to the permit
   use (**scenario 9** is a database-level test; the verification screen shows the chain state).

---

## 5. What to look for, beyond the checklist

- **No refusal without a reason.** Every refusal quotes the rule that was applied and states what
  to do next.
- **No file content.** The app receives tool names, paths and commands — never the content of the
  files; commands are masked before storage.
- **No self-approval.** The pilot of an agent profile cannot approve its own request.
- **No agent touching the policy.** The hooks file and the policy are class **A-15** (N0): an
  agent that tries to modify them is refused and the attempt is logged.
- **The trust capital never widens a forbidden class.** It moves N3 → N4 and N4/N5 → N3 only.
