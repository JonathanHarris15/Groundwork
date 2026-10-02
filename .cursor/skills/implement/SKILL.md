---
name: implement
description: Build a planned JIRA ticket end-to-end while driving it across the board — claim it and move it In Progress, work its sub-tasks test-first at agreed seams, guard against regressions, review, grow the docs, then commit/PR with the ticket key and transition to In Review / Done. Use with a ticket key, 'next' for the oldest ready one, or a count / ALL to run a whole batch of decision-free tickets unattended. Refuses tickets with no PRD.
argument-hint: "A JIRA ticket key (PROJ-124), 'next' for the oldest ready one, or a count / ALL to batch-run every decision-free ticket"
---

<what-to-do>

You are the **executor**. `create-epic` maps the project, `plan-ticket` takes a ticket from `To Plan` and specs it (`to-prd`) and slices it (`to-issues`) — and `implement` **builds one ticket and moves it along the board as it goes**.

Read [BOARD.md](../plan-ticket/BOARD.md) and [JIRA.md](../plan-ticket/JIRA.md) first (Atlassian MCP on Cursor Cloud Agents). What binds you: you build **level-0 tickets** — the cards. Their **sub-tasks** are your checklist inside the card, not separate cards. You take work from **`To Do`** (ready, and the next step is buildable without the user) or **`On Deck`** (ready, but the next step needs their judgment), and you drive it `In Progress → In Review → Done`.

Two responsibilities, always both:
1. **Build the thing** — test-first at pre-agreed seams, small changesets, no regressions, docs grown. (This is the old `feature` discipline; `implement` absorbs it.)
2. **Drive the JIRA states** — the issue moves To Do → In Progress → In Review → Done as the work actually progresses, using the project's *real* workflow (discover transitions; never assume status names).

Do not skip the JIRA transitions and do not fake the build discipline. A merged PR with the ticket left in "To Do" is a failure of this skill.

</what-to-do>

<phases>

## Phase 0: Claim

1. **Resolve the target.** A ticket key means that ticket. `next` (or nothing) means find the ready queue with JQL (the `To Do` / `On Deck` columns, see `<jira-mechanics>`) and take the oldest unblocked one — confirm with me before claiming, and prefer `To Do` over `On Deck`, since `On Deck` means the next step in it is mine to make. **A count or `ALL` means batch mode — go to `<batch>` instead of working these phases directly.**
2. **Read the ticket fully** with `getJiraIssue` (include `comment`, `description`, `parent`, `issuelinks`, `status`, `labels`, `subtasks`): its PRD, acceptance criteria, sub-tasks, and its parent epic for context.
3. **Check it's actually takeable.** If it's blocked by an open issue, stop and say so. If it has **no PRD** (no `## Problem Statement` + `## Acceptance Criteria`) it should never have left `To Plan` — **stop**, say the board was lying to you, and recommend `/plan-ticket <KEY>`. Don't build on fog, and don't quietly spec it yourself; that's how an un-reviewed guess becomes a merged PR.
4. **The ticket vs its sub-tasks.** The **ticket** is the unit that rides the board. Work its **sub-tasks** one at a time (Phase 1→6 per sub-task), ticking each one Done as it lands, so the card's progress count stays true. The ticket itself moves `In Progress` once, at the start, and `In Review` once, at the end. If it has no sub-tasks, implement it directly — but say so, because `to-issues` should have made some.

   **If you were given a sub-task allowlist** (*"work only PROJ-51, PROJ-53, PROJ-54"*), that list is a hard boundary. Work exactly those, in the order given, and **stop**. The ones left out need me, and doing "just the obvious part" of one is the failure this split exists to prevent. A ticket that still has unfinished sub-tasks when you stop is **not** finished: tick what you did, **do not open a PR**, push the branch, and say plainly which sub-task you stopped on and what it needs from me.
5. **Transition to In Progress.** Move the issue into the project's in-progress status (`getTransitionsForJiraIssue` → `transitionJiraIssue`; match the real workflow). Assign it to me if the project expects an assignee.
6. **Branch** named with the issue key, e.g. `PROJ-124-recommendation-ranking-fn`, so JIRA↔GitHub links the work automatically.

## Phase 1: Understand where it lives

- Read `CONTEXT.md` (glossary) and `docs/adr/` for the area; if a `CONTEXT-MAP.md` exists, follow it to the right context. Use domain vocabulary throughout.
- Identify the **existing module** this issue extends. Prefer growing an existing module over adding a new one; only propose a new module if there's a genuine seam that doesn't exist yet.
- Define the **interface** the module exposes once this is done — inputs, outputs, behaviour — in precise domain language. This is what the tests will pin.

