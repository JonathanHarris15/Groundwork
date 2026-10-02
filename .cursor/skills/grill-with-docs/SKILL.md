---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Grill With Docs

Run a **`/grilling`** session, using the **`/domain-modeling`** skill throughout.

That's the whole skill. `grilling` owns the interrogation — the design tree, the rounds,
the recommended answer on every question. `domain-modeling` owns the paperwork — challenging
terms against `CONTEXT.md`, sharpening fuzzy language, and writing the glossary and ADRs the
moment a decision crystallises rather than batching them to the end.

Two things this composition adds on top:

- **Docs are updated inline, not afterwards.** A term resolved in round three goes into
  `CONTEXT.md` in round three. Batched documentation is documentation that never happens.
- **When the plan is fog rather than a plan**, the first round has nothing to interrogate,
  so lead with your own reading: name the two or three genuinely different things the work
  could mean, say which you'd back and why, and let the user react. Reacting is far easier
  than inventing. Once the change has a name, grill it normally.
- **The implementation calls you make yourself still get written down — sometimes.** `grilling`
  says a choice between two implementations that reach the same agreed behaviour is yours, not
  the user's. That doesn't make it invisible. Run it past the ADR test: hard to reverse,
  surprising without context, a real trade-off with genuine alternatives. All three, and it
  earns an ADR even though nobody was asked. Fewer than three, and it's just work — do it and
  say what you did. That same test is also how you check you were right not to ask: a call that
  passes it is usually one the user would have wanted framed as an outcome and put to them.
