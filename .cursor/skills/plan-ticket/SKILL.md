---
name: plan-ticket
description: Take a ticket from the To Plan column all the way to the board — read how big and how formed it is, route it down the right lane (trivial fast path, research / prototype / grill / diagnose, or escalate a whole project to create-epic), then converge on a PRD and sub-tasks and land it in To Do or On Deck. The front door of the JIRA workflow. Use with a ticket key (/plan-ticket PROJ-48), a count to plan the N smallest (/plan-ticket 10), or ALL for the whole column. Project key is never hardcoded — read CLAUDE.md or discover via Atlassian MCP (Groundwork is not Mosaic MS-*).
argument-hint: "A JIRA ticket key (e.g. PROJ-48 — use this repo's project key from CLAUDE.md or Atlassian MCP), a count for the N smallest (10), or ALL for the whole To Plan column"
---

# Plan Ticket

> **Operator.** This skill is run by Cursor Cloud Agents. Grok Bot is the project owner: it answers routine questions for Jonathan and escalates only crucial decisions.

The **front door**. Everything in `To Plan` comes through here and leaves specced, sliced,
and sitting in the right column.

Read [BOARD.md](./BOARD.md) (the contract you're upholding) and
[ROUTING.md](./ROUTING.md) (the judgment call you're making) before you start.

**The premise:** `To Plan` is a genuine inbox, and things land in it at wildly different
stages of formulation. A title you scratched down mid-feature. A Feature `create-epic`
emitted with a loose brief. A long ticket you wrote by hand on a good day and half-forgot.
A bug. They are not the same problem and they must not get the same treatment — the whole
skill is about **reading which one you're holding** before you start working it.

## Phase 0: Gate

Read the project's `./CLAUDE.md` and find the `<!-- jira-config -->` block. Take the cloudId,
project key, and the **real issue-type names** from it.

**No block?** Then discover it once, here, before planning anything — the discovery steps are
in [JIRA.md](./JIRA.md), and the rule that matters is **never guess a project key**. Map the
types and statuses you find onto the three levels and six columns in [BOARD.md](./BOARD.md),
then offer to write what you found into the project's `CLAUDE.md` as a `<!-- jira-config -->`
block so the next run doesn't repeat the work. If the Atlassian tools aren't connected at all,
say so and stop — there is nothing to plan against.

Load the tools per [JIRA.md](./JIRA.md) — Atlassian MCP on Cursor Cloud Agents, not Claude
`ToolSearch`. Beyond the usual set you need `createJiraIssue`, `getTransitionsForJiraIssue`,
`transitionJiraIssue`, `createIssueLink` and `getIssueLinkTypes`.

---

# Single ticket: `/plan-ticket PROJ-48`

## Phase 1: Read it

`getJiraIssue` with `summary, description, issuetype, status, labels, parent, issuelinks,
comment, subtasks`.

**Sanity-check it's actually in `To Plan`.** If it isn't:
- Already right of `To Plan` **with** a PRD → it's already planned. Say so, show what's on
  it, and ask if they want to re-plan (which means overwriting the PRD — confirm explicitly).
- Right of `To Plan` **without** a PRD → the board is lying. Plan it anyway, and say so —
  something moved it there without doing the thinking.

Then **explore the codebase** before forming any opinion. Read `CONTEXT.md` (the glossary)
and `docs/adr/`; if a `CONTEXT-MAP.md` exists, follow it to the right context. A ticket that
looks foggy in isolation is often perfectly clear once you see the code it lands in — and a
question you could answer by reading the repo is a question you must never ask the user.

## Phase 2: Read the two dials

Apply [ROUTING.md](./ROUTING.md). Two dials, **size first**:

1. **Size** — is this one deliverable, a whole project, or a pile of unrelated things?
2. **Clarity** — fog / unknowns / sharp / already-specced. (Bugs skip this — they go to
   `/diagnose` to be reproduced first.)

## Phase 3: Say what you see, and get agreement

**Do not silently start a lane.** Tell the user what you read and where you're taking it:

> **PROJ-48 — "Make onboarding less painful"**
>
> This is one deliverable, not a project — it lives entirely in the signup flow.
>
> But it's **fog**. It names a feeling, not a change: there's no statement of what "less
> painful" means, and I can't find a definition of done anywhere in it. The code has three
> plausible places this could mean — the email verification round-trip, the six-field form,
> or the empty first-run state — and they'd be completely different pieces of work.
>
> **I'd take this to `/grill-with-docs`**, starting wide — first question is which of those
> three is the itch you were actually scratching, and I'll say which one I'd back. Once we
> have the change named, we sharpen it. Roughly 15 minutes.
>
> Sound right, or do you already know which one you meant?

Give a **recommendation with reasoning**, not a menu. If the user overrides you ("no, just
grill it, I know what I want"), take the override — but if you think they're wrong, say so
once, then do as they say.

## Phase 4: Run the lane

| Read | Run |
| --- | --- |
| **Trivial** | Smaller than a ticket — obvious fix, nothing to decide, one commit. Skip the lanes entirely: write the **two-line PRD** (`/to-prd` short form), add the `trivial` label, no sub-tasks, land it in `To Do`. See [ROUTING.md](./ROUTING.md). If it stops looking trivial while you write those two lines, say so and reroute. |
| **An investigation ticket** | Labelled `investigation`, summary prefixed `[research]` / `[prototype]` / `[grill]` / `[task]`. Resolve it by its prefix: `[research]` → `/research`, `[prototype]` → `/prototype`, `[grill]` → `/grill-with-docs`, `[task]` → just do the small thing. The output is a **decision**, not code. Post the decision as a comment (what we decided and why, linking any research or prototype asset), close the ticket, and **stop — skip Phase 5 and 6 entirely.** See [BOARD.md](./BOARD.md). |
| **A project, not a ticket** | `/create-epic`. The epic's Features land back in `To Plan` as fresh tickets. Close PROJ-48 with a comment linking the epic — it did its job. **Stop here**; the new tickets each come through `plan-ticket` on their own. |
| **A pile** | Split into sibling tickets in `To Plan`, close the original, then plan each. |
| **Bug** | `/diagnose` — reproduce and find the cause. Then re-read the clarity dial; usually the cause makes the fix obvious → go straight to Phase 5. If it won't reproduce, park it in `To Plan` with what you found and say what you need. |
| **Fog** | `/grill-with-docs`, opened wide — name the change before sharpening it. Say out loud that you're starting from nothing. |
| **Unknowns (facts)** | `/research` → then `/grill-with-docs`. |
| **Unknowns (feel)** | `/prototype` → then `/grill-with-docs`. |
| **Sharp** | `/grill-with-docs`. **The default lane.** |
| **Already specced** | Straight to Phase 5 — but only after honestly hunting for one question whose answer would change the PRD. If you find one, it wasn't this lane. |

Lanes **flow into each other**. A grilling that surfaces a factual unknown hands to research;
research that resolves it hands back to grill. Passing through two or three is normal, not a
failure — just say when you're moving between them.

**Placement.** Before you converge: if the ticket has no epic parent, ask which epic it
belongs under, or confirm it's genuinely standalone (bugs and one-off chores usually are).
Don't invent an epic for a one-off.

## Phase 5: Converge

Always both, in order, whatever lane it took — with two exceptions. An **investigation
ticket** never reaches this phase: its output is a decision comment, not a PRD. A **trivial**
ticket runs `to-prd` in its short form and stops there — no sub-tasks, because the ticket is
the sub-task.

1. **`/to-prd`** — writes the PRD onto **this ticket's own description**. The ticket *is* the
   PRD; there's no separate doc.
2. **`/to-issues`** — creates the real **sub-tasks** under it. These don't get board columns;
   they show as a progress count inside the card, which is what lets you glance at a To Do
   ticket in the morning and see it got 4 of 7 done before it stalled.

## Phase 6: Land it

Now make the call that decides who does this work. Apply the AFK-safety rule from `BOARD.md`
**strictly** — and note the question it asks is *not* "is this ticket entirely AFK?" but **"can
an agent do any real work here without deciding anything?"** Compute the ticket's
**AFK-reachable set**: the AFK sub-tasks whose blockers are all Done or themselves reachable.
Anything HITL, and anything sitting behind a HITL sub-task, is out of reach.

- **`To Do`** — a PRD with pass/fail criteria, sub-tasks that each name what they build,
  **a non-empty AFK-reachable set**, and no open blockers. Mixed tickets belong here:
  `implement` builds what it can reach and stops to ask at the first real decision, with the
  mechanical half already done.
- **`On Deck`** — ready, but **the next step needs you**. Every sub-task is HITL, or the AFK
  ones all sit behind a HITL one, so there is nothing to start on. **Yours.**

The classification that matters most is **per sub-task**, not per ticket. A HITL sub-task no
longer condemns the whole ticket — but a HITL sub-task *mislabelled AFK* is worse, because a
builder walks straight into it believing it's mechanical. When in doubt, call it HITL.

**Recommend, with the reason, then confirm before moving:**

> Specced. PROJ-48 has a PRD and 5 sub-tasks.
>
> I'd put it in **To Do** — sub-tasks 1, 2, 4 and 5 are mechanical and can be built straight
> through. It'll stop at sub-task 3, "surface the verification error inline," because there's
> no right answer to *how* that should look and it shouldn't invent one. You'd get four of five
> done, and one question to answer.
>
> (If sub-task 3 blocked the others, it'd be On Deck instead — but it doesn't.)
>
> Move it to To Do?

Transition with `getTransitionsForJiraIssue` → `transitionJiraIssue`. **Never assume a
transition exists**; if there's no valid path from the current status, say so and stop.

Report: the key, its new column, the sub-task count, and why it landed where it did.

---

# Batch: `/plan-ticket 10` or `/plan-ticket ALL`

Same skill, but you **queue first and work second** — so the user sees the whole shape before
committing an afternoon to it.

A number takes that many, **smallest first**. `ALL` takes the column. A number is the usual
call: small tickets arrive constantly from clients and error reports, and clearing ten of them
is a better morning than half-planning thirty.

## Phase A: Survey

```
project = <KEY> AND status = "To Plan" ORDER BY created ASC
```

Read every one, even when a count was given — you cannot pick the ten smallest without
looking at all of them. Explore the codebase **once**, up front: the context is shared across
all of them and re-reading it per ticket is waste.

## Phase B: Classify all of them

Run **Phase 1 and 2** (read + two dials) on every ticket. Do not run any lane yet. This is
cheap and it's what makes the queue honest.

Dispatch a **subagent per ticket** to do the reading and classification in parallel — they're
independent, and a column of thirty is otherwise a long silent wait. Each returns: size,
clarity, proposed lane, whether it's **trivial**, and the one-line reason. You make the final
call.

Be strict about trivial here, not generous. The cost of calling a real ticket trivial is a
half-thought change built without you; the cost of the reverse is ten minutes. When the two
readings are close, it is not trivial.

## Phase C: Show the queue

**Order smallest first.** Trivial tickets at the top, then sharp, then unknowns, then fog,
then anything escalating to an epic. Two reasons: you get the satisfying part done while your
attention is fresh, and the cheap ones often teach you something that changes how you grill
the expensive ones.

The one exception is a blocking edge — if planning A would change what B even is, A goes
first whatever its size. Say so when you reorder for it.

| Ticket | Summary | Read | Lane | You needed? |
| --- | --- | --- | --- | --- |
| PROJ-53 | Typo on the invoice footer | **Trivial** | two-line PRD | No — ~1m |
| PROJ-54 | Retry count hardcoded to 3 | **Trivial** | two-line PRD | No — ~1m |
| PROJ-50 | Add `--json` to the CLI | Specced | straight to `to-prd` | No |
| PROJ-49 | Duplicate rows on import | Bug | `/diagnose` | Only if it won't repro |
| PROJ-52 | Retry failed webhooks | Sharp | `/grill-with-docs` | Some — ~10m |
| PROJ-48 | Make onboarding less painful | Fog | `/grill-with-docs` (wide) | Yes — ~15m |
| PROJ-51 | Rework the sync engine | **Project** | `/create-epic` | Heavily — ~45m |

Then give the real total: *"Four of these need nothing from you. The other three are about
70 minutes of your attention. All of them, the cheap ones only, or a subset?"* **Let them cut
the queue before you start.** Seeing that one scratch note is secretly a three-week project is
often the most valuable thing this skill produces, and they may want to stop right there.

## Phase D: Work the queue

**Trivial tickets first, and run them straight through** — read, two-line PRD, `trivial` label,
`To Do`. Don't narrate each one; a single line per ticket is plenty. Ten of these should take
minutes, not an hour. If one turns out not to be trivial, move it down the queue to its real
lane and carry on.

Then the rest, one at a time, in order, **interactively** — Phases 3→6 per ticket. This part is
not unattended: grillings are conversations, and batching them wouldn't make them faster, just
worse.

After each ticket lands, show a one-line progress marker (*"3 of 6 done — PROJ-52 → On Deck"*)
and carry straight on. **Don't ask permission to continue** between tickets; they already
approved the queue. Do stop and ask if a ticket turns out to be something the queue didn't
predict — a "sharp" one that's actually fog, or a ticket that turns out to be a project.

At the end: what landed where, what's left in `To Plan` and why, and anything the planning
surfaced that wants its own ticket. If trivial tickets landed in `To Do`, say so and remind
them those can be built unattended with `/implement ALL`.
