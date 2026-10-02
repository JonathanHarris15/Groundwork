# The board contract

The canonical description of the workflow every JIRA skill in this config assumes.
`plan-ticket`, `create-epic`, `to-prd`, `to-issues` and `implement` all obey it.

This file says what the columns and levels **mean**. [JIRA.md](./JIRA.md) says how to
touch them — the connector, the three levels, creating, linking, editing, transitions.

If you are reading this because a skill pointed you here: this file is the source
of truth. Where a skill's prose and this file disagree, this file wins — say so.

## The three levels

JIRA nests exactly three levels, and this workflow uses all of them for different jobs:

| Level | JIRA hierarchy | Role here | On the board? |
| --- | --- | --- | --- |
| **Epic** | 1 | **Grouping.** Answers "what project is this part of." Holds the vision, goals, non-goals. Created by `create-epic`. | **No.** Epics never appear as cards. |
| **Ticket** | 0 (`Feature` / `Task` / `Bug`) | **The unit of work.** This is what a card *is*. Holds the PRD once planned. | **Yes.** This is the only thing on the board. |
| **Sub-task** | −1 | **The steps inside a ticket.** Created by `to-issues`. Gives you a live progress count on the card. | **No.** They render inside the parent card. |

**A "ticket" in these skills always means a level-0 item** — the thing that rides
the columns. Never an Epic, never a sub-task.

Issue-type *names* differ per project (some have `Feature`, some only `Story`).
**Never hardcode them.** Read the real names from the `Issue types` line of the
project's `CLAUDE.md` Jira block if it has one, and otherwise from
`getJiraProjectIssueTypesMetadata`.

## The six columns

```
To Plan  →  To Do  →  On Deck  →  In Progress  →  In Review  →  Done
```

| Column | Meaning | Who puts things here |
| --- | --- | --- |
| **To Plan** | **The inbox.** Anything, at any stage of formulation — a title you scratched down mid-feature, a Feature `create-epic` emitted, a long ticket you wrote by hand, an untriaged bug. Nothing here is specced. | You, `create-epic`, `improve-codebase-architecture` |
| **To Do** | Specced and ready, **and the next step is buildable without you.** Has a PRD and sub-tasks. Not yet claimed by anyone or anything. | `plan-ticket` |
| **On Deck** | Ready, **and the next step in it needs you.** A design call, a taste call, something needing your eyes. **Yours to do.** | `plan-ticket` |
| **In Progress** | Being built right now. | `implement` |
| **In Review** | PR open. | `implement` |
| **Done** | Merged. | The merge queue, or you |

The board order you see in JIRA is cosmetic. What matters is the contract below.

## The integrity rule

> **A ticket may not sit right of `To Plan` without a PRD on it.**

This is the load-bearing rule of the whole system, and it is what makes the board
trustworthy. `To Do` / `On Deck` are a promise that the thinking is finished. A
ticket in `To Do` that is really still an idea is a lie the board is telling you.

Nothing sweeps the board for you, so the rule is upheld at the two doors:
`plan-ticket` will not land a ticket right of `To Plan` until `to-prd` has run,
and `implement` refuses to build a ticket that has no PRD. If you find one that
slipped through anyway, move it back to `To Plan` yourself and say why.

**A ticket "has a PRD"** when its description carries the `to-prd` template — in
practice, look for a `## Problem Statement` heading *and* an `## Acceptance Criteria`
heading. A wall of prose, however long and however lovingly written, is **not** a PRD.

### Trivial tickets keep the rule, cheaply

A **trivial** ticket (see [ROUTING.md](./ROUTING.md)) is smaller than a ticket: an
obvious fix with nothing left to decide, landing in one commit. It still gets a PRD,
because the rule holds — but a **two-line** one. One sentence of problem, one testable
acceptance criterion. Both headings present, so the rule is satisfied by inspection
and `implement` will take it.

It gets **no sub-tasks**. The ticket is the sub-task. It carries the `trivial` label,
which is what lets a batch run find them, and it goes to `To Do` — a trivial ticket
with a decision left in it was never trivial.

This is not a hole in the integrity rule, it is the rule costing what it should. The
promise `To Do` makes is that the thinking is finished; on a typo fix the thinking
really is finished. What gets skipped is the paperwork, never the thought.


## The decision rule — what separates `To Do` from `On Deck`

> **A ticket goes to `To Do` if the next thing to do in it can be built without
> asking you anything. Otherwise it goes to `On Deck`.**

