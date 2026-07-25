# Architecture Index — find the right section, don't read everything

`ARCHITECTURE.md` is long (~1200 lines). This file exists so you can jump
straight to the one section (or one `src/` file) you actually need instead
of reading the whole thing. Look up your task below, go read only what it
points to. If nothing here fits, read `ARCHITECTURE.md` section 1-2 first
(what this project is, the three-layer architecture), then search its
headings for your topic.

## "I need to..." → go read

| Task | File(s) to open | `ARCHITECTURE.md` section |
|---|---|---|
| Understand what this project is at all | — | §1 (start here if you've read nothing else) |
| Understand the 3-layer architecture (pure/impure/webview) | — | §2 |
| Add/change a `JobDefinition` or `ToolDefinition` field | `src/types.ts`, then `src/jobStore.ts` (`normalize`/`updateJob`/`addJob`/`duplicateJob` — **all four must be updated**) or `src/toolStore.ts` | §4.1, §5.3 |
| Understand the two persisted `.vscode/*.json` files | `src/jobStore.ts`, `src/toolStore.ts` | §4.2, §5.3 |
| Understand `${param:X}` / `${randomSeed}` / `${var:X}` | `src/paramSubstitution.ts`, `src/paramVars.ts` | §4.3, §5.10 |
| Understand why the Tool builder writes into Command | `src/jobConfigPanel.ts` (`builderOwns`/`onBuilderChange`/`refreshBuilderUI`) | §4.4, §6.2 |
| Fix/extend the extension entry point, a command, a menu | `src/extension.ts`, `package.json` (`contributes.commands`/`menus`) | §5.1, §7 |
| Fix a bug in **running/spawning/killing** a job | `src/jobRunner.ts` (the big one) | §5.4 (has sub-sections 5.4.1–5.4.8, read the matching one) |
| Fix a **window-reload / reattach** bug | `src/jobRunner.ts` (`beginReattachment`/`startReattachment`/`pollReattachment`), `src/reattach.ts`, `src/procStat.ts` | §5.4.3 |
| Fix a **kill/Stop** bug | `src/jobRunner.ts` (`stop`/`advanceKillSchedule`), `src/killPlan.ts` | §5.4.4 |
| Fix a **finish()/status race** bug | `src/jobRunner.ts` (`finish`) | §5.4.5 — read this before touching lifecycle order |
| Fix **output→parser wiring / parse cap** | `src/jobRunner.ts` (`feedChunk`/`feedLines`), `src/logParser.ts` | §5.4.6, §5.8 |
| Fix a **post-run command** bug | `src/jobRunner.ts` (`runPostRunCommand`) | §5.4.7 |
| Fix the **sidebar tree / drag-and-drop** | `src/treeProvider.ts`, `src/jobOrder.ts`, `src/folderOrder.ts` | §5.5 |
| Fix **log storage, retention, or reads** | `src/logManager.ts`, `src/logRetention.ts`, `src/logsRoot.ts` | §5.6 |
| Fix the **Problems panel** | `src/logDiagnostics.ts` | §5.7 |
| Add support for a **new EDA tool's output format** | `src/logParser.ts` (the one place with tool-specific pattern knowledge) | §5.8 |
| Fix **live log tailing** (any kind) | `src/tailer.ts` | §5.9 |
| Fix **pass/fail decision logic** | `src/jobOutcome.ts` | §5.10 |
| Fix **seed detection** (Log Viewer Seed column) | `src/seedDetect.ts` **and** its client-side mirror in `src/toolSetupPanel.ts` (`detectSeedPreview`) | §5.10, §6.3 |
| Fix **`--help` output parsing / favorites / choices** | `src/toolOptionParser.ts` | §5.10 |
| Fix **value lists** (test dropdowns) | `src/listSource.ts`, `src/types.ts` (`ToolList`) | §4.1, §5.10 |
| Fix **shell invocation** (bash/tcsh/csh args, `${command}` token) | `src/shellInvocation.ts` | §5.10 |
| Fix **tool scanning / probing** (spawns `--help`) | `src/toolIntrospect.ts` | §5.11 |
| Fix **"Use My VS Code Terminal Shell"** detection | `src/shellDetect.ts` | §5.11 |
| Fix the **status bar** | `src/statusBar.ts` | §5.11 |
| Fix **`.gitignore` auto-entry** prompt | `src/gitignoreManager.ts` | §5.11 |
| Fix the shared **"(?)" help-icon tooltip** | `src/webviewHelp.ts` | §5.11 |
| Change **any of the 5 webview panels** (UI/behavior) | the matching panel file — see table in §6 | §6.1 (universal conventions — read first), then §6.2/6.3/6.4 |
| Add a new **high-frequency toggle** to a panel (avoid full re-render) | `src/toolSetupPanel.ts`'s favorite-toggle (`wire('[data-fav-id]', ...)`) as the template | §6.3, §10 item 7 |
| Add a **new pure/testable module** | any file in §5.10 as a template, + `test-fixtures/run-<name>-tests.mjs` | §5.10, §8.2 |
| Run tests / verify a change before calling it done | — | §8.2, §8.4 (exact command sequence) |
| Understand/extend the **visual-test harness** for webviews | `scripts/render-webviews.mjs`, `scripts/screenshot-webviews.mjs` | §8.3 |
| Add/change a **VS Code setting** | `package.json` (`contributes.configuration`) | §7 |
| Release, tag, or publish (private repo, public repo, Marketplace) | — | §9 — **check `git tag`/`gh run list`/`vsce show` directly first, don't trust a stale doc claim** |
| "What's the house style / conventions I should follow?" | — | §10 — read this before any nontrivial change |

## File → one-line purpose (alphabetical, all of `src/`)

Use this when you already have a filename (e.g. from a grep or stack trace)
and just want a one-line reminder of what it does before opening it.

| File | Purpose |
|---|---|
| `extension.ts` | Entry point: `activate()`, wires every singleton + command |
| `folderOrder.ts` | Pure: drag-and-drop folder reordering |
| `gitignoreManager.ts` | One-time-per-workspace `.gitignore` logs-root prompt |
| `jobConfigPanel.ts` | Webview: Add/Configure Job panel (biggest panel file) |
| `jobOrder.ts` | Pure: drag-and-drop job reordering |
| `jobOutcome.ts` | Pure: pass/fail/killed decision precedence |
| `jobRunner.ts` | The job execution engine — spawn, capture, status, kill, reattach (biggest file overall) |
| `jobStore.ts` | Owns `.vscode/eda-jobs.json` (load/watch/normalize/persist) |
| `killPlan.ts` | Pure: kill-signal escalation schedule |
| `listSource.ts` | Pure: value-list line parsing + insert-template substitution |
| `logDiagnostics.ts` | Problems-panel `DiagnosticCollection` owner |
| `logFollow.ts` | Auto-scroll a followed job's open log editor tab |
| `logIndex.ts` | Pure: parse a log file's own header/trailer/filename (no separate index exists) |
| `logLiveView.ts` | Read-only live-tail Pseudoterminal for an arbitrary file |
| `logManager.ts` | Log file storage location, retention pruning, cached reads |
| `logParser.ts` | Streaming EDA-tool-output → structured issues (UVM/Questa/Icarus/DSim/Verilator) |
| `logRetention.ts` | Pure: which log files to delete (count/size caps, batch-family-aware) |
| `logsRoot.ts` | Pure: resolve the effective logs-storage root path |
| `logViewerPanel.ts` | Webview: cross-job past-runs table, filter/search |
| `paramsPanel.ts` | Webview: global `${var:NAME}` name/value editor |
| `paramSubstitution.ts` | Pure: `${param:NAME}` / `${randomSeed}` |
| `paramVars.ts` | Pure: `${var:NAME}` silent substitution |
| `procStat.ts` | Pure: parse `/proc/<pid>/stat` field 22 (start time, for pid-identity checks) |
| `reattach.ts` | Pure: decide a reattached (post-reload) job's final state |
| `seedDetect.ts` | Pure: guess/extract a run's seed from captured output |
| `shellDetect.ts` | Detect VS Code's own integrated-terminal shell |
| `shellEnvPanel.ts` | Webview: Shell & Environment settings + log retention + clean-all |
| `shellInvocation.ts` | Pure: per-shell-family argv assembly, `${command}` token, env/var substitution |
| `statusBar.ts` | Status-bar "job running" indicator |
| `tailer.ts` | `FileTailer` — polling `tail -f` (used 3 independent places) |
| `toolIntrospect.ts` | Spawns a tool's `--help` / list-source command, impure half of tool scanning |
| `toolOptionParser.ts` | Pure: `--help` text → flags, favorites-merge, choices, subcommand detection |
| `toolSetupPanel.ts` | Webview: register/edit tools, flags, favorites, lists, seed pattern |
| `toolStore.ts` | Owns `.vscode/eda-tools.json` (load/watch/normalize/persist) |
| `treeProvider.ts` | Sidebar `TreeDataProvider` + drag-and-drop controller |
| `types.ts` | Every shared interface/type — no logic |
| `webviewHelp.ts` | Shared "(?)" hover-tooltip icon CSS + helper, used by all 5 panels |

## Root-level docs → what's in them

| File | What it's for |
|---|---|
| `ARCHITECTURE.md` | Full exhaustive reference — read via this index, not linearly, unless you're new to the whole project |
| `ARCHITECTURE_INDEX.MD` | This file |
| `LLM_WELCOME.MD` | Short orientation for a fresh/small-context session — read this FIRST if you've read nothing else at all |
| `PLAN.md` | Authoritative phased backlog + "Locked decisions" (design rules that must not be violated) |
| `STATUS.md` | Last-session handoff: exact tag, what shipped, what's unresolved — re-read every session, it changes often |
| `CHANGELOG.md` | User-facing per-version changelog |
| `README.md` | Public-facing feature list (what a *user*, not a maintainer, needs) |
