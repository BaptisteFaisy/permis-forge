# Permis d'agir — Agent Permits

[![CI](https://github.com/BaptisteFaisy/permis-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/BaptisteFaisy/permis-forge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Jira becomes the registry of what a coding agent is allowed to do.**

Permis d'agir is an Atlassian **Forge** app for Jira that turns "what may this agent do?" into a
policy you can read, approve on the ticket, and audit afterwards:

- every sensitive action is **classified** (fifteen action classes) and **resolved against a
  project policy** (six autonomy levels, N0 → N5);
- an action that requires a human **creates an approval request on the issue**, with a single card
  showing what / why / how / risk / precedents / who;
- an approval produces a **signed, scoped, time-boxed permit** (`PA-2026-000417`) that the agent
  cites in its commit message or PR description;
- every decision, request, approval, refusal, permit use and declared action lands in a
  **hash-chained ledger** that cannot be rewritten;
- a **kill switch** suspends every autonomy level above reading in one click;
- **trust capital** lets a well-behaved agent profile earn a bit more autonomy — and never opens a
  forbidden class.

The agent side is served by a **Rovo MCP module** (eight tools) and, more importantly, by a
**Claude Code `PreToolUse` hook**: the agent does not decide whether it may act — the app does.

> Codegeist 2026 — *Apps for Software Teams* (MCP bonus).
> The product specification is written in French and is kept verbatim in [`docs/SPEC.md`](docs/SPEC.md).
> Further reading: [architecture](docs/ARCHITECTURE.md) · [hook setup](docs/HOOK-SETUP.md) ·
> [judges guide](docs/JUDGES.md) · [roadmap](docs/ROADMAP.md).

---

## The problem

Coding agents no longer only write functions. They run migrations, change the CI configuration,
bump dependencies, delete files, and sometimes disable the very test that blocks them.

Today, what an agent is allowed to do is decided in **three disconnected places**:

1. in the head of the developer driving the agent;
2. in an instructions file the agent follows — or does not;
3. in the local settings of the tool, which differ on every workstation.

None of them is shared, verifiable or traceable. When something goes wrong, nobody can answer
three simple questions: **who authorised this action, on what basis, and was the agent allowed to
do it alone?**

The organisation already has a place where decisions are made, approvals are given and the trail
is kept: **Jira**. What is missing is the link between that registry and the agent.

---

## How it works

### Six autonomy levels

A policy rule resolves an action to exactly one level. The **most restrictive applicable rule
wins**; without a matching rule, the default level of the class applies; organisation rules are a
floor that a project may harden but never soften.

| Level | Name | What happens |
|---|---|---|
| **N5** | Autonomous | The agent acts. Nothing is requested. |
| **N4** | Autonomous, declared | The agent acts; the action is logged and the zone owner is notified. |
| **N3** | Pilot confirmation | The developer driving the agent confirms on their own machine. |
| **N2** | Third-party approval | An authorised person other than the pilot approves on the ticket. |
| **N1** | Double approval | Two authorised people with different roles approve. |
| **N0** | Forbidden | Refused, with a reason. No exception the agent can grant itself. |

### Fifteen action classes

The catalogue is extensible per project. **A-15 is locked**: an agent can never widen its own
rights.

| Code | Class | Examples | Default level |
|---|---|---|---|
| A-01 | Read | Read the repository, the ticket, the docs | N5 |
| A-02 | Edit application code | Source files outside sensitive zones | N5 |
| A-03 | Edit tests | Change an assertion | N4 |
| A-04 | Disable or delete a test | `skip`, deletion of a test file | N2 |
| A-05 | Add a dependency | New package | N3 |
| A-06 | Major dependency update | Major version bump | N2 |
| A-07 | Edit CI or deployment | Pipeline files, images, delivery scripts | N2 |
| A-08 | Schema migration | Add or modify a table | N2 |
| A-09 | Delete or alter data | `DELETE`, bulk `UPDATE`, purge | N1 |
| A-10 | Touch secrets or access | Secret variables, roles, keys | N0 |
| A-11 | Edit infrastructure | Declarative infrastructure files | N2 |
| A-12 | Destructive git operation | History rewrite on a shared branch, branch deletion | N0 |
| A-13 | Act on production | Command run against a production environment | N1 |
| A-14 | Send outbound | Call to a third-party service, message sending | N3 |
| A-15 | Edit the policy itself | Agent instructions files, hook settings | N0 |

The app does **not** take the agent's word for it: deterministic patterns reclassify the action
from its target (a file under `migrations/` is an A-08 whatever class was announced) and from its
command text (`DROP`, `DELETE FROM`, a forced push); a free-form description is proposed by a language
model, and when two classes are plausible the more restrictive one is kept. Every answer states the
rule that was applied and the reason for any reclassification.

### From refusal to permit

1. **The request.** At N2 or N1 the agent calls `request-approval` with the class, the target, the
   justification and its plan. The request appears on the ticket, in the app panel, and names the
   authorised people.
2. **The card.** The approver sees one card: *what* (class and exact target — file, table,
   command), *why* (agent justification, ticket, acceptance criterion served), *how* (plan and
   rollback plan), *risk* (level, zone, what depends on the target), *precedents* (similar
   requests, their outcome, what happened next), *who* (human pilot and agent profile with its
   trust capital). Three buttons: **Grant**, **Refuse** (reason required), **Ask for detail**.
3. **Who may approve.** A project role per action class (migrations go to the data owner, CI to
   the platform team). **Never the pilot for their own request.** At N1, two people with
   different roles.
4. **The permit.** An approval produces a permit:

   | Field | Content |
   |---|---|
   | Identifier | `PA-2026-000417` |
   | Scope | Class, exact target, ticket |
   | Duration | 2 hours by default, adjustable by the approver |
   | Usages | 1 by default |
   | Holder | Agent profile and pilot |
   | Signature | Fingerprint computed with an installation secret |

   The permit is **revocable at any time**. The agent cites it in the commit message or the PR
   description (`Permis-Agent: PA-2026-000417`), which makes it verifiable later by a merge gate
   or a CI step.
5. **Plan first.** For a complex ticket the agent submits its whole plan with `submit-plan`. The
   app splits it into actions, gives a decision for each, and groups everything that needs an
   approval into a single request. An approved plan is a batch of permits. Any action outside the
   plan is reported as a deviation.

### The tamper-evident ledger

- One entry per decision, request, approval, refusal, permit, permit use, declared action, trust
  variation and kill switch.
- **Chaining**: every entry contains the fingerprint of the previous one. Any deletion or
  modification breaks the chain, and the verification screen shows it.
- Every entry carries: date, project, ticket, agent profile, pilot, class, target, rule applied,
  decision, permit.
- Filters by ticket, agent, class, zone and period; export to CSV and to a Confluence page.
- **No entry is editable**: a correction is a new entry that points back to the old one.

### The kill switch

One button per project, one for the whole organisation. Immediate effects:

- every class above reading answers **N0**;
- in-flight permits are **suspended, not destroyed**;
- pending requests are **frozen**;
- a banner appears on the affected tickets.

Activation and release both require a reason and are logged. Release may require a person other
than the one who triggered the stop, if the project configures it that way.

### Trust capital

Each agent profile has a trust score from 0 to 100, initialised at 50.

| Event | Effect |
|---|---|
| Action declared, report confirmed by a human | +1 |
| Request granted and executed in line with the permit | +2 |
| Report corrected by the reviewer | −2 |
| Sensitive action discovered without a declaration | −10 |
| Action outside the approved plan | −10 |
| Incident attached to an agent action | −25 |
| Attempt on a forbidden class | −5 |

Effects on the policy, if the project enables them: above 80, classes set to N3 move to N4; below
30, classes set to N4 and N5 (reading excluded) move to N3; at 0, the profile is suspended until
human review. Guardrails: trust capital **never** opens a class set to N0, N1 or N2, and it erodes
slowly back towards 50 when there is no activity. Every variation is explained in the ledger.

---

## The nine MCP tools

Exposed by the `rovo:mcp` module (`tools:` in `manifest.yml`).

| Tool | Verb | Inputs | Returns |
|---|---|---|---|
| `check-permission` | GET | `issueKey`, `actionClass`, `target`, `description` | Decision, level, rule applied, what to do next |
| `get-policy` | GET | `projectKey` | Summarised policy, to plan ahead |
| `request-approval` | CREATE | `issueKey`, `actionClass`, `target`, `justification`, `plan` | Request number, approvers notified |
| `get-request-status` | GET | `requestId` | Pending, granted with permit, or refused with a reason |
| `list-permits` | GET | `issueKey` | Valid permits and remaining usages |
| `declare-action` | CREATE | `issueKey`, `actionClass`, `target`, `outcome`, `permitId` | Ledger entry |
| `submit-plan` | CREATE | `issueKey`, `plan` | Decision per action, grouped request |
| `create-hook-token` | CREATE | `label` | The caller's personal gate token, shown once (only its hash is stored) |
| `get-agent-standing` | GET | `agentProfile` | Trust capital and current effects |

An agent waiting for an approval does **not** poll `get-request-status`: its instructions tell it
to stop, announce the request number, and resume when the pilot comes back to it.

---

## The four enforcement points

A tool that is only consulted keeps nobody. An agent that does not ask still acts. The product
says so and offers four points of enforcement, from the simplest to the strictest.

| Point | Mechanism | Strength |
|---|---|---|
| 1. MCP tool | The agent calls `check-permission` because its instructions tell it to | Cooperation |
| 2. Client hook | A hook run before each tool call queries the app and blocks the call without a permit | Blocking on the workstation |
| 3. Merge gate or CI step | A PR touching a sensitive zone without a valid permit is refused | Blocking before the main branch |
| 4. Detection after the fact | Real changes are compared with the declared actions; the gap is reported | Dissuasion and trace |

Point 2 is the main one: see [`docs/HOOK-SETUP.md`](docs/HOOK-SETUP.md).

---

## Repository layout

| Path | Contents | State (11 Nov 2026) |
|---|---|---|
| `src/core/` | Pure TypeScript decision logic — no Atlassian SDK import. Action-class catalogue, path matching, approvals, kill switch, trust capital, plan-first evaluation, hook mapping. | Present |
| `src/storage/` | Persistence adapters over Forge SQL (`@forge/sql`), plus an in-memory adapter used by the tests. | Schema and in-memory adapter present |
| `src/ui/` | Forge resolvers for the issue panel, project settings page, project page, global page, personal settings page and the simulation console. | In progress |
| `src/mcp/` | Handlers for the nine MCP tools of the `rovo:mcp` module. | Present (6 read tools, 3 write tools) |
| `src/hooks/` | The `webtrigger` gate handler used by the client hook and by CI verification. | Present |
| `src/triggers.ts` | Issue-update trigger and nightly maintenance (permit expiry, trust erosion, chain verification). | Present |
| `src/index.ts` | Entry point: wires repositories, services and module handlers together. | Present |
| `manifest.yml` | Forge manifest: `rovo:mcp`, `rovo:agent`, `rovo:skill`, `action`, `webtrigger` (`gate`), Jira modules, `sql`, `llm`, triggers. | Present |
| `test/` | Jest test suites for the core logic. | Present |
| `docs/` | This documentation set; [`docs/SPEC.md`](docs/SPEC.md) is the verbatim specification. | Present |

---

## Quickstart

### Prerequisites

- **Node.js 20+** and **npm** (the repository ships `package-lock.json`);
- an **Atlassian Cloud** site and a **Forge developer account** to install the app;
- the **Atlassian Forge CLI** (`forge`) for `forge install` / `forge deploy`;
- optionally **Claude Code** on a workstation, to exercise the hook (point 2 of enforcement).

### Install, test, lint

```bash
npm install
npm test        # jest
npm run lint    # tsc --noEmit
```

### Deploy on a Jira site

The standard Forge CLI procedure:

```bash
forge install   # select your Atlassian Cloud site, confirm the installation
forge deploy    # deploy the current code to the installation
```

`forge install` links the app to your site and `forge deploy` uploads the current bundle. Use
`forge deploy --verbose` if you need the module validation output.

### Generate and install the hook file

1. Open the **project settings page** of the app in Jira and download the generated hooks file for
   the project policy.
2. Merge it into the repository's `.claude/settings.json` (keep the other Claude Code settings you
   already have).
3. Export a personal token for the hook, as described in [`docs/HOOK-SETUP.md`](docs/HOOK-SETUP.md):

   ```bash
   export PERMIS_AGENT_TOKEN=<the token shown once in the personal settings page>
   ```

The hook is closed by default: if the app does not answer, the sensitive action does not happen.

### Connect an MCP client

The `rovo:mcp` module is exposed to external MCP clients at:

```
https://mcp.atlassian.com/forge/<appId>
```

An administrator must first activate the external exposure for the installation; the client then
authenticates with OAuth 2.1. From an external client, a tool runs with the rights of the user
who authorised the client.

---

## Try it offline (no Jira site needed)

The eleven acceptance scenarios of the specification run against the real
decision engine and the in-memory storage — no Atlassian account, no network:

```bash
npm run install:ci           # npm ci --omit=optional (113 MB, the UI Kit is not needed here)
node scripts/demo.mjs        # prints the transcript, then "11/11 scenarios passed"
npx jest                     # 30 suites, unit tests
node scripts/check-manifest.mjs
```

Against a **deployed** installation, the same spirit runs online:

```bash
bash scripts/regression-live.sh   # 18 checks through the real web triggers and Forge SQL
```

It reads the gate URL, the operator URL and the installation secret from
`~/.atlassian/` (never from the repository, never printed), and exits non-zero
on the first failure. See `docs/DEPLOYMENT.md`.

Ready-to-use examples ship with the repository:

| File | Purpose |
|---|---|
| `examples/hooks/claude-code-settings.json` | the generated Claude Code hooks file (`onFailure: block`) |
| `examples/hooks/cursor-hooks.json` | the same gate for Cursor, through the command bridge |
| `examples/hooks/gate-bridge.sh` | POSIX bridge for clients without HTTP hooks; fails closed |
| `examples/policy/seed-payments.json` | a sample policy for a Payments project (zones, rules, org floor) |
| `examples/mcp/client-config.json` | external MCP client configuration (OAuth 2.1) |

## Development

- **Tests**: Jest with `ts-jest` (`jest.config.js`), suites in `test/` (`npm test`, `npm run
  test:watch`).
- **Type check / lint**: `npm run lint` runs `tsc --noEmit` over `src/` and `test/`.
- **CI**: GitHub Actions (`.github/workflows/ci.yml`) on **self-hosted runners**, with a **5-minute
  budget per job** (`timeout-minutes: 5`), `concurrency` to cancel superseded runs and
  `fetch-depth: 1` to keep the checkout shallow. No job timeout is ever extended.
- **Two install modes.** The UI Kit front-end (`react`, `@forge/react`, `@forge/bridge`) weighs
  about **1.6 GB** installed, while the screens are plain `.jsx` that CI neither type-checks nor
  runs — all decision logic lives in `src/core` and `src/ui`, typed and tested. Those packages are
  therefore `optionalDependencies`:
  - CI and local tests: `npm run install:ci` (`npm ci --omit=optional`) → **113 MB, ~10 s**;
  - deploying: `npm run install:all` (`npm install`) first, because `forge deploy` bundles the
    front-end and needs the UI Kit packages present.
- **Conventions**: every source file stays under 500 lines and every function under 50 lines;
  shared helpers are extracted instead of duplicated.
- The core logic in `src/core/` is deliberately free of `@forge/api` imports, so it can be unit
  tested without a Forge runtime.

---

## Status

Requirements of the specification (§13), with their priority — **M** = required for the
submission, **S** = desirable, **C** = after the hackathon — and the state of the code as of
11 November 2026. "Implemented" always means covered by offline unit tests; the eleven
acceptance scenarios of §21 run end to end with `node scripts/demo.mjs`.

| # | Requirement | Priority | Status |
|---|---|---|---|
| PA-01 | Decide an action from class, zone, conditions and policy in under 2 s | M | **Implemented** — `src/core/policy.ts` (most restrictive wins, org floor, class default), `src/core/zones.ts`, `src/core/pipeline.ts`. The 2 s target itself is to be measured on a deployed installation |
| PA-02 | Reclassify an action from its target or command, and say so | M | **Implemented** — `src/core/classify.ts`: deterministic target and command patterns, composed commands split and judged by their strictest part, optional model-proposed class, doubt resolved to the strictest |
| PA-03 | Set the policy per project in a classes × zones grid | M | **Implemented** — rules and zones stored per project, `projectSettings` screen with `saveRule` / `saveZone` / `deleteRule` / `deleteZone`; `examples/policy/seed-payments.json` is a ready-made grid |
| PA-04 | Create an approval request visible on the ticket, with the §8.1 card | M | **Implemented** — `request-approval` creates the request, `issuePanel` returns the card fields (what / why / how / risk / precedents / who) and the three actions |
| PA-05 | Prevent the pilot from approving their own request | M | **Implemented** — `src/core/approvals.ts`, and the mutation recomputes the pilot flag from the request itself |
| PA-06 | Issue, decrement, expire and revoke signed permits | M | **Implemented** — `src/core/permits.ts` (HMAC-SHA256 over the granted scope), `src/services/approvals-service.ts`, nightly expiry in `src/triggers.ts` |
| PA-07 | Chained, browsable and exportable ledger | M | **Implemented** — `src/core/ledger.ts` (SHA-256 chain over canonical JSON), `src/storage/queue.ts` (single-consumer writer), `src/ui/audit.ts` (verification, CSV, Confluence export), filters and pagination on `projectPage` |
| PA-08 | MCP tools of §14 | M | **Implemented** — the eight tools in `src/mcp/`, wired in `src/index.ts` and declared in `manifest.yml`; the manifest/code guard runs in CI |
| PA-09 | Hook entry point with a personal token, plus the generated hooks file | M | **Implemented** — `src/hooks/gate.ts` (token hashed, unknown token refused), `personalSettings` issues a token shown once, `buildHookFile` generates the file, examples for Claude Code and Cursor |
| PA-10 | Kill switch per project | M | **Implemented** — `src/core/killswitch.ts` plus the organisation switch on `globalPage`; permits suspended, requests frozen, reason and different-person rules enforced |
| PA-11 | Simulation console: enter an action, see the decision and the rule | M | **Implemented** — `simulationConsole`, side-effect free, and proven to answer like the MCP tool (scenario 10) |
| PA-12 | Rovo agent to query the policy and the ledger | M | Partial — `rovo:agent` and `rovo:skill` are declared with their prompt and starters; validating them needs a deployed app |
| PA-13 | Observation mode and the 30-day report | S | **Implemented** — an `observe` rule decides and journals without blocking; `summarize30DayObservation` feeds the project page and the promotion suggestions |
| PA-14 | Trust capital and its effects | S | **Implemented** — `src/core/trust.ts` (deltas, promotion above 80, demotion below 30, suspension at 0, erosion towards 50), injected into the resolution |
| PA-15 | Double approval (N1) with distinct roles | S | **Implemented** — `src/core/approvals.ts` requires two grants with different roles at N1 |
| PA-16 | Plan first: splitting, batch of permits, deviations | S | **Implemented** — `src/core/plan.ts` plus `submit-plan`, which groups the approvals of a whole plan into one request |
| PA-17 | Precedents shown on the request card | S | **Implemented** — `src/services/precedents.ts`: similar requests, outcome, approvers, permit, decision delay and what happened next |
| PA-18 | Organisation policy floor | S | **Implemented** — a project may harden but never soften: the org rule wins when it is stricter (`source: 'org-floor'`) |
| PA-19 | Verify a permit from a CI step | S | **Implemented** — the gate answers a `{ permitId }` POST with signature, expiry, revocation and remaining uses |
| PA-20 | Detect sensitive actions that were not declared | C | **Implemented** — `src/services/drift.ts`: observed changes classified by the real classifier, compared with declarations and the approved plan, penalised once and journaled |
| PA-21 | Propose a policy from the history | C | **Implemented** — `src/services/policy-suggestions.ts`: evidence-backed proposals, observe before hardening, never a locked class, never above the org floor |
| PA-22 | Delegation: a sub-agent receives a narrower permit than its parent | C | **Implemented** — `src/services/delegation.ts`: any widening refused with an explicit code, and the whole chain verifiable |

**Deployed and validated live.** The app runs on Jira: `ari:cloud:ecosystem::app/a700e3ab-b722-4ae3-8a8a-b9f1a1b4c341`,
installed on `one-atlas-cndz.atlassian.net` (development, version 2.2.0). A full end-to-end run
through the real web trigger and Forge SQL is transcribed in `docs/VALIDATIONS.md` §7: a
migration is refused and creates request `RQ-2026-000001`, a third party approves it, permit
`PA-2026-000001` is issued, the gate lets the action through once, refuses the second attempt,
the permit signature survives the SQL round trip, and the chained ledger keeps five entries with
an intact chain. Gate latency measured on the installation: **p95 = 0.63 s** over 30 warm calls,
100 % under one second, write path included (§3).

**Approvers are notified on the ticket.** When the gate refuses an action and creates a request,
the app posts the approval card of spec §8.1 (what / why / how / risk / who / approvers) as a Jira
comment, verified live on ticket ENGS-32 (`src/services/notify.ts`). A delivery failure never
changes the decision: the refusal stands, the failure is logged.

**Not done yet.** The runtime half of one §18 validation — the identity carried by an *external*
MCP call (needs an administrator to enable external exposure plus an OAuth consent in a browser) —
the demo video, and the Devpost and Marketplace submissions. The
Bitbucket merge gate (enforcement point 3 on pull requests) needs a companion app: an app
installed on Jira cannot call the Bitbucket API (spec §18). What is delivered instead is the
permit verification endpoint, which any CI step can call. The Jira screens return native-render
data rendered by a UI Kit 2 front-end (`src/frontend/main-ui-kit/`, one entry per screen), and
`jira:personalSettingsPage` is declared — the platform requires a static UI bundle for it, which
the bundle now provides. Token self-service is therefore available both from that screen and from
the `create-hook-token` tool.

Everything also runs offline: 358 unit tests, no network, no database, no Forge runtime.

---

## License

MIT — see [`LICENSE`](LICENSE). Copyright (c) 2026 Baptiste Faisy.
