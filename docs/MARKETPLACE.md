# Atlassian Marketplace listing — draft

> Draft listing for the Marketplace submission planned in the week of 16–22 December 2026
> (specification §24). Field names follow the usual Marketplace app-listing structure.
> Facts about the platform cited below were verified on 11 November 2026 against the
> documentation linked in [`VALIDATIONS.md`](VALIDATIONS.md).

---

## App name

**Permis d'agir — Agent Permits**

## Tagline (< 60 characters)

`Signed, scoped permits for coding agents — audited in Jira` (58 characters)

## Short description (one paragraph, listing summary)

Permis d'agir makes Jira the permission registry for coding agents. Every sensitive action an agent attempts is classified (15 action classes), resolved against your project policy (6 autonomy levels), and either allowed, sent to a human approval on the ticket, or refused with the rule that fired. Approvals mint signed, time-boxed, single-usage permits; every decision lands in a SHA-256 hash-chained ledger that cannot be rewritten. A Claude Code `PreToolUse` hook enforces the policy on the workstation — closed by default — and nine MCP tools serve any MCP-compatible client.

## Long description

Draft for the Marketplace "detailed description" field; it reuses the README's product narrative.

### The problem

Coding agents run migrations, edit CI, bump dependencies and sometimes disable the test that blocks them. What they are allowed to do is decided in three disconnected places: the developer's head, an instructions file, and per-machine tool settings. None is shared, verifiable or traceable. When an incident happens, nobody can answer: who authorised this, on what basis, and could the agent act alone?

### What the app does

- **Policy you can read.** A classes × zones grid per project: 15 action classes (read, edit code, edit tests, disable a test, dependencies, CI, migrations, data deletion, secrets, infrastructure, destructive git, production, outbound, the policy itself), 6 autonomy levels from N5 (autonomous) to N0 (forbidden). Organisation rules form a floor a project can harden, never soften. Observation mode lets any rule decide-and-log before it blocks.
- **Classification you can trust.** The app never takes the agent's word: deterministic patterns reclassify from the target (a file under `migrations/` is a migration whatever was announced) and from the command text; free-form descriptions are classified by the Forge `llm` module, most-restrictive class on doubt. Every answer cites the rule applied.
- **Approvals on the ticket.** At N2/N1, a request card appears on the issue: what / why / how / risk / precedents / who. The pilot can never approve their own request; N1 needs two approvers with different roles.
- **Signed permits.** An approval produces a permit: exact scope (class, target, ticket), duration (2 h default), usage count, holder, HMAC-SHA256 signature with an installation secret. Revocable at any time; citable in commit messages (`Permis-Agent: PA-2026-000417`).
- **Tamper-evident ledger.** Every decision, request, approval, permit, usage, declared action, trust variation and kill-switch event is chained with SHA-256; nightly verification reports the first break; CSV and Confluence export.
- **Kill switch.** One click suspends all autonomy above reading for a project or the organisation; permits suspended, requests frozen, banner on tickets, reason required.
- **Trust capital.** A 0–100 score per agent profile that nudges autonomy at the margins and never opens N0/N1/N2 classes.
- **Enforcement on the workstation.** The app generates the Claude Code hooks file from your policy. The `PreToolUse` hook queries the app's gate and blocks sensitive calls without a valid permit; `onFailure: "block"` keeps the door closed when the app is unreachable.
- **For humans in Rovo Chat.** A Rovo agent answers "What did the agents do this week?", "Why was this request refused?", "May an agent touch the CI here?" — always citing the rule.

### What the app does NOT do (assumed limits)

- **It cannot gate Bitbucket pull requests by itself.** A Forge app installed on Jira cannot call the Bitbucket API (specification §18): enforcement point 3 — the merge gate — requires a **companion app installed on Bitbucket** (not included in this listing). The gate web trigger already answers permit-verification calls that such a companion app or any CI step can make.
- **It does not control clients that have no hook mechanism.** Enforcement point 1 (the MCP tool) relies on the agent's instructions; points 3 and 4 (merge gate, after-the-fact detection) are the safety net for hookless clients. A profile with no hook installed is marked "unconstrained" in the ledger — the app never pretends to enforce more than it does.
- **It does not read your source files.** See the privacy section: tool names, paths and masked commands only.
- **The external MCP endpoint requires an administrator to enable it** (Atlassian Administration → Connected apps) and the `rovo:mcp` module is an Atlassian **Preview** feature.