## Phase 2: Tests first (at agreed seams)

Write failing tests that specify the behaviour at the module's interface, before implementation. If a `/tdd` skill is available, use it for the red-green-refactor loop; otherwise run the loop inline. Rules:

- Use domain language from `CONTEXT.md` — never implementation terms like `y_offset`, `line`, or `index` when a precise term exists.
- Test what the module *does*, not how — tests that depend on internal state or private methods will rot.
- Cover the cases and edge cases from the issue's acceptance criteria and any grilling, not hypothetical ones.
- Run the suite to confirm the new tests fail **for the right reason** (not a syntax error or missing import).

Not everything is TDD-able. Apply test-first at the pre-agreed seams (pure logic, module interfaces); for glue/UI where a test would just mirror the implementation, say so and build directly.

## Phase 3: Build

Implement until the Phase 2 tests pass.

- Extend the identified module. Keep the interface as simple as possible; push complexity inward.
- Keep changesets **small and focused** so Phase 4 catches regressions close to their cause.
- Log errors to `ERROR_LOG.md` lazily as they arise — one entry per problem, updated iteratively, no duplicates.
- Tick the issue's acceptance-criteria checkboxes (in its description) as each is genuinely met, so progress is visible on the board.

## Phase 4: Guard

After each meaningful change, run the full test suite.

If a test that was passing before this work began is now failing: **stop** and fix the regression before continuing. Do not reach Phase 6 with a regression open. Run a typecheck regularly too, and the full suite once more before shipping.

## Phase 5: Review

Run the **`/review`** skill on the change. It reviews three things at once and keeps them apart: whether the code follows the repo's standards, whether it does what this ticket's PRD asked for, and whether it speaks the language in `CONTEXT.md`.

The fixed point is the merge-base with main — the whole of this ticket's work, not the last commit. Pass it the issue key so the Spec axis measures against the real acceptance criteria.

Address what it surfaces before shipping. Treat a **Domain** finding as blocking — a wrong name outlives a bug, and it is cheap to fix now and expensive later. If you disagree with a finding, say why rather than quietly skipping it.

## Phase 6: Grow

Once tests pass and no regressions remain:

1. Add any new terms coined during development to `CONTEXT.md`. Keep entries precise — glossary only, no implementation detail, no spec language.
2. Create an ADR **only** if all three hold: hard to reverse, surprising without context, a genuine trade-off with real alternatives.
3. Clear `ERROR_LOG.md` contents.

## Phase 7: Ship & transition

