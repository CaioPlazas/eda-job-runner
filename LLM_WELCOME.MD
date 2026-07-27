# Welcome

You're working in **EDA Job Runner**, a VS Code extension: a tool-agnostic
sidebar for running and tracking EDA (chip/RTL/simulation) compile and
sim jobs — Xcelium, Questa, DSim, Verilator, Icarus, or any custom script —
without leaving the editor. "Tool-agnostic" is load-bearing: this codebase
has **no built-in knowledge of any specific EDA tool's syntax**. A job is
just `{name, command, cwd}` run through a configurable shell; everything
else (seeds, pass/fail, value lists, tool flags) is a generic primitive the
*user* configures, not something hardcoded per-tool. Never special-case a
tool's name anywhere you write code here.

If your context window is small, **stop reading other docs cold and use
these three files as your working set**, in this order:

1. **This file** — you're reading it. Gives you just enough to not break
   anything on a first small change.
2. **`ARCHITECTURE_INDEX.MD`** — a lookup table. Find your task or filename
   in it, and it tells you exactly which file(s) and which
   `ARCHITECTURE.md` section to read — usually just one small section, not
   the whole thing.
3. **`ARCHITECTURE.md`** — the full reference, only read via the index above
   unless you're doing something broad/architectural. It's ~1200 lines;
   don't load it all into context if you only need one piece.

For *current* state (not architecture, which barely changes):

- **`STATUS.md`** — what shipped last session, what's unresolved, the exact
  git tag `main` is at. Re-read this every session; it goes stale fast.
- **`PLAN.md`** — the phased backlog and "Locked decisions" (design rules
  agreed with the user — don't violate these without asking).

## The five things that will save you the most time

1. **The codebase is split into pure logic (no `vscode` import) vs. impure
   orchestrators (own real VS Code API/spawn/fs) vs. 5 webview panels.**
   Bug fixes to *decision logic* almost always belong in a pure module,
   which has a matching test at `test-fixtures/run-<name>-tests.mjs`. Run it
   directly: `node test-fixtures/run-<name>-tests.mjs`.
2. **Before calling any change done, run:**
   ```
   npm run typecheck
   npm run compile
   for f in test-fixtures/run-*-tests.mjs; do node "$f"; done
   npx vsce package --no-dependencies -o /tmp/dry-run.vsix
   ```
   All four should be clean. This is the whole verification bar for this repo.
   If you changed any webview panel's HTML or its inline script, also run
   `npm run webview-check` (needs a locally cached Chromium — see
   `ARCHITECTURE.md` §8.3) and confirm it exits 0.
3. **The entry point is `src/extension.ts`'s `activate()`.** Every command
   is registered there. If you're not sure how a feature is wired together
   end-to-end, start by grepping for its command name in that file.
4. **The two persisted files are `.vscode/eda-jobs.json`
   (`JobDefinition`s, owned by `src/jobStore.ts`) and `.vscode/eda-tools.json`
   (`ToolDefinition`s, owned by `src/toolStore.ts`).** Both are plain
   hand-editable JSON, no database. `src/types.ts` has every field's type
   and a comment explaining it — read that before touching either store.
5. **Never publish, tag, or release anything (this repo, the public mirror
   repo, or the VS Code Marketplace) unless explicitly asked.** If asked,
   see `ARCHITECTURE.md` §9 — and verify actual current state with
   `git tag` / `gh run list` / `vsce show` first; don't trust a status doc's
   claim about what's already been published.

That's the floor. Everything else — exact function names, exact message
schemas, exact race conditions already fixed and why — is in
`ARCHITECTURE.md`, indexed by `ARCHITECTURE_INDEX.MD`. Go there next.
