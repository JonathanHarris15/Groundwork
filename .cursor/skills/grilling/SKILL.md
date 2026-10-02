---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

Ask about **outcomes**, not mechanisms. Every question you put to the user must be answerable from what they want the thing to _do_ — "should it behave like this, or like this?" — never from knowing how the code or the data is laid out. Assume the user is not intimate with the implementation and has no wish to be. If a question can only be answered by someone who has read the code, that is your question to answer, not theirs: go and read it, or reframe it as the outcome it is really about.

The **implementation is yours**. When two implementations reach the same agreed behaviour, don't put the choice to the user — deciding it is the expertise they came for. Pick the better one, say which in a line, and carry on. The exception is a choice with a consequence they would actually feel: money, a speed difference they would notice, something hard to reverse, or something that closes off a direction they may want later. That is no longer an implementation question, it is an outcome question wearing implementation clothes. Reframe it around the consequence and ask _that_.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
