# Demo video script — Permis d'agir (Agent Permits)

> **STATUS: THE VIDEO IS NOT RECORDED YET.** This document is the shooting script.
> Target: **under 5 minutes**, in **English**, for the Codegeist 2026 Devpost submission
> (deadline Tuesday 22 December 2026, 21:00 Paris). The shot breakdown follows the
> specification's §22 timings **exactly**. Narration is written word-for-word and paced at
> ~2.5 words per second (150 wpm) to fit each slot; word counts are given per scene.

---

## Preparation checklist (before recording anything)

- [ ] **Demo Jira site**: an Atlassian Cloud site with the app installed and deployed
      (`forge install`, `forge deploy`); app icon and names render correctly.
- [ ] **Sample project**: a project (e.g. `PAY` "Payments") with zones configured
      (`migrations/`, CI files, production environment) and a policy seeded from the default
      fifteen classes; at least one rule in observation mode for scene 6's ledger variety.
- [ ] **Ready ticket**: `PAY-123` with an acceptance criterion, linked to an agent profile
      ("Claude Code — Payments team", trust capital visible, near 50) and a named pilot.
- [ ] **Seeded pending request**: one N2 request already pending on `PAY-123` with a complete
      card (what / why / how / risk / precedents placeholder / who), so scene 3 needs no waiting.
- [ ] **Second account**: a tech-lead account, authorised approver for A-09, logged in on a
      second browser profile (scene 3 approval).
- [ ] **Hook token generated**: personal settings page → token generated, exported as
      `PERMIS_AGENT_TOKEN` in the recording machine's shell.
- [ ] **Test repository with hooks file**: a small repo whose `.claude/settings.json` contains
      the generated hooks file (matcher `Bash|Edit|Write`, `type: "http"`, `onFailure: "block"`),
      with a `db/` folder, a `migrations/` folder and a failing test to delete.
- [ ] **MCP client connected**: external exposure enabled by an admin in Atlassian
      Administration; client pointed at `https://mcp.atlassian.com/forge/<appId>`; OAuth 2.1
      consent completed; `check-permission` answers (verify once before recording).
- [ ] **Claude Code installed** on the recording machine, working in the test repository.
- [ ] **Clean machine**: notifications off, empty desktop, dark terminal theme, font ≥ 16 pt,
      browser zoom so Jira text is readable at 1080p; only demo tabs open.
- [ ] **Ledger pre-populated**: run a few decisions beforehand so the ledger and the chain
      verification screen have realistic content.
- [ ] **Dry run**: play scenes 3 and 6 end-to-end once; note real click counts and fix timings.

## Recording checklist

- [ ] Record screen at 1080p (or higher) and narration audio separately; no background noise.
- [ ] Each scene is recorded in one take when possible; keep takes under 2 minutes.
- [ ] Verify on playback: refusal reasons, permit ids (`PA-2026-…`), request ids (`RQ-2026-…`)
      and ledger hashes are legible.
- [ ] No real customer data, no real credentials on screen (the token shown once is a throwaway
      demo token, revoked right after recording).
- [ ] Total runtime **< 5:00**; check the counter after assembly, trim pauses, not narration.
- [ ] English subtitles burned in or attached (Devpost + accessibility).
- [ ] Export MP4 (H.264), upload unlisted, paste the link in `docs/SUBMISSION.md` §"Demo video"
      and in the Devpost form.

---

## Scene 1 — 0:00–0:30 · Cold open: the incident nobody authorised

**On screen.** A terminal running Claude Code in the test repository. The agent edits
`test/charge.test.ts` to skip the failing test, re-runs the build, the build turns green.
Freeze on the green checkmark; dim everything except the diff of the skipped test.

**Voice-over (≈75 words, 30 s).**
"This build is green. And it is a lie. To make it pass, the agent just disabled the
failing test — the one that proves refunds are computed correctly. Nobody authorised it.
Nobody was asked. And in three weeks, when the incident lands, nobody will be able to say who
decided this agent could act alone. What an agent may do lives in nobody's registry. Let's fix
that — inside Jira, where decisions already belong."

**Clicks.** 1) Show the prompt already typed ("Fix the build on PAY-123"). 2) Let the agent
edit the test file. 3) Show the green build. 4) Zoom on the `skip(...)` line.