The unit that carries this is **the sub-task**, not the whole ticket. `to-issues`
classifies every sub-task **AFK** (decision-free — an agent can just build it) or
**HITL** (needs your judgment: a design call, a taste call, a product call).

**Walk them in dependency order.** A sub-task is *reachable* if it is AFK **and**
every sub-task blocking it is Done or itself reachable. A HITL sub-task is never
reachable, and neither is anything sitting behind one. So a ticket whose sub-tasks
run AFK, AFK, HITL, AFK has two reachable — and the third is where it stops.

- **First sub-task reachable → `To Do`.** There is real work to start on.
- **Nothing reachable** — every sub-task is HITL, or the only AFK ones sit behind a
  HITL one → **`On Deck`.** It needs you before it needs a builder.

Classify honestly. If a sub-task says "pick a sensible layout" or "decide how errors
surface," it is **HITL**, however small it looks. Mislabelling one `afk` doesn't cost
a column — it costs a confident guess built on your behalf. When in doubt, `On Deck`.

**A trivial ticket has no sub-tasks to classify**, so read the rule against the ticket
itself: it qualified as trivial precisely because nothing in it needs you. It is AFK by
definition and goes to `To Do`. If you find yourself wanting to mark one HITL, it was
misrouted — send it back to `To Plan` and grill it properly.

A ticket in `To Do` may still stop part-way through: `implement` builds what it can
reach, and when it hits a genuine decision it stops and asks rather than guessing.

## The lifecycle

```
   scratch idea / create-epic Feature / hand-written ticket / bug
                              │
                              ▼
                          [To Plan]
                              │
                        /plan-ticket
                              │
              ┌───────────────┴───────────────┐
              │                               │
    next step buildable              next step needs
       without you?                        you?
              │                               │
              ▼                               ▼
          [To Do]  ◀────── decision made ──── [On Deck]
              │                               │
              └───────────────┬───────────────┘
                              │
                         /implement
                              │
                   [In Progress] → [In Review] → [Done]
```

## The merge queue

`implement` ends at **In Review**: branch pushed, PR open. It does not merge, and it
does not move a ticket to Done. That is the **merge queue's** job — one agent per
space, opened from the board, running in its own worktree on an `integration`
branch. It reads what is In Review, checks each branch against main, picks an
order (smallest and cleanest first, dependencies before dependants, conflicts
last), merges one at a time, runs the tests, pushes main, and moves the ticket to
**Done**. It is the only agent allowed to.

- A ticket labelled **`hold`** stays out of the queue until the label goes.
- A PR with changes requested or a failing check is skipped, and the queue says why.
- A conflict that needs the author's judgment goes back to the ticket's agent as a
  **note** — the queue can put a line into another ticket's conversation. The
  author rebases in its own worktree, pushes, and the queue tries again next round.

**Shared resources.** Several agents run on one machine. The board takes turns for
them: a command that matches a shared pattern (the test suite, a build) waits until
the resource is free and holds it until the command ends. Agents can `claim` and
`release` anything else by name. The card reads **waiting its turn** while it waits.

## Bugs

Bugs are level-0 tickets like any other. They land in **`To Plan`** and are routed
by `plan-ticket` to `/diagnose` — reproduce *first*, then spec, then onto the board.
There is no separate triage lane; the board **is** the triage.

**Parent a bug to an epic when it must be fixed before that epic can ship** — a
defect in the thing being built is part of shipping it, and an epic whose known
bugs are invisible from the epic is lying about how close it is. Otherwise leave
it standalone: a drive-by defect in unrelated code belongs to no objective.

Bugs still get **no due date**. Even a release-blocking one is reactive work —
it's dated by the epic it blocks, not on its own.

## Investigation tickets

`create-epic` produces **investigation tickets** that resolve a *decision*, not
a deliverable — labelled `investigation`, summary prefixed `[research]` /
`[prototype]` / `[grill]` / `[task]`.

These are level-0 tickets and **do** sit on the board, in `To Plan` or `On Deck`.
But they are the one exception to the integrity rule: **an investigation ticket
never gets a PRD**, because its output is a decision comment, not code. They are
closed by `/plan-ticket`, which routes each one by its prefix and posts the
decision as a comment — never by `implement`. They never enter
`To Do` — deciding is not decision-free work, so it is always yours.

So don't judge one against the integrity rule — a missing PRD is correct here.
An investigation ticket sitting in `To Do` is the thing to flag.
