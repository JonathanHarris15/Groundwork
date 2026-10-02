---
name: create-epic
description: Shape a whole project into a JIRA epic and split it into the sibling tickets it's actually made of, ordered by what blocks what and dated. Use when work arrives project-sized — several demoable checkpoints, or you keep saying "and then also…" — whether it arrives cold as a rough idea or as a To Plan ticket that turned out to be five tickets.
argument-hint: "The project idea (a rough sentence is fine), or an existing epic key to re-chart"
---

# Create Epic

> **Operator.** This skill is run by Cursor Cloud Agents. Grok Bot is the project owner: it answers routine questions for Jonathan and escalates only crucial decisions.

**One idea in, several tickets out.** That is the job nothing else in this workflow does:
`to-issues` splits a ticket *downward* into sub-tasks, `grill-with-docs` sharpens one thing.
This splits *sideways* — into sibling level-0 tickets, wired with what blocks what, and dated.

Read [BOARD.md](../plan-ticket/BOARD.md) first. Jira is **Atlassian MCP** on Cursor Cloud
Agents — see [JIRA.md](../plan-ticket/JIRA.md). What binds you: the **Epic is a grouping and
never appears on the board**. Every ticket you create is level-0 and lands in **`To Plan`**,
unspecced by definition, where `/plan-ticket` picks it up one at a time. You do **not** create
sub-tasks — that's `to-issues`, later, per ticket, after `to-prd`.

## Two ways in

- **Cold** — `/create-epic <idea>`. A project has arrived with no ticket behind it. Start at
  Discover.
- **Escalated** — `/plan-ticket` found a `To Plan` ticket that is really a project (see
  [ROUTING.md](../plan-ticket/ROUTING.md)). The ticket is the seed. Skim Discover, since some
  of it is already written down, and close that ticket with a comment linking the new epic.
- **Re-chart** — `/create-epic <EPIC-KEY>` on an epic that already exists. Skip to Re-chart.

## Phase 1: Discover — find the shape

Turn a rough idea into a crisp problem statement and a reason this project exists. Call the
Skill tool twice, for **"grilling"** and **"domain-modeling"** — grilling runs the interview in
rounds, domain-modeling keeps `CONTEXT.md` and the ADRs honest as terms settle. This phase is
that interview, aimed at the four bullets below.

Read the room first: *is the vision clear, or are we still working out what this even is?*

- **Fuzzy → diverge before narrowing.** Ask what triggered this now. Ask what "done and great"
  feels like. Offer two or three genuinely different framings and ask which resonates — "this
  could be a 'reduce manual effort' project, a 'new capability' project, or a 'de-risk the
  existing thing' project; they'd be scoped very differently." Probe for the underlying pain
  rather than the proposed solution, because people describe solutions. Reflect back candidate
  problem statements and let me correct them.
- **Clear → confirm, then attack it.** Restate the vision in your words. What's the riskiest
  assumption? What would make this not worth doing?

**Do not fake certainty I don't have.** If I open with "I want to build X" but can't say why or
for whom, that's a signal to keep grilling, not a green light to decompose. It is correct for a
cold session to spend most of its time here. The well-shaped epic is the deliverable; the JIRA
tree is just how it gets written down.

Converge only when you can write, and I agree with:

- **Why now / the problem** — the pain, from the stakeholder's side.
- **Goals and wants** — outcomes I'm committing to, kept separate from the nice-to-haves.
- **Definition of success** — how we'll know the epic delivered.
- **Non-goals** — explicitly. Push me to name what we are deliberately not doing. This is where
  scope creep dies.

## Phase 2: Shape — scope and vocabulary

- **Where does this live?** Which modules and areas it touches. Explore the codebase and prefer
  extending existing seams over inventing new structure.
- **Term conflicts.** If my framing uses language that clashes with `CONTEXT.md`, or isn't in
  it, resolve that now and write it down. `CONTEXT.md` is a glossary and nothing else — the
  scope and the plan live on the epic, not in it.
- **Constraints and dependencies.** Deadlines, other people, tech constraints, what must ship
  first.
- **Risks and unknowns.** What could sink this? Write them down — they become tickets in
  Phase 3.

## Phase 3: Decompose — one idea into its siblings

Name the tickets this project is made of. Every one is level-0 and one of two kinds. The kind
is a **per-ticket** judgement, and a healthy epic usually has both:

- **Feature** — a demoable deliverable. A vertical slice, thin path through every layer,
  visible on its own. These are the checkpoints you sequence and date. Prefer several thin
  Features over a few thick ones.
- **Investigation ticket** — a question whose output is a *decision*, not code. Label
  `investigation`, summary prefixed `[research]`, `[prototype]`, `[grill]` or `[task]`, no due
  date. It **blocks** whatever it gates.

**The test is one question: can you name this as a demoable slice right now, or is it still a
question?** If you catch yourself hand-waving — "…and then somehow we rank the
recommendations" — that is not a Feature, it's an investigation ticket wearing a Feature's
clothes. File it honestly. A resolved investigation usually graduates into one or more real
Features later, which is what Re-chart is for.