## Categories

- **DevOps / CI-CD** — policy gate for agent-driven change.
- **Security & Compliance** (audit trail, approvals, tamper-evident ledger).
- **IT & Tech Services / Workflow & Automation** — approvals workflow on tickets.

(Final Marketplace category picks must be confirmed against the category list available in the partner console at listing time.)

## Pricing

**Free** during the hackathon and for the first public version. No paid tiers, no external licensing server: the app runs entirely on Atlassian infrastructure and does not require any third-party account or subscription. Any future pricing decision is out of scope for this submission.

## Languages

Interface in **English** and **French** (specification §19). The agent-facing tool descriptions ship in both; the Rovo agent answers in the language of the question.

## Products and versions

- **Jira Cloud** — the app is a Forge app and installs on Jira Cloud sites only. No Data Center / Server support (Forge is the Atlassian-hosted Cloud platform).
- Forge SQL is not available in Atlassian Government Cloud at the time of writing; the app therefore does not support AGC sites.
- Rovo features (`rovo:mcp`, `rovo:agent`, `rovo:skill`) require the site to have Rovo available; the MCP module is in Preview and may be subject to shorter deprecation windows.

## Hosting declaration — "Runs on Atlassian"

The app runs **exclusively on Atlassian-hosted compute and storage**: Forge functions, Forge SQL, the Forge `llm` module, and Forge web triggers. There is no partner-hosted backend, no remote, no container.

Honest caveat: the badge is applied automatically only to eligible apps, and per the web trigger documentation **only static web triggers are eligible for the Runs on Atlassian program**. Our `gate` web trigger is declared `response: { type: dynamic }` because the hook decision body carries dynamic reasons, request numbers and permit ids. As of this draft the app therefore **may not qualify for the badge while the gate stays dynamic**, even though no data ever leaves Atlassian infrastructure. Options before listing: (a) run `forge` CLI eligibility check and keep dynamic if the badge is not granted; (b) restructure the gate to static outputs if the badge matters more than body flexibility. Decision to be recorded after the first deployment.

## Network egress declaration

- **Outbound calls to third parties: none.** The source code contains no `fetch` to external services, no analytics, no telemetry, no remote module (verified on 11 November 2026: no external egress call in `src/`).
- The **`llm` module runs on Forge infrastructure** (Atlassian-hosted model invocation), used only to propose a class for free-form action descriptions.
- The **web trigger is inbound-only**: Claude Code (or CI) calls the gate; the gate never calls back out. Web trigger URLs are public and not authenticated by the platform, so the gate requires the personal bearer token and answers nothing useful without it.
- Jira/Confluence REST calls (issue comments for approver notification, Confluence export) go to the **same Atlassian site** via the platform APIs, not to the internet.

## Permissions (scopes) and justification

Declared in `manifest.yml` under `permissions.scopes`:

| Scope | Why the app needs it |
|---|---|
| `read:jira-work` | Read the issues referenced by permission checks and requests (`issueKey`), their project, type and status, to resolve conditional rules (e.g. incident-linked tickets) and to display the request card context on the ticket. |
| `write:jira-work` | Write on issues the app manages: post the approval-request notification as a comment with the approvers mentioned (the specification's fallback for notifications), surface kill-switch banners, and manage the app's issue-level artefacts (requests, statuses). The app never edits your business fields. |
| `read:jira-user` | Resolve the identity of pilots and approvers (account id, display name) to enforce the separation of powers — the pilot cannot approve their own request — and to name authorised approvers per action class. |

No scope outside Jira work/user data is requested. The app does not use `asUser` calls from the web trigger (the platform does not attach user identity to web trigger invocations); the personal token identifies the pilot there.

## Privacy and data

**What the app stores** (in Forge SQL, per installation, on Atlassian infrastructure):

- policy rules, zones, agent profiles and their trust events;
- approval requests (class, target, justification, plan), approvals and decisions;
- permits (scope, expiry, usages, signature — the installation secret itself never leaves the app);
- the ledger: date, project, ticket, agent profile, pilot, class, target, rule applied, decision, permit;
- personal hook tokens **as hashes only** — the clear token is shown once and never stored;
- from hook events: **tool names, file paths, working directory and command text**.

**What the app never stores: the content of your files.** The hook protocol sends the tool call's name and arguments; the app does not request, receive or store file contents (specification §19, "Sobriété"). Commands are **masked by pattern before storage** (tokens, passwords, secrets).

**Retention.** Ledger entries are append-only and retained for the lifetime of the installation — that immutability is the product. No entry is deleted or edited by the app; corrections are new entries pointing back. Uninstalling the app removes its hosted storage per Atlassian's hosted-storage data lifecycle.

**Your rights.**

- **Export**: the ledger exports to CSV (and to a Confluence page) at any time, filterable by ticket, agent, class, zone and period — this covers data-portability requests.
- **Erasure**: because the ledger is tamper-evident by design, erasure of a personal identifier inside the chain would break it; erasure requests are handled at installation level (uninstall removes all app data), and personal hook tokens can be revoked immediately (the hash stops matching). This trade-off is stated openly rather than papered over.
- **No sale, no sharing, no analytics**: data never leaves the customer's Atlassian environment (see the egress declaration).

## Support

- **Documentation**: repository README, `docs/JUDGES.md` (testing paths), `docs/HOOK-SETUP.md` (hook installation and tokens), `docs/ARCHITECTURE.md`.
- **Issues**: the public repository's issue tracker (https://github.com/BaptisteFaisy/permis-forge) during the hackathon; a support mailbox or Atlassian Community space will replace it for the public listing.
- **Response target**: best effort within 5 business days during the hackathon period (solo maintainer — stated honestly).

## Versioning and backward compatibility

- Current version: **1.0.0** (`manifest.yml`). Semantic app versioning per Forge rules: adding Forge SQL to an existing installation is a major version and requires admin consent; changing the web trigger from static to dynamic (or adding the first dynamic trigger) is a major version.
- MCP tool inputs are additive-only within a major version: new optional inputs may be added; existing tool keys, input names and decision semantics (`allow` / `ask` / `deny`, level names N0–N5, class codes A-01…A-15) are stable within 1.x, because committed hooks files and CI steps depend on them.
- Ledger format (canonical JSON + SHA-256 chaining) is a compatibility contract: it will never change within a major version, so old chains remain verifiable.

## Installation

1. Install from the Marketplace listing onto your Jira Cloud site (admin rights required).
2. Open the app's **global page** once to initialise the default policy (15 classes with their default levels) — no external account, no license key.
3. In each project: open **Project settings → Permis d'agir**, adjust the classes × zones grid, name the approvers per class, and download the generated hooks file into your repositories' `.claude/settings.json`.
4. Each developer generates a **personal hook token** in their personal settings page and exports it as `PERMIS_AGENT_TOKEN`.
5. Optional — external MCP clients: an admin enables the app's tool exposure in Atlassian Administration (Connected apps), then clients connect to `https://mcp.atlassian.com/forge/<appId>` via OAuth 2.1.
6. Optional — start rules in **observation mode** and read the report before enforcing.

## Uninstallation

Standard Forge uninstall from the site's app manager. The hooks files committed to repositories become inert once tokens are revoked (revoke tokens first in personal settings, or simply unset `PERMIS_AGENT_TOKEN`: with `onFailure: "block"` the gate failing closed means sensitive actions stop rather than run unchecked — remove the hooks file to restore normal agent operation). App data (policy, requests, permits, ledger) is deleted with the app's hosted storage; export the ledger to CSV **before** uninstalling if you need the audit trail.