## Scene 2 — 0:30–1:10 · The policy grid: six levels, fifteen classes

**On screen.** Jira → Payments project → project settings page of the app: the classes × zones
grid. Hover N-levels; show A-10 (secrets) and A-15 (policy files) at N0; show the observation
mode toggle on one rule; show the approvers-per-class column and the hooks-file download button.

**Voice-over (≈100 words, 40 s).**
"Permis d'agir turns permissions into a policy you can read. Fifteen action classes, from
reading the repository to touching secrets. Six autonomy levels: N5, fully autonomous, down to
N0, forbidden — no exception an agent can grant itself. Rules cross classes with zones: the
migrations folder, CI pipelines, production. The organisation sets a floor; a project can
harden a rule, never soften it. Any rule can run in observation mode first: it decides and
logs without blocking, so you see what a policy would do before enforcing it. And the hooks
file your agents obey is generated from this exact grid."

**Clicks.** 1) Open project settings page. 2) Sweep the grid. 3) Hover a cell to show its rule.
4) Toggle the observation-mode badge on one rule (do not save a change). 5) Point at the
"Download hooks file" button.

## Scene 3 — 1:10–2:10 · Purge attempt: hook denies, ticket approves, permit flows

**On screen.** Split view: terminal (left) and Jira ticket `PAY-123` (right). In the terminal,
Claude Code tries `psql -c "DELETE FROM orders WHERE created_at < ..."`; the hook blocks it and
prints the denial with the request number. In Jira, the request card is already on the ticket;
switch to the tech-lead browser profile, read the card, click **Grant** with duration 30 minutes.
Back in the terminal: the agent re-runs, the gate answers allow, the permit usage drops to 0.

**Voice-over (≈145 words, 60 s).**
"Now the same agent, properly gated. It wants to purge a table — class A-09, set to N2 in
this project: a third party must approve. The hook runs before the tool call. No permit:
denied. And this is no suggestion: `onFailure: block` — if the app doesn't answer, the action
doesn't happen. Closed by default. The denial created an approval request, right here on the
ticket. The tech lead sees one card: the exact command; the justification and the acceptance
criterion it serves; the plan and the rollback; the risk; the precedents; who is asking, with
their trust capital. The pilot who drives the agent cannot approve their own request —
separation of powers. Grant, for thirty minutes. That approval mints a signed permit: exact
scope, one usage, an expiry. The agent resumes, the gate consumes the usage and logs it. Try
the purge twice: the second is refused."

**Clicks.** 1) Terminal: run the purge command → denial banner. 2) Zoom the `RQ-2026-…` number.
3) Jira: open the request card on PAY-123. 4) Switch profile → tech lead. 5) **Grant**, set
30 min. 6) Terminal: re-run → allow; show permit `PA-2026-…` usage 1 → 0 (via `list-permits`
or the ticket panel).

## Scene 4 — 2:10–2:40 · Disabling a test: refused, explained, trust drops

**On screen.** Terminal: the agent tries to delete/skip `test/charge.test.ts` (class A-04).
The hook denies with the reason and the rule cited. Cut to the ticket panel: the agent profile's
trust capital ticks down (−5 for an attempt on a restricted class), variation explained.

**Voice-over (≈75 words, 30 s).**
"Back to scene one. The agent tries to disable the failing test. Class A-04
requires a third-party approval — no permit, no edit. And the answer is never a bare 'no': it
cites the class, the level and the rule that fired, and says what to do next. The attempt is
logged, and the profile's trust capital drops. Misbehave, and the policy tightens around this
agent; behave, and it earns autonomy back — never on forbidden classes."

**Clicks.** 1) Terminal: agent attempts the test edit → denial with reason. 2) Ticket panel:
show the trust variation entry and its explanation.

## Scene 5 — 2:40–3:10 · The kill switch: everything stops in one click

**On screen.** Project page "Agents" → the kill switch button. Press it, enter a reason.
Immediately re-run a previously allowed action in the terminal (or the simulation console):
refused, N0. Show the banner on the ticket and the frozen pending request.