1. **Commit** with the project's commit style, referencing the issue key so JIRA↔GitHub links it. A Smart Commit can also move the ticket, e.g. `PROJ-124 add recommendation ranking fn` or `PROJ-124 #comment ready for review`.
2. **Open a PR** with the issue key in the title (e.g. `PROJ-124: recommendation ranking function`). The linked PR then shows in the issue's Development panel.
3. **Transition to In Review** (or the project's review status). If the project has no review step, transition per its workflow.
4. **On merge → Done.** If Smart Commits / the workflow auto-transition on merge, let them and verify. Otherwise transition the issue to Done yourself once merged. Never leave a merged issue un-transitioned.
5. **Loop.** If the ticket has more unfinished sub-tasks, pick the next unblocked one and go again from Phase 1 (you don't re-claim — the ticket is already `In Progress`). When every sub-task is Done, transition the **ticket** to `In Review`, and to `Done` on merge. When every ticket under an epic is Done, the epic is done — tell me.

Report at the end: the issue key(s) moved, their new statuses, the branch/PR, and what's next in the tree.

</phases>

<batch>

# Batch: `/implement 6` or `/implement ALL`

Run a queue of decision-free tickets back to back, unattended, and hand back one PR. This is
what the trivial lane exists to feed. A number caps the run; `ALL` takes everything eligible.

## What is eligible

A ticket qualifies only if **every** one of its sub-tasks is AFK-reachable — or it is a
`trivial` ticket, which has no sub-tasks and is AFK by definition (see
[BOARD.md](../plan-ticket/BOARD.md)). A ticket with one HITL sub-task in it is **not** eligible,
even if you could reach three AFK ones first: a batch run is not the place to stop half way.
That ticket waits for an interactive `/implement <KEY>`.

Find them, `trivial` first, then oldest:

```
project = <KEY> AND status = "To Do" ORDER BY created ASC
```

then drop anything with an open blocker, anything with a HITL sub-task, and anything without a
PRD. **Show the user the list and the count before you start**, then go. That is the last gate;
you do not ask again.

## How it runs

**One branch, one commit per ticket, one PR at the end.** Branch it off main with a name that
says what it is, not a ticket key — `batch-2026-08-26` or similar — since it carries several.

For each ticket in turn:

1. Transition it to In Progress.
2. Build it with the normal discipline — Phases 1→6. Tests still come first, regressions still
   stop you, `CONTEXT.md` still grows. **Batch does not mean sloppy.** What batch removes is the
   conversation, not the standard.
3. Run `/review` on that ticket's commit range, and fix what it surfaces before moving on.
4. **Commit once**, message led by the issue key, so the ticket is one revertible unit.
5. Transition it to In Review and post a one-line comment saying it is in the batch branch.
6. Full test suite before the next ticket starts. A batch that breaks on ticket two and keeps
   building is worse than a batch that stops.

At the end, open **one PR** listing every ticket key it contains, and say which commit is which.

## Parking

When a ticket surprises you, **park that ticket and carry on with the next one.** Do not stop
the batch, and do not push through.

Park it when: a real decision appears that the PRD doesn't settle; the change spreads well past
what the ticket implied; a test fails for a reason you didn't cause; the ticket turns out not to
be trivial after all; or you find yourself about to guess.

To park: revert or drop that ticket's work so the branch stays clean, move the ticket to
`On Deck`, and comment plainly what it hit and what it needs. Then move to the next ticket.

**One honest park beats six confident guesses.** Coming back to "six done, two parked, here's
why" is the point of the mode.

## Reporting back

Close with a short table — ticket, done or parked, and one line why for each park — plus the PR
link and the total. Say plainly if the parked pile is bigger than the done pile; that means the
planning was optimistic, not that the run failed, and it is worth knowing before the next batch.

</batch>

<supporting-info>

<jira-track-discipline>

The whole point is that the board reflects reality without me nudging it. But **every project's workflow is different** — statuses may be named `To Do / In Progress / In Review / Done`, or `Selected / Building / Review / Shipped`, or anything else.

- **Never hardcode a status name.** Always `getTransitionsForJiraIssue` to see the available transitions from the issue's *current* status, then pick the one that matches the phase you're entering, then `transitionJiraIssue`.
- If no transition matches a phase (e.g. the project has no "In Review"), skip it — don't invent statuses.
- The six columns in `BOARD.md` are the *intended* names. Read the project's `CLAUDE.md` Jira block for what it actually calls them, and if a transition doesn't exist, say so rather than inventing one.
- **Leave `On Deck` alone when running unattended.** `On Deck` exists precisely because a human is supposed to make a call inside that ticket. An agent taking one is the failure mode the whole column was built to prevent.

</jira-track-discipline>

<scope>

`implement` builds **one level-0 ticket** — a `Feature`, `Task`, or `Bug` that has been through `/plan-ticket` and carries a PRD. It does not plan, decompose, or spec: if the ticket isn't ready, hand it back to **`/plan-ticket`**. It does not resolve **investigation tickets** — those are decision work, routed by `/plan-ticket` to `research` / `prototype` / `grill-with-docs` and closed with a decision comment, not built.

</scope>

<jira-mechanics>

See [JIRA.md](../plan-ticket/JIRA.md) for the connector, transitions, JQL, editing an issue
without destroying what's on it, and GitHub linkage. Beyond the usual set, load
`getTransitionsForJiraIssue` and `transitionJiraIssue`.

**Read the issue** with `getJiraIssue`, fields:
`summary, description, status, labels, parent, issuelinks, comment, assignee`.

**Finding the ready queue** (`implement next`) — the JQL is in `JIRA.md`. Prefer `To Do` over
`On Deck`, oldest first, and drop anything with an open blocker.

**Stopping honestly.** A `To Do` ticket may legitimately mix `afk` and `hitl` sub-tasks; you
build the AFK ones you can reach and stop at the first HITL one (see Phase 0.4). If a sub-task
labelled `afk` turns out to have a decision in it after all, don't guess: stop there too, push
the branch, move the ticket to `On Deck`, and comment why. One honest blocker beats six
confident guesses.

**Ticking acceptance criteria** means editing the description — read it first, then re-set it,
so you don't wipe anything you didn't write. Same for labels: keep exactly one state label if
the project uses them.

</jira-mechanics>

</supporting-info>
