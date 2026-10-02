---
name: to-issues
description: Slice a specced JIRA ticket (one whose description to-prd has turned into a PRD) into sub-tasks under it, each classified AFK or HITL. Sub-tasks don't get board columns — they become the progress count inside the card. Normally invoked by plan-ticket straight after to-prd. JIRA-native — the breakdown step below a ticket.
argument-hint: "Optional: the JIRA ticket key to slice into sub-tasks"
---

# To Issues (JIRA)

Break **one specced Feature** into independently-grabbable **sub-task Issues** under it. This is the step *below* a Feature: `create-epic` makes the Epic and its high-level **Features**; `to-prd` writes a PRD onto the chosen Feature's description; **`to-issues` slices that Feature into sub-tasks**; `implement` builds each one.

Hierarchy: **Epic → ticket → sub-task**. `to-issues` operates at the bottom edge — it takes a level-0 ticket and creates its breakdown steps as **sub-tasks** (JIRA's sub-task level, −1, the only way a step can nest under a ticket). It does **not** create level-0 tickets (that's `create-epic`, or you scratching an idea into `To Plan`).

**Sub-tasks don't get board columns** — they render as a progress count *inside* the parent card. That count is the point: it's what lets you glance at a ticket and see 4 of 7 are done and which one it stopped on. See [BOARD.md](../plan-ticket/BOARD.md).

You are normally invoked **by `/plan-ticket`**, straight after `to-prd`.

## Process

### 1. Gather context

Resolve the source Feature:
- **Argument is a JIRA Feature key** → read it with `getJiraIssue` (include `description`); its PRD (from `to-prd`) is your input — mine the **User Stories** and **Implementation Decisions** for the breakdown. That Feature is the parent for the new sub-tasks.
- **No argument** → work from context; ask which **Feature** to slice. If the Feature hasn't been specified yet, run `grill-with-docs` then `to-prd` first; if there's no epic/Feature at all, offer `create-epic`.
- **The ticket carries the `trivial` label** → **stop, and don't slice it.** A trivial ticket is the sub-task: it went down the fast lane precisely because there is nothing to break down. Say so and hand back. If it genuinely needs slicing, the routing was wrong — send it back to `/plan-ticket`, don't quietly fix it here.

### 2. Explore the codebase (optional)

If you haven't already, explore to understand the current state. Sub-task titles/descriptions must use the project's `CONTEXT.md` vocabulary and respect ADRs in the area.

### 3. Draft the sub-tasks

The Feature is already a vertical slice (a thin path through the layers). Break it into the **concrete implementation steps** to build that slice end-to-end.

<breakdown-rules>
- Each sub-task is an independently-grabbable, verifiable piece of the Feature.
- Cover the whole Feature: schema/data, API/logic, UI, and tests — whatever layers the slice touches.
- Prefer a handful of meaningful sub-tasks over many trivial ones. Don't over-decompose; a sub-task's own micro-steps go in a checklist in its description (JIRA has no level below sub-task).
- Sequence them by dependency where it matters.
</breakdown-rules>

Classify each sub-task **AFK** (an agent can implement it end to end without a human) or **HITL** (needs human interaction — an architectural decision, a design review). Prefer AFK where possible, but never at the cost of honesty.

This classification is **load-bearing**. It is not a note on the ticket — it is the fence `implement` steers by, sub-task by sub-task. A ticket that mixes AFK and HITL sub-tasks still goes to `To Do`: `implement` builds every AFK sub-task it can reach and stops to ask at the first HITL one. So **the dependency order matters as much as the label** — an AFK sub-task sitting *behind* a HITL one can't be built either, and a ticket where the first sub-task is HITL gives a builder nothing to start on at all.

### 4. Quiz the user

Present the breakdown as a numbered list. For each sub-task show: **Title**, **AFK/HITL**, **Blocked by** (which sub-tasks must finish first), **User stories covered** (from the Feature's PRD). Ask:
- Is the granularity right (too coarse / too fine)?
- Are the dependency relationships correct?
- Should any sub-tasks merge or split?
- Are AFK/HITL classifications right?

Iterate until the user approves.

### 5. Publish to JIRA

Create each approved sub-task under the **Feature**, in dependency order (blockers first) so you can reference real keys in the links. See `<jira-mechanics>`.

Write each sub-task in the **same plain-language register as its Feature**: say what it builds and why in terms a newcomer can follow (define any jargon), and keep the acceptance criteria **specific and measurable** (pass/fail). Use this body template for each sub-task's `description`:

<subtask-template>
## What to build
Concise description of this implementation step — the behaviour it adds to the Feature. No file paths or code snippets (they go stale). Exception: a decision-encoding snippet from a prototype (state machine, reducer, schema, type shape) — inline just the decision-rich part and note it came from a prototype.

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Parent Feature
`PROJ-123` (the Feature this sub-task breaks down; the PRD lives there)
</subtask-template>

Do NOT modify the parent Feature's PRD beyond linking. Report the created sub-task keys as a tree (Feature → sub-tasks).

<jira-mechanics>

See [JIRA.md](../plan-ticket/JIRA.md) for the Atlassian MCP connector, the three levels, and how to create,
link and edit issues. Beyond the usual set, load `getJiraProjectIssueTypesMetadata`,
`createJiraIssue`, `getIssueLinkTypes` and `createIssueLink`.

**Find the sub-task type.** Read the Feature with `getJiraIssue` to confirm it really is
level-0 and to get its `projectKey`, then take the real **sub-task-level** type name from the
project metadata. It is JIRA's `Subtask`, which projects often rename to "Task".

**Create each sub-task** with `parent` = the Feature's key, the description as markdown with
acceptance criteria as a checklist, and labels tagging AFK/HITL plus the epic, e.g.
`{"labels": ["afk", "epic-<slug>"]}`. Keep those label strings consistent with `create-epic`.

**Link sub-task to sub-task**, within this Feature only. A dependency that crosses tickets
belongs at ticket level, and that is `create-epic`'s job, not yours.

**Don't move the parent ticket.** Slicing it doesn't make it ready — deciding whether its next
step needs the user is `plan-ticket`'s Phase 6 call, and your AFK/HITL classifications (plus the
blocked-by links) are the **evidence it uses**: they're what tells it whether there's anything an
agent can start on. A ticket with *no* reachable AFK sub-task goes to `On Deck`; a mixed one goes
to `To Do` and stops part-way. So classify honestly: if a step needs taste, a design call, or a
product judgment, it is **HITL**, however small it looks. Mislabelling one `afk` doesn't cost a
column — it costs a confident guess made on the user's behalf.

</jira-mechanics>