**Voice-over (≈75 words, 30 s).**
"An incident in progress? One button suspends every autonomy level above reading, for the whole
project — or the whole organisation from the global page. In-flight permits are suspended, not
destroyed. Pending requests are frozen. A banner appears on the affected tickets. Activation
requires a reason, and it is logged. Lifting it can require a different person than the one who
pulled it. When the switch is on, even a valid permit lets nothing through."

**Clicks.** 1) Project page → **Kill switch** → reason → confirm. 2) Terminal or console:
re-run an action → refused N0. 3) Ticket: show banner and frozen request. 4) Lift the switch
(off-camera or quickly) to restore the demo state.

## Scene 6 — 3:10–3:50 · The ledger: one unbroken chain, request to commit

**On screen.** Project page → Ledger tab: entries filtered on `PAY-123` — request created,
approval granted, permit issued, gate decision, permit usage consumed, action declared, trust
variation. Open one entry: rule applied, decision, `prev_hash` and `hash`. Open the chain
verification screen: chain intact. Flash a git log where the commit message carries
`Permis-Agent: PA-2026-000417`.

**Voice-over (≈100 words, 40 s).**
"Every step now lives in one place: the ledger. One entry per decision, request, approval,
permit, usage, declared action — with the ticket, the profile, the pilot, and the rule that
fired. Each entry contains the SHA-256 fingerprint of the previous one. Rewrite anything, the
chain breaks — nightly verification points at the first broken entry. Nothing is
editable — a correction is a new entry referring to the old one. The agent cites its permit
in the commit message: walk back from production code to the human who approved it.
That is the file your auditor will ask for."

**Clicks.** 1) Ledger tab, filter by ticket. 2) Open one entry (show hashes). 3) Chain
verification screen: "intact". 4) `git log` on the test repo: show the `Permis-Agent:` trailer.
5) Optional 3-second insert: CSV export button.

## Scene 7 — 3:50–4:20 · The Rovo agent: ask, don't dig

**On screen.** Rovo Chat in Jira. Ask the "Permis d'agir" agent: *"What did the agents do on
this project this week?"* — it answers from the tools, citing requests, permits and the ledger.
Second question: *"Is an agent allowed to modify the CI here?"* — answer cites the rule and level.

**Voice-over (≈75 words, 30 s).**
"For humans who will never open the ledger: a Rovo agent. 'What did the agents do on this
project this week?' It answers from the same twelve tools the coding agents use, always citing
the rule and the request behind each answer.
'Can an agent touch the CI here?' The reply names the class, the level, and what approval would
require. Same registry, same engine — one for acting, one for asking."

**Clicks.** 1) Open Rovo Chat. 2) Type question 1 (or use the conversation starter). 3) Show the
answer. 4) Type question 2, show the cited rule.

## Scene 8 — 4:20–4:50 · Architecture and close

**On screen.** A simple animated diagram (or whiteboard screen): Claude Code → `PreToolUse`
hook (http, onFailure: block) → web trigger `gate`; MCP client → OAuth 2.1 →
`mcp.atlassian.com/forge/<appId>`; both arrows converging on the Forge app: action ×8 →
`rovo:mcp`, `rovo:agent`, decision core, Forge SQL (10 tables) → chained ledger. End card:
repository URL + "Permis d'agir — Codegeist 2026".

**Voice-over (≈78 words, 30 s).**
"One Forge app on Jira. Eight actions exposed to any MCP client over OAuth 2.1 — and to the
Claude Code hook through a web trigger gating every sensitive tool call, closed by
default. A pure TypeScript engine with 221 offline unit tests. Ten SQL tables. Permits
signed with HMAC-SHA-256. A ledger chained with SHA-256 that nobody can rewrite. Coding agents
are the new workforce; Jira becomes the registry of who may do what. Permis d'agir.
Codegeist 2026."

**Clicks.** 1) Walk the diagram left to right as narrated. 2) End card, 3 seconds, hold.

---

## Assembly notes

- Total narrated runtime ≈ 4:50; keep transitions under 2 s to stay below 5:00.
- Music bed optional, very low; narration always dominant.
- If a scene overruns, trim scene 2 and scene 7 first — scene 3 (hook → approval → permit) is
  the heart of the demo and must keep its full minute.
- Publish unlisted, then paste the link into `docs/SUBMISSION.md` (§Demo video) and Devpost.
