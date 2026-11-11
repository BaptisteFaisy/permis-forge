# Devpost submission — Permis d'agir (Agent Permits)

> Ready-to-paste content for the Codegeist 2026 submission form
> (https://codegeist2026.devpost.com/). Every section below maps to a Devpost field.
> The specification of record is [`SPEC.md`](SPEC.md) (French); this submission is in English,
> as required. Status statements reflect the repository as of **11 November 2026**.

---

## Project title

**Permis d'agir — Agent Permits for Jira**

## Tagline (one sentence)

Turn Jira into the permission registry for coding agents: every sensitive action is allowed, sent to human approval, or refused by project policy — and every decision lands in a tamper-evident ledger.

## Short summary (~100 words)

Coding agents now run migrations, edit CI, and sometimes delete the test that blocks them. What an agent may do is decided in three disconnected places: the developer's head, an instructions file, and per-machine tool settings. None is shared, verifiable, or traceable. Permis d'agir is a Forge app for Jira that replaces all three with one policy engine: fifteen action classes resolved against six autonomy levels (N0–N5), approval requests that live on the ticket, signed time-boxed permits (HMAC-SHA256), a SHA-256 hash-chained ledger, a kill switch, and a Claude Code `PreToolUse` hook that blocks sensitive calls without a valid permit — closed by default.

---

## Long description

Paste-ready narrative for the Devpost "What it does" / "Inspiration" fields.

### The problem

Coding agents no longer only write functions. They launch migrations, change CI configuration, bump dependencies, delete files — and sometimes disable the very test that fails. Today, what an agent is allowed to do is decided in three places that never talk to each other: in the head of the developer driving it, in an instructions file it follows (or not), and in local tool settings that differ on every workstation. None of them is shared, verifiable, or traceable. When an incident happens, nobody can answer three simple questions: **who authorised this action, on what basis, and was the agent allowed to do it alone?**

Organisations already have a place where decisions are made, approvals are given, and the trail is kept: **Jira**. What is missing is the link between that registry and the agent.

### The idea

Make Jira the registry of what a coding agent has the right to do. Each sensitive action is authorised, sent for approval, or refused according to a per-project policy; approval is given **on the ticket**; a **signed, scoped, time-boxed permit** comes out of it; and everything is recorded in a **ledger that cannot be rewritten**. It is a "points-based licence" for agents: trust capital rises with confirmed work, falls with incidents, and never opens a forbidden class.

### How it works

- **Classify.** Fifteen action classes (A-01 read → A-15 edit the policy itself), each with a default level. The app never takes the agent's word: deterministic patterns reclassify from the target (a file under `migrations/` is an A-08 whatever was announced) and from the command text (`DROP`, `DELETE FROM`, a forced push); a free-form description is classified by the Forge `llm` module, and on doubt the more restrictive class wins. Every answer cites the rule applied and any reclassification.
- **Resolve.** Six autonomy levels, N0 (forbidden) to N5 (autonomous). Organisation rules are a floor a project may harden but never soften; among applicable rules the most restrictive wins; the kill switch pushes everything above reading to N0.
- **Approve.** At N2/N1 the agent calls `request-approval`; a card appears on the ticket showing what / why / how / risk / precedents / who. The pilot can never approve their own request; at N1 two people with different roles must approve.
- **Permit.** An approval produces a permit (`PA-2026-000417`): exact scope, 2-hour default duration, 1 usage, holder, HMAC-SHA256 signature over the canonical JSON of the signed fields, keyed with the installation secret. Revocable at any time; the agent cites it in the commit message or PR description.
- **Log.** Every decision, request, approval, refusal, permit, permit use, declared action, trust variation and kill-switch event is one entry in a hash-chained ledger: `hash = sha256(canonical_json(entry))`, each entry carrying the previous entry's hash. Any rewrite breaks the chain and the verification screen shows the first break.

### The four enforcement points

A tool that is only consulted keeps nobody — an agent that does not ask still acts. The product says so openly and ships four enforcement points, from softest to strictest:

| # | Point | Mechanism | Strength |
|---|---|---|---|
| 1 | MCP tool | The agent calls `check-permission` because its instructions (the `rovo:skill`) tell it to | Cooperation |
| 2 | **Client hook (main one)** | A Claude Code `PreToolUse` hook queries the app's web trigger before each sensitive tool call and blocks it without a permit | Blocking on the workstation |
| 3 | Merge gate / CI step | A PR touching a sensitive zone without a valid permit is refused | Blocking before the main branch |
| 4 | Detection after the fact | Real changes are compared with declared actions; the gap is reported | Dissuasion and trace |

The hook is **closed by default**: `onFailure: "block"` means that if the app does not answer, the sensitive action does not happen. The hooks file itself is protected by class A-15 (N0) — an agent can never widen its own rights.

### What is technically hard

- **Not trusting the caller.** Inputs of a Forge action can be invented by the model; identity must come from the call context (Atlassian account) or from the hook's personal token — never from the inputs.
- **A tamper-evident ledger on Forge SQL**: canonical JSON serialisation, genesis entry, nightly chain verification, and concurrency safety with no foreign keys and a 5 s SELECT budget.
- **Fail-closed latency**: the hook runs on every filtered tool call, so the gate must answer in under 1 s (p95) within the web trigger's 55 s platform ceiling.
- **A pure decision core**: all policy logic is platform-free TypeScript, so the exact same engine answers the MCP tool, the hook, the simulation console and CI — one decision, everywhere.

### What is new

Permits — not prompts — as the unit of authorisation: signed, scoped, time-boxed, usage-counted, revocable, and citable in a commit. Policy where the organisation already governs (Jira), enforcement where the agent actually acts (the client hook), and proof in a ledger an auditor can replay. Trust capital adjusts autonomy at the margins but can never open N0/N1/N2 classes.

---

## Category and bonuses

**Category: Apps for Software Teams.** The app governs the collaboration between human teams and their coding agents inside Jira: approvals on tickets, roles per action class, separation of powers, and an audit trail for security and management.

| Bonus | Claimed | Justification (manifest module) |
|---|---|---|
| **MCP (principal)** | Yes | The `rovo:mcp` module `permis-mcp` in `manifest.yml` exposes the eight `action` entries as MCP tools, connectable from any third-party MCP client at `https://mcp.atlassian.com/forge/<appId>` over OAuth 2.1, after an administrator enables external exposure for the installation. The hook and the Rovo agent consume the same tools. |
| **Agents Rovo** | Yes | The `rovo:agent` module `permis-agent` answers humans in Rovo Chat ("What did the agents do this week?", "Why was request RQ-2026-000417 refused?") using the eight tools, guided by the `rovo:skill` module `permis-skill` and its prompt's safety rules (never unlock A-10/A-12/A-15, always cite the rule). |
| **Marketplace** | Yes | A single Forge app installed on Jira, no external service to run; free during the hackathon. The draft listing — including the permissions justification, the privacy statement and the honest egress declaration — is in [`MARKETPLACE.md`](MARKETPLACE.md). |
| **Teamwork Graph (optional)** | Not claimed for v1 | No Teamwork Graph module is declared in `manifest.yml` at submission time. It is kept as an optional future integration (surfacing permits and agent profiles as graph entities); we do not claim the bonus for something that is not built. |

## The eight MCP tools

| Tool | What it is for |
|---|---|
| `check-permission` | Get the decision (level, rule applied, reclassification, next step) before acting. |
| `get-policy` | Read the project's policy summary to plan ahead. |
| `request-approval` | Create an approval request on the ticket and get its number plus the approvers notified. |
| `get-request-status` | Poll-free status of a request: pending, granted with permit, or refused with reason. |
| `list-permits` | Valid permits on a ticket with remaining usages and expiry. |
| `declare-action` | Declare an executed action and write its ledger entry. |
| `submit-plan` | Submit a whole plan; get a decision per action and one grouped approval request. |
| `get-agent-standing` | Trust capital of an agent profile and its current effects on autonomy. |

---

## How we built it

- **One Atlassian Forge app installed on Jira** — TypeScript, strict mode (`tsconfig.json`), no external backend.
- **`rovo:mcp` + `action`**: the eight tools are declared once as `action` entries (strings/numbers/booleans only, per platform limits) and reused by the MCP server, the `rovo:skill`, the `rovo:agent`, and the UI.
- **`webtrigger` (`gate`, urlFormat v2, dynamic response)**: the HTTP entry point called by the Claude Code `PreToolUse` hook (`type: "http"`, `onFailure: "block"`, `Authorization: Bearer $PERMIS_AGENT_TOKEN`) and by CI verification. Web triggers have no platform authentication, so the personal token — stored only as a hash — identifies the pilot.
- **Forge SQL (mysql engine), 10 tables**: `policy_rule`, `zone`, `agent_profile`, `request`, `approval`, `permit`, `ledger`, `trust_event`, `kill_switch`, `hook_token`. No foreign keys exist on Forge SQL, so relations are columns and integrity is enforced by the application.
- **Hash-chained ledger, SHA-256**: `hash = sha256(canonical_json(entry))`, genesis = 64 zeroes, verified nightly by the `scheduledTrigger` (`src/core/ledger.ts`).
- **Signed permits, HMAC-SHA256**: signature over the canonical JSON of identifier, scope, expiry, usages and holder, keyed with the installation secret (`src/core/permits.ts`).
- **Pure decision engine**: `src/core/` imports no Atlassian SDK — classification, policy resolution with organisation floor, approvals (no self-approval, N1 double approval), permits, trust capital, plan-first, kill switch, hook mapping — covered by **221 offline unit tests in 18 Jest suites** (`npm test`), with the in-memory storage adapter standing in for Forge SQL.
- **`llm` module** for classifying free-form descriptions only; deterministic patterns always come first.

## What's next

Honest status against the specification's priorities (§13): **S = desirable for the submission, C = after the hackathon.**

| # | Requirement | Priority | Where we are (11 Nov 2026) |
|---|---|---|---|
| PA-13 | Observation mode + 30-day report | S | Observation mode implemented in the decision core and the gate (decide + log, never block); the 30-day "what would have been blocked" report is pending. |
| PA-14 | Trust capital and its effects | S | Implemented (`src/core/trust.ts`): deltas, promotion above 80, demotion below 30, suspension at 0, erosion towards 50 — unit-tested. |
| PA-15 | Double approval (N1), distinct roles | S | Implemented (`src/core/approvals.ts`) — unit-tested. |
| PA-16 | Plan first: split, permit batch, deviations | S | Implemented (`src/core/plan.ts`) — unit-tested. |
| PA-17 | Precedents on the request card | S | Pending: not in `src/` yet; the card model is ready to receive it. |
| PA-18 | Organisation policy floor | S | Floor resolution implemented and tested (`src/core/policy.ts`, `org-floor`); org rules are exposed on the global page resolver (`src/ui/resolvers.ts`). |
| PA-19 | Permit verification from a CI step | S | The `gate` web trigger already answers permit checks with the personal token; a documented CI example (GitHub Actions step calling the gate) is pending. |
| PA-20 | Detect undeclared sensitive actions | C | Planned after the hackathon. |
| PA-21 | Policy proposed from history | C | Planned after the hackathon. |
| PA-22 | Delegation: narrower permit for sub-agents | C | Planned after the hackathon. |

Before submission (22 December): deploy to the demo site, run the eleven acceptance scenarios of §21, complete the six prototype validations tracked in [`VALIDATIONS.md`](VALIDATIONS.md), record the video, and submit the Marketplace listing.

---

## Links

- Repository: https://github.com/BaptisteFaisy/permis-forge
- README (overview, quickstart, status): [`../README.md`](../README.md)
- Judges guide (three ways to test + 11 acceptance scenarios): [`JUDGES.md`](JUDGES.md)
- Hook setup (enforcement on the workstation): [`HOOK-SETUP.md`](HOOK-SETUP.md)
- Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Roadmap: [`ROADMAP.md`](ROADMAP.md) · Specification (French, of record): [`SPEC.md`](SPEC.md)
- Hackathon: https://codegeist2026.devpost.com/ · Rules: https://codegeist2026.devpost.com/rules

## Demo video

**To be recorded.** The shot-by-shot script, with timings, narration and click lists, is in [`DEMO-SCRIPT.md`](DEMO-SCRIPT.md); the video link will be added here and on Devpost before the 22 December 2026 deadline.

## Team

- **Baptiste Faisy** — sole developer: specification, Forge app, decision engine, tests, documentation.

## License

MIT — see [`../LICENSE`](../LICENSE). Copyright (c) 2026 Baptiste Faisy.
