# Roadmap

> The product specification (in French) is kept verbatim in [`SPEC.md`](SPEC.md). The plan below
> is §24, the risks are §25 and the long-term vision is §26.

**Deadline for the submission: Tuesday 22 December 2026, 21:00 (Paris).**
Feature freeze: **15 December 2026**.

---

## 1. Weekly milestones

| Week | Objective | Where we are (11 Nov 2026) |
|---|---|---|
| **11 – 17 Nov.** | The six validations of §18; `check-permission` called over MCP and through the hook | **Current week.** The pure decision core (catalogue, path matching, hook mapping, plan-first evaluation) is in place and unit-tested; the Forge runtime, the manifest and the `rovo:mcp` module are being built. The six §18 points to validate with a prototype: identity transmitted to an action during an external MCP call, the shape of the `mcp_tool` hook decision, web-trigger response time under load, equivalent hooks in other clients, hash chaining under concurrent writes, notification of approvers. |
| **18 – 24 Nov.** | Classes, zones, rules, resolution, reclassification, simulation console | Planned. The fifteen classes and their default levels are already in `src/core/catalog.ts`; the resolver, the zones and the console remain. |
| **25 Nov. – 1 Dec.** | Requests, approvals, permits, issue panel | Planned. |
| **2 – 8 Dec.** | Chained ledger, kill switch, settings, generated hooks file | Planned. The hooks-file generation and the level → decision mapping are already in `src/core/gate.ts`. |
| **9 – 15 Dec.** | Rovo agent, observation mode, trust capital; **feature freeze on the 15th** | Planned. |
| **16 – 22 Dec.** | Acceptance testing (§21), video, instructions for the judges, submission, Marketplace submission | Planned. |

The acceptance scenarios of §21 and the three testing paths of §23 are collected in
[`JUDGES.md`](JUDGES.md); the video script (less than five minutes, in English) is §22 of the
specification.

---

## 2. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "An agent can ignore the tool" | §10 assumes it openly and provides the hook, closed by default (`onFailure: "block"`): without an answer from the app, the sensitive action does not happen. |
| Too many interruptions, therefore workarounds | Wide N4 and N5 levels, observation mode before any hardening, plan first: one request for a whole plan, and a deadline on every approval — reminder, escalation, then expiry (`src/services/sla.ts`). |
| Approval given without reading | Short card, precedents, a reason required to refuse — and for an unusually long duration. |
| Dependency on a single client for the hook | The MCP tool and the CI verification work for every client. |
| Hook latency | Pattern filtering, policy cache, a one-second target measured on 95 % of calls. |
| False sense of security | For each agent profile, the app displays which enforcement points are actually in place (a profile without a hook is marked "unconstrained" in the ledger). |

---

## 3. Long-term vision

- **The policy writes itself.** "The last 40 minor dependency-update requests were all granted and
  confirmed: move this class to N4?" — and the other way round: "Three incidents followed a CI
  change by an agent: move it to N1?"
- **A chain of delegation.** An agent that spawns sub-agents passes them a permit **narrower** than
  its own, never wider. The ledger shows the whole tree.
- **Budgets.** A cap per ticket and per day: number of autonomous actions, files changed, declared
  spend. Beyond it, back to approval.
- **Proof of human supervision.** For every delivered change, the organisation can produce who
  authorised what, when, and under which rule. That is the file an auditor — or a client — will
  ask for.
- **One permit system for every agent.** Coding agents, Rovo agents that modify tickets,
  operations agents: the same registry, the same levels, the same ledger.
- **The permit becomes a team-to-team standard.** A team publishes what it lets other teams' agents
  do on its services.
