## Summary

<!-- The smallest visual that makes the change clear: a diagram, diff-sketch, call tree, or file tree (see .cursor/skills/pr/SKILL.md) -->

## Evidence

<!-- Before and after: screenshots for visual changes, otherwise the failing then passing test run or output. List the automated checks you ran (e.g. `npm test`). -->

- **Before:**
  **After:**

## Smoke test

<!-- Required for user-visible UI changes (.cursor/rules/smoke-test.mdc). For infra-only PRs, write N/A with a one-line reason. -->

- [ ] jev/fastbrowse smoke run against `http://127.0.0.1:8787` (after `npm run server`), **or**
- [ ] `jev smoke test skipped: key(s) absent` / `jev smoke test skipped: uv unavailable`, **or**
- [ ] N/A — no user-visible UI effect (explain):

**Evidence (when run):** commands, JSON `status`, quoted visible copy from the page, approximate cost.

## Merge Danger

**Door:** <!-- one-way or two-way -->

**Blast Radius:** <!-- one word, then any ramifications of merging -->