Signals that something is a question, not a slice: an unproven approach, a library that may not
do what you need, an open build-vs-buy or which-architecture call, an external constraint
(legal, partner API, compliance) that would reshape the plan.

Write each Feature in the register in [FEATURE-STYLE.md](FEATURE-STYLE.md) — plain-language
*what and why* that defines its own jargon, plus specific, measurable acceptance criteria. Keep
it high-level, which means *not yet decomposed*, not *vague*. Resist writing the implementation
breakdown; that's `to-issues`, later.

**Bugs are not part of this tree.** If bugs surface while grilling, file them straight into
`To Plan` and carry on. A bug may be parented to this epic later if it has to be fixed before
the epic ships — that's `plan-ticket`'s call, not yours.

Present the tickets as a numbered outline and iterate with me before anything is published.

## Phase 4: Sequence — dependencies first, then dates

- **Dependencies first.** For each ticket, establish what blocks what. Order by dependency, not
  by wishful timeline, and call out what can run in parallel.
- **Size each Feature** S / M / L so the shape of the effort is visible.
- **Then dates, and always ask.** This is milestone-driven solo work, not sprints, so due dates
  are part of the plan. Ask in order: the **epic due date** ("by when do you want this whole
  thing done?"), then **per-Feature target dates** walked in dependency order. Those per-Feature
  dates are early-warning markers, not commitments — a deadline on a big epic with nothing in
  between means you find out you're late at the end. Derive defaults from the sizes working
  backwards from the epic date, and let me adjust.
- **Investigation tickets never get dates.** Deciding is not a dated deliverable.

If there's no epic deadline, that's a valid answer — skip dates and say so. But ask every time.

## Phase 5: Publish

See [JIRA.md](../plan-ticket/JIRA.md) for the connector, the three levels, and how to create,
link and edit issues. In order:

1. Confirm site, project, and issue types with me.
2. Create the **Epic**. Its description is the vision from Phases 1–2 plus the two sections
   JIRA can't hold anywhere else — **Fog** and **Out of scope**:

   - `## Why now`, `## Goals & non-goals`, `## Success looks like` — from Phase 1.
   - `## Fog` — questions you can see coming but can't sharply ticket yet. Not a to-do list; a
     signpost for anyone reading where this is headed.
   - `## Out of scope` — directions ruled out of *this* epic, and why.

   **Fog** is the honest half of the map: things in scope but not yet sharp enough to phrase as
   a question. The test for fog-versus-ticket is whether you can *state* the question now, not
   whether you can answer it. Don't pre-slice fog into ticket-sized pieces; one patch may
   graduate into several tickets, or none.

   Don't keep a running "decisions so far" list on the epic. Closed tickets carry their own
   decision comments and JIRA already shows them; the hard ones become ADRs. Restating them
   here just goes stale.

3. Create each ticket under the Epic. A **Feature** uses the project's level-0 Feature type,
   with its description written per [FEATURE-STYLE.md](FEATURE-STYLE.md). An **investigation
   ticket** is also level-0 — use `Task`, `Story`, or a `Spike` type if the project has one —
   carrying the `investigation` label, the `[research]` / `[prototype]` / `[grill]` / `[task]`
   prefix in its summary, and **no `duedate`**. The label is what marks it as decision work,
   whatever type it ended up as.
4. Wire the **Blocks** links from Phase 4.
5. Set due dates — the epic's, and each Feature's.
6. Record **epic-level ADRs** for the hard-to-reverse calls made along the way: the big bets,
   build-vs-buy, a boundary that constrains everything under it. Only when all three hold —
   hard to reverse, surprising without context, a real trade-off with genuine alternatives.
   Format is in [ADR-FORMAT.md](../domain-modeling/ADR-FORMAT.md). Reference the ADR from the
   epic so the decision travels with the work.
7. **Put every ticket in `To Plan`.** They are unspecced by definition, and the board's
   integrity rule forbids an unspecced ticket sitting further right.

**Hand off and stop.** Report the epic key and link, and the tickets, all in `To Plan`. From
here each one is picked up by `/plan-ticket <KEY>`, which routes it — including the
investigation tickets, whose `[research]` / `[prototype]` / `[grill]` prefix tells it which lane
to take. Tell me I can run `/plan-ticket ALL` to work the whole column.

Charting is one session's work. Don't start resolving anything now.

## Re-chart

`/create-epic <EPIC-KEY>` on an epic that already exists. Use it when investigation tickets have
closed and the fog has moved.

1. Read the epic and its children. Note which are closed and what they decided.
2. **Graduate the fog.** Whatever is now sharp enough to state as a question, or name as a
   demoable slice, becomes a fresh ticket. Clear each graduated patch out of the epic's **Fog**
   section so it lives in exactly one place.
3. If a decision has invalidated tickets that are still open, update or close them. If something
   turned out to sit beyond this epic, close it and leave a line in **Out of scope** — a scope
   boundary is not a step on the route.
4. Re-sequence and re-date whatever changed.

When the Fog section is empty and nothing blocks decomposition — when you feel the pull to just
go build it — the epic is fully charted. Say so.
