---
name: improve-codebase-architecture
description: Find deepening opportunities in a codebase, informed by the domain language in CONTEXT.md and the decisions in docs/adr/. Use when the user wants to improve architecture, find refactoring opportunities, consolidate tightly-coupled modules, or make a codebase more testable and AI-navigable.
---

# Improve Codebase Architecture

Surface architectural friction and propose **deepening opportunities** — refactors that turn shallow modules into deep ones. The aim is testability and AI-navigability.

**Get the vocabulary first.** Call the Skill tool with "codebase-design" before you explore. It is the single source of the module, interface, depth, seam, adapter, leverage and locality terms, and of the deletion test and seam discipline. Use those words exactly in every suggestion — consistent language is the point, so don't drift into "component", "service", "API", or "boundary". This skill assumes that vocabulary throughout and never restates it.

This skill is also _informed_ by the project's domain model. The domain language gives names to good seams; ADRs record decisions the skill should not re-litigate.

**Where the output goes.** This skill *generates work* — it doesn't do it. If the project is linked to JIRA (a `<!-- jira-config -->` block in its `CLAUDE.md`), offer to file each agreed opportunity as a ticket in the **`To Plan`** column, one per refactor, with what you found and why it matters. They then come through `/plan-ticket` like anything else. Don't file them further right than `To Plan` — a refactor you've named is not a refactor you've specced. Don't file the ones the user didn't agree with.

## Process

### 1. Explore

**Scope before you scan — YAGNI.** Deepening a module pays off by making *future* changes to it easier, so weight the parts of the codebase that have recently changed. Decide *where* to look before you look:

- If the user named a direction — a module, a subsystem, a pain point — take it, and skip the inference below.
- Otherwise, walk back a good stretch of the commit history (`git log --oneline`) to find the hot spots — the files and areas that keep coming up — and let those paths pull your attention first. If the changes are scattered with no clear hot spot, widen the net.

Read the project's domain glossary (`CONTEXT.md`) and any ADRs in the area you're touching first.

Then use the Agent tool with `subagent_type=Explore` to walk the codebase. Don't follow rigid heuristics — explore organically and note where you experience friction:

- Where does understanding one concept require bouncing between many small modules?
- Where are modules **shallow** — interface nearly as complex as the implementation?
- Where have pure functions been extracted just for testability, but the real bugs hide in how they're called (no **locality**)?
- Where do tightly-coupled modules leak across their seams?
- Which parts of the codebase are untested, or hard to test through their current interface?

Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity, or just move it? A "yes, concentrates" is the signal you want.

### 2. Present candidates as an HTML report

Write a self-contained HTML file to the OS temp directory so nothing lands in the repo. Resolve the temp dir from `$TMPDIR`, falling back to `/tmp` (or `%TEMP%` on Windows), and write to `<tmpdir>/architecture-review-<timestamp>.html` so each run gets a fresh file. Open it for the user — `start <path>` on Windows, `open <path>` on macOS, `xdg-open <path>` on Linux — and tell them the absolute path.

The report uses **Tailwind via CDN** for layout and **Mermaid via CDN** for graph/flow diagrams. Mix Mermaid with hand-crafted CSS/SVG — use Mermaid when relationships are genuinely graph-shaped (call graphs, dependencies, sequences), hand-built divs/SVG for editorial visuals (mass diagrams, cross-sections, collapse animations). Each candidate gets a **before/after visualisation**. Be visual.

See [HTML-REPORT.md](HTML-REPORT.md) for the full scaffold, diagram patterns, and styling guidance.

Each candidate card includes:

- **Files** — which files/modules are involved
- **Problem** — why the current architecture is causing friction
- **Solution** — plain English description of what would change
- **Benefits** — explained in terms of locality and leverage, and how tests would improve
- **Before / After diagram** — side-by-side, illustrating the shallowness and the deepening
- **Recommendation strength** — one of `Strong`, `Worth exploring`, `Speculative`, rendered as a badge

End the report with a **Top recommendation** section: which candidate you'd tackle first and why.

**Use CONTEXT.md vocabulary for the domain.** If `CONTEXT.md` defines "Order," talk about "the Order intake module" — not "the FooBarHandler."

**ADR conflicts**: if a candidate contradicts an existing ADR, only surface it when the friction is real enough to warrant revisiting the ADR. Mark it clearly (e.g. _"contradicts ADR-0007 — but worth reopening because…"_).

Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"

### 3. Grilling loop

Once the user picks a candidate, run the **`/grilling`** skill to walk the design tree with them — constraints, dependencies, the shape of the deepened module, what sits behind the seam, what tests survive.

Two references do the technical work here, both reached from the `codebase-design` skill:

- **How to deepen this cluster safely**, given what it depends on — the four dependency categories, seam discipline, and replacing the old tests rather than layering on top of them: `DEEPENING.md`.
- **Whether this is even the right interface** — spin up parallel sub-agents to design it several radically different ways, then compare on depth, locality, and seam placement: `DESIGN-IT-TWICE.md`. Offer this whenever the first interface is the only one anybody has drawn.

Side effects happen inline as decisions crystallize — run the **`/domain-modeling`** skill to keep the domain model current as you go:

- **Naming a deepened module after a concept not in `CONTEXT.md`?** Add the term to `CONTEXT.md`. Create the file lazily if it doesn't exist.
- **Sharpening a fuzzy term?** Update `CONTEXT.md` right there.
- **User rejects a candidate with a load-bearing reason?** Offer an ADR: _"Want me to record this as an ADR so future architecture reviews don't re-suggest it?"_ Only offer when the reason would actually help a future explorer — skip ephemeral or self-evident reasons.
