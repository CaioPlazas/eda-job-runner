# Changelog

## 1.6.0 — Save keeps the window open, and a robustness pass

**Changed:**
- **Saving never closes a window any more.** The Parameters & Value Lists
  screen was the last one that did; it now shows a `Saved ✓` next to the
  button and stays where it is, like every other screen. Only Cancel closes.
- Starting to describe a new value list and then refreshing a *different*
  list no longer throws away what you typed.
- **Live Log** opens at the end of the log instead of replaying the whole
  file into the terminal — it shows the last 16 KB and then streams. On an
  overnight run that replay could hang the window for a long time; the full
  log is still one click away as a normal file.

**Fixes for things that could get stuck:**
- A job still running from before a window reload could be started a **second
  time** from Run Folder, the F5 default-job shortcut, or "Re-run This
  Command" — leaving the original process running with no way to stop it (and
  its tool licence checked out) until it finished on its own. Those paths now
  say it's already running.
- **Stop Folder** put up a "Stop all N running jobs?" confirmation and then
  did nothing at all for jobs resumed after a reload. It now stops them.
- If anything went wrong while a job was being wrapped up (a full disk, an
  unreachable log directory), the job could be left showing **"running"
  forever** — refusing to start again, spinning in the sidebar, and hanging a
  "Run Folder" batch with no way to cancel. Same for a resumed job that
  finished. Both now always reach a real end state and report what failed.
- A run's **last lines could be missed**, which for a job with a pass pattern
  could report a passing run as failed.
- **Tool Setup** could be left behind a permanent "Scanning…" overlay if a
  scan failed in an unexpected way, with no way out but closing and reopening
  it.
- "Clean all logs" could delete the log of a job that was still running, in
  the brief window right after a reload.
- Log searches could miss text that was really there, and a log's header
  could be misread, on network filesystems that return partial reads.

**Faster:**
- Reloading the window while a job with a very large log is running no longer
  freezes the extension: the catch-up read is done in slices instead of
  pulling the whole file into memory at once.
- The **Log Viewer** no longer rebuilds every row on every keystroke in a
  filter box, and expanded job groups stay expanded when you change a filter.
- The sidebar no longer rebuilds itself once a second while it isn't even
  visible, and "Clean all logs" checks file sizes in parallel instead of one
  at a time.
- The Problems panel is no longer rebuilt several times a second while a
  resumed job is producing errors.

**Also fixed:** the "Will run" preview under Command stayed stale after
ticking an option in the tool builder, switching variant, or adding a
parameter override (and with auto-save on, those edits weren't saved either).

## 1.5.0 — Job row click swap, and a real argument-quoting bug fix

**Changed:**
- Clicking a job row now opens **Configure** again, instead of the log.
  The inline icon on the right (previously the Configure gear) is now
  **Open Log** instead. A job's own log is still one click away — it's
  just the icon and the row click that traded places. Unaffected: a
  specific run inside an expanded repeat-count batch still opens its own
  log on click (there's no per-run "configure"), and a batch group header's
  inline icon is still Configure (a group has no single log to open).

**Fixes:**
- A real bug: an option/Custom-Arg value typed into the Job Configuration
  builder (e.g. a tool's `-arguments` flag) got silently cut apart at run
  time if it contained a space, comma, or quote — completely standard for
  verification tool invocations (`+define+FOO=1,BAR=2`, a quoted compile
  arg, a filelist path with spaces). The builder now shell-quotes any typed
  value that isn't a plain bareword before splicing it into the command, so
  it always arrives as the single argument you typed.

## 1.4.1 — Promoted to the stable channel

No code changes from 1.4.0 — the Marketplace won't let the same version
number be republished under a different release channel, so this version
exists purely to carry 1.4.0's already-released functionality onto the
**stable** (non-pre-release) channel for users who aren't opted into
pre-releases.

## 1.4.0 — Easier to repeat, harder to lose

Six follow-ups from the same bug hunt that shipped 1.3.1, this time about
actions you'd want to redo but couldn't without extra manual work.

**New:**
- A repeat-count batch's per-lane run history now survives a window reload
  instead of collapsing to a flat row — a lane still "running" when the
  window closed is shown as interrupted rather than stuck.
- **Re-run Last** is now also an inline hover icon on the job row (next to
  Run/Configure), not just a right-click menu item.
- The job-failure notification now offers a **Re-run Last** button directly,
  alongside Open Log.
- **Open Log History** can now replay a past run's exact recorded command,
  not just view its log.
- Running a folder with more than one job now offers **Retry Failed** when
  some (but not all) jobs failed, instead of requiring a full re-run.
- A **Follow Running Log** or **Live Log** view left open on a still-running
  job now silently reopens after a window reload instead of being lost.

## 1.3.1 — Data-loss and reliability fixes from a systematic bug hunt

A pass over the extension specifically looking for irreversible actions
with no confirmation and no safety net. Nine fixes, all internal
robustness/correctness — no user-facing behavior changes except where noted.

**Fixes:**
- Automatic log retention pruning could unlink a log file a reattached
  (post-reload) still-running job had open, freezing live tailing and
  corrupting the trailer write — it now excludes every currently-live log,
  the same guard the manual "Clean all logs" action already had.
- `.vscode/eda-jobs.json`/`eda-tools.json` writes are now atomic
  (write-temp-then-rename) and serialized, so a crash mid-write can no
  longer corrupt either file, and two overlapping saves can no longer
  silently lose one of them.
- Refreshing a value list (Parameters panel or the "Refresh Value Lists"
  command) no longer wipes a previously-working list to empty on a
  transient scan failure — it keeps the old values on screen alongside the
  new error.
- Double-clicking Save on a brand-new job could create two duplicate job
  entries; fixed with a save-in-progress guard.
- Rescanning two variants of the same tool in quick succession could
  silently discard whichever one's scan landed first; both are now kept.
- Four of five webview panels (Job, Tool Setup, Shell & Environment,
  Parameters) could fail an action (e.g. a disk error mid-save) with
  nothing shown to the user; they now surface an error message like the
  Log Viewer panel already did.
- **Behavior change:** stopping a folder with more than one running job now
  asks for confirmation first, matching the folder-delete confirmation's
  existing "how many jobs does this affect" wording.
- Fixed a performance issue where a long-running detached job with many
  parsed errors could re-stat every error's file on every ~500ms
  reattach-tailer tick, stuttering the UI; file resolution is now cached
  per run.
- Double-clicking Stop before the first kill signal's grace period elapsed
  could start a second, independent kill-escalation sequence; a second
  click now no-ops while one is already in progress.

## 1.3.0 — Tool Setup: "Search deeper" for tools with unusual `--help` formats

Real installed tools like Questa's `qrun`/`vlog`/`vsim`/`vrun` turned out to
use several `--help` conventions Tool Setup's flag scanner had never seen:
flags flush against column 0 or indented past the usual 2-4 spaces, flag
spellings joined with `" / "` instead of a comma, a value placeholder glued
or space-separated as `<angle-brackets>` instead of a bare word, and every
line of output prefixed with `# ` (a Tcl-shell artifact). All were silently
dropped before, with no indication anything had gone wrong.

**Tool Setup:**
- New **Search deeper** button, offered whenever a scan finds zero options.
  It re-parses the help text already captured for that variant with a
  looser set of rules covering the formats above — no re-running the tool.
  Left as an explicit, opt-in action rather than folded into the default
  scan, so well-behaved tools keep exactly the same conservative parsing
  they always have.
- Regression tests built from real captured `qrun`/`vlog`/`vsim`/`vrun`
  output.

## 1.2.0 — Questa's silent false-pass, and Tool Setup rough edges

**Fixes:**
- A real, previously-silent bug: Questa's `vsim`, run in batch/console mode,
  prefixes every transcript line with `# ` — so the parser's `UVM_ERROR`/
  `UVM_FATAL` matchers (anchored to the start of the line) never matched, and
  a genuinely failed Questa UVM test showed as passed. Fixed, with a
  regression test built from real captured `vsim` batch output.
- Enlarged the log viewer's head/tail read cap so a slow-to-print startup
  banner (license checkout, library loads) can't push a run's seed/header
  line out of the captured head.

**Tool Setup:**
- Scan failures now distinguish "command not found" from other launch
  failures, with a specific remedy (check the path, `chmod +x`, or invoke
  through its interpreter).
- A free-text "Retry with this" help-arg input, for a tool whose flag list
  needs a help argument other than `-h`/`--help`.
- New per-tool **Error pattern** (Advanced section): a custom, case-insensitive
  regex tested against every output line — a match counts toward that tool's
  error count and the Problems panel, for tool output that doesn't match any
  of the built-in UVM/Questa/Icarus/DSim/Verilator formats.

## 1.1.1 — Trim back to what earns its keep day to day

v1.1.0's setup-flow overhaul was built for a new user's first run. Used
solo instead, most of that onboarding polish was just in the way — this
release keeps only the pieces that kept paying off after the first day,
and reverts the rest back to how it worked before.

**Kept:** the Test Shell Setup probe console, Tool Setup's self-explaining
scan failures, the job form's "Will run" preview, and `maxConcurrentJobs`.

**Reverted to pre-1.1.0 behavior:**
- Removed the ① Environment → ② Tool → ③ Job stepper, its banners, and
  the inline "How do I fill this in?" recipes from every panel.
- Job form: back to its original field order, with plain Save/Cancel
  instead of Save & Run, no sticky action bar, and the template row
  always shown instead of only once a template exists.
- Removed inline value-list creation from Tool Setup; Parameters &
  Value Lists goes back to explicit Save/Cancel instead of autosave.
- Removed the sidebar's "Create Example Jobs" empty-state offer.
- A job row click reverts to opening the log with a "run it first"
  toast on a never-run job (the inline Configure gear icon stays).
- The status bar reverts to hiding when nothing is running.
- Removed the extra Ctrl+Alt+R/Cmd+Alt+R keybinding (F5 only).
- Removed the "Use My VS Code Terminal Shell" autofill button in Shell
  & Environment — type `shellPath`/`shellArgs` by hand.

**Fixes:**
- The inline Configure gear icon now also shows on a job that has run
  as a repeat-count batch, not just a never-batched job — previously
  the only way back to Configure on those was a right-click, or
  clearing the run history first.
- Starting a fresh single run of a job that previously ran as a batch
  now automatically clears its stale batch history, instead of leaving
  it grouped until a manual "Clear Run History".

## 1.1.0 — The setup flow: ① Environment → ② Tool → ③ Job

A ground-up review of the first-run experience (full findings and design
rationale kept in the project's own planning docs) turned into this
release. The core diagnosis: every panel was a faithful editor for one
JSON structure, when a verification engineer thinks "run my sim, tell me
if it passed" — not "edit my JobDefinition." Setup also has a strict,
code-enforced dependency order (shell → tool scan → job command) that
nothing in the UI expressed, so failures pointed the wrong way. This
release makes that order visible, explains each step inline, and closes
several real dead ends along the way. Nothing existing was removed —
everything advanced stays, it just stops being the first thing in the
way.

**The setup flow.** Shell & Environment, Tool Setup, the job form, and
Parameters & Value Lists now share a stepper (① Environment → ② Tool →
③ Job, plus an optional ④ Parameters outside the arrow chain). Each step
carries a self-erasing banner (what it's for, when to skip it, how you
know you're done — collapses to one line once satisfied) and a "How do I
fill this in?" recipe anchored to a terminal where your tool already
works.

**Verification, not guesswork:**
- **Test Shell Setup** is now a probe console: shows the exact shell
  invocation and working directory, auto-checks every registered tool via
  `command -v`, plus a persistent free-text "Also check" list — all
  through a single shell spawn.
- **Tool Setup scan failures are self-explaining**: the exact probe
  command that ran, which of three distinct causes it was (launch
  failure / printed nothing / printed but nothing parsed), one-click
  `-help`/`-h` retries, and a **[Find it]** button that checks whether
  the command even resolves on PATH before you scan.
- **The job form gets a live "Will run" preview** under Command: resolved
  working directory, shell invocation, and fully substituted command,
  with undefined `${var:NAME}` flagged inline and a one-click **[Define]**
  fix. **[Copy]** and **[Open in terminal ▸]** let you debug with your own
  tools instead of inferring from a log.
- **A new value list can be created inline** from any option's value-
  source dropdown in Tool Setup — no more register-tool → leave-to-
  Parameters → return-to-attach round trip.

**Real bug fixes:**
- A whitespace-only `setup.script` or a blank entry in `setup.commands`
  used to break Tool Setup's Scan and value-list Refresh while the
  identical job ran fine — the three separate places that assembled the
  setup chain disagreed on blank-filtering. Unified into one function,
  with a golden test locking in the previously-correct behavior.
- A repeat-count batch (`runCount: 10`) fired one toast per iteration;
  now fires one summary toast (`"job" finished — N passed, M failed.`)
  unless the batch was stopped by the user.
- The Parameters panel's help text pointed at "the puzzle-piece icon,"
  which doesn't exist — Parameters actually uses a different glyph.

**New in the job list and job form:**
- **Create Example Jobs** — three jobs (pass, fail, a killable slow one)
  needing nothing installed, offered from the sidebar's empty state
  before the real-tool setup steps.
- Single-click on a job row now opens its latest log quietly (no
  "run it first" toast on a never-run job); Configure moved to an
  inline gear icon.
- **Save & Run** is the job form's new primary action, closing the
  create-then-verify loop in one click. Field order reshuffled around how
  people actually think about a job (Name → Command → Tool builder →
  Working Directory → Folder → Default-job checkbox → Parameters →
  Advanced), the template row only appears once a template exists, and
  the action bar is sticky.
- New `maxConcurrentJobs` setting (default `0` = unlimited) replaces the
  `experimentalMultipleRuns` flag — running different jobs side by side
  is table stakes, not something to gate behind an experimental flag.
  Old setting migrates automatically and still works if already set.
- Parameters & Value Lists (renamed from "Parameters") now autosaves
  parameter rows immediately, matching how value lists already behaved.
- Tool Setup now lists registered tools before the (now collapsed)
  add-a-tool form.
- The status bar is now a persistent anchor: shows the last result once
  anything has run, or a neutral placeholder before that, instead of
  disappearing whenever nothing is running.
- `logMaxSizeMB` renamed to `logParseBudgetMB` (old name still works,
  deprecated); `stripAnsiCodes` marked deprecated in the Settings UI.
- Added Ctrl+Alt+R / Cmd+Alt+R as an additional Run Default Job binding
  alongside F5, for workspaces where F5 collides with a debugger.

## 1.0.0 — Stable release

No functional changes from 0.43.0. This release promotes the extension from
the pre-release channel to the stable Marketplace channel: the feature set,
architecture, and test coverage built up over the 0.x series (27 commands, 5
webview panels, process-group job control, log parsing, value lists,
parameters, and a rendered-screenshot regression harness) are considered
stable enough for general use.

## 0.43.0 — Value-list editing, migration collisions, a browser-free CI gate

**Bug fixes:**
- Editing an existing value list's source, pattern, insert template, or
  scan directory silently reverted on the next open — the edit was never
  actually applied, only re-discovery from the unchanged stored record.
  Fixed; an edit or refresh no longer moves the list to the bottom either.
- Adding, refreshing, or removing a value list silently discarded any
  parameter row you'd typed but not yet saved. Fixed.
- Two different tools' value lists sharing the same name could silently
  collide during the one-time migration to global value lists, with one
  tool's option quietly starting to offer the other tool's values. Fixed:
  the second list is now renamed to a unique name, and every reference to
  it (that tool's own option, and any job's per-option override) is
  rewritten to match.

**Features:**
- New "EDA: Refresh Value Lists" command (and a matching "↻ Refresh all"
  button in the Parameters panel), for re-discovering every workspace
  value list at once instead of one at a time.
- A panel that fails to initialize now shows a visible notification
  instead of silently doing nothing — the exact failure mode behind the
  0.42.1 hotfix now always produces a signal, even for a future,
  different bug.

**Under the hood:**
- A second, browser-free crash gate (`test-fixtures/run-webview-smoke-tests.mjs`)
  now runs in CI on every push — it needs no locally-cached Chromium, so
  unlike `npm run webview-check` it actually runs unattended.

## 0.42.1 — Fix: Tool Setup became unresponsive after scanning a tool

**Bug fixes:**
- Tool Setup became completely unresponsive right after a tool's command
  was scanned: the confirmation screen rendered, but Add, Cancel, and even
  Close all silently did nothing, so no new tool could be registered at
  all. Fixed.
- A job's per-option value-list attachment (`optionListOverrides`) could be
  set and saved on a brand-new job, but editing an *existing* job silently
  dropped it on save, and it could never be cleared back to "(default)"
  once set. Fixed — both directions now persist correctly, including
  through Duplicate Job.
- In a workspace with zero value lists, a fixed-choices flag's "✎ var"
  toggle (letting you swap in a `${var:NAME}` reference) was unreachable —
  the only workaround was creating a dummy list. Fixed.
- Expanding an option's ⚙ advanced row and then typing into the flag
  filter could leave that row on screen after its own option scrolled out
  of the filtered list. Fixed.
- If a value list that used to work now reports it cannot find its file or
  command after upgrading from a pre-0.42 workspace, set its scan
  directory in the Parameters panel's Advanced row — it previously
  inherited that directory from the tool it belonged to, and the one-time
  migration to global value lists didn't carry that over. (No automatic
  repair — see this release's notes for why.)
- A value list or job field containing `</script>` could break the
  Configure panel entirely. Fixed.

## 0.42.0 — Global value lists, a leaner option builder, and Browse buttons everywhere

**Features:**
- Value lists are no longer tied to a single tool — they now live in a new
  "Value lists" section on the Parameters panel, so any job can attach any
  list to any tool's option, not just a list that happened to belong to
  the same tool. Each list can optionally set its own scan directory
  (defaulting to the workspace's post-setup working directory, same
  fallback chain a tool's own scan directory already used).
- A native folder/file "Browse…" picker was added to every path-like field
  across all four panels (job Working Directory / Live log file / Post-setup
  working directory / Logs directory override, Tool Setup's Command / Scan
  directory, Shell & Environment's Post-setup working directory / Setup
  script, and the new Value list's file / scan directory) — 13 fields in
  total, replacing the one bespoke picker that existed before (Logs
  Directory) with a shared mechanism.

**Cleanup:**
- A job's per-option "✎ var" toggle and "which list feeds this dropdown"
  picker no longer sit inline on every option row — they collapse behind a
  small ⚙ button that expands them only when needed, so a tool with several
  value-taking options doesn't turn into a wall of controls.

**Bug fixes:**
- A job's per-job value-list attachment (`optionListOverrides`, new in
  0.41.0) was saved correctly but never read back on a window reload —
  it silently reverted to none. Fixed.

## 0.41.0 — Value-list visibility fix, per-job list attachment, real-project example

**Features:**
- A job's Configure form can now attach any of a tool's value lists to any
  value-taking option, for that job only — without touching Tool Setup's
  own (workspace-wide) attachment. Mirrors the existing "✎ var" toggle
  pattern.
- Truncated option/list values now show their full text in a native hover
  tooltip.
- New real-project example: a vendored, unmodified copy of the
  [PicoRV32](https://github.com/YosysHQ/picorv32) RISC-V core with an
  original self-checking testbench, runnable through Icarus, Verilator,
  Questa-FSE, and DSim — see `examples/README.md`.

**Bug fixes:**
- Tool Setup's per-option "value source" dropdown had invisible text in
  dark themes (a missing `background`/`color` on that one `<select>`).

## 0.40.0 — Bug fixes, performance, and a visual-test harness

A focused code-review pass, plus a new internal tool: a headless-Chromium
harness that renders every webview panel's real HTML and screenshots it,
used to visually verify these fixes (dev-only, not shipped in the VSIX).

**Bug fixes:**
- A repeat-count batch no longer self-prunes its own still-running
  iterations under the default log-retention count — a batch's N runs now
  count as one "family" that's kept or removed as a whole.
- "Clean all logs" no longer deletes a currently-running job's live log,
  and no longer leaves `latest.log` symlinks dangling.
- Deleting a job that used a per-job logs-directory override no longer
  orphans its past logs from the Log Viewer / "clean all."
- Loading a job template no longer leaks a previous job's parameter
  overrides or custom arguments into the newly-loaded job.
- Seed detection no longer invents a seed from a non-numeric word (e.g.
  "Simulation seed: automatic"), and a custom seed-pattern regex can no
  longer freeze the extension host.
- Fixed a race where a fresh run could have its live status overwritten
  by an older run finishing up in the background.
- A post-run command is now tracked, timed out, and stopped on extension
  deactivation instead of being able to leak indefinitely.
- Shell auto-detect no longer silently discards the detected arguments it
  just showed you.

**Performance:**
- The Log Viewer caches each log's header/trailer read instead of
  re-reading every past run's log file on every open and every Refresh.
- Toggling a favorite flag or a value-source dropdown in Tool Setup no
  longer reloads the whole panel.
- The log tailer stops polling a run's growing log once its parsing cap
  is reached, instead of reading and discarding for the rest of the run.

**Cleanup:** clearer settings/help text distinguishing the two
similarly-named log-size settings; the two log-retention checkboxes are
now labeled distinctly instead of both saying "Keep at most."

## 0.39.0 — Seed detection for jobs that don't use ${randomSeed}

The Log Viewer's Seed column previously showed "–" for any job whose seed
wasn't captured via the `${randomSeed}` placeholder (e.g. typed literally,
via `${param:SEED}`, or only ever echoed by the tool's own startup
banner). It now falls back to scanning the run's own captured output:

- A built-in library of best-effort guessed patterns for common
  conventions (Questa/Xcelium `-sv_seed`/`-svseed`, a VCS-style
  `+ntb_random_seed=`, generic `+seed=`/`-seed`, Verilator `--seed`, and a
  loose `seed = value` fallback).
- A per-**tool** custom regex override (Tool Setup's Advanced section,
  "Seed pattern") for when the guesses don't match your site's actual
  output — with a live paste-and-preview tester: paste a sample log line
  and see what gets detected, updated as you type, no need to save first.
- The Seed column also got a minimum width so a real seed value can't get
  visually squeezed by wider neighboring columns.

## 0.38.0 — Per-job logs-directory override

A job's Advanced section gained a **Logs directory (override)** field,
mirroring the existing Post-setup working directory override exactly —
blank inherits the workspace-wide `logsDirectory` setting. The Log Viewer
and "Clean all logs" now both scan every root a job could actually be
writing to (the global root plus every job's own override), so an
overridden job's runs stay visible and get cleaned up correctly instead of
silently sitting outside what "clean all" or the Viewer's table sees.

## 0.37.0 — Configurable logs directory, size-based retention, clean-all

- **New `logsDirectory` setting** (Shell & Environment panel, with a
  folder-browse button) lets you move where run logs are stored, instead
  of the hardcoded `.eda-runner/logs` under the workspace root. The
  `.gitignore` auto-entry prompt follows the new location (and stays
  quiet if it's outside the workspace — nothing to ignore there).
- **Size-based retention** (`logRetentionMaxSizeMB`, alongside the
  existing count-based `logRetentionCount`) — both are now independent
  checkboxes in the panel; either, both, or neither can be on (`0` means
  off/unlimited for each). When both apply, the count cap is enforced
  first, then the oldest survivors are pruned further until under the
  size cap too.
- **"Clean all logs now…"** button, with a confirmation showing exactly
  how many files and how much disk space would be freed before deleting
  anything.

## 0.36.0 — Post-run command

A job's Advanced section gained a checkbox: **"Run a command after this
job finishes"**, plus the command itself. Runs once per completed lane,
using the same shell/setup chain and working directory as the job —
skipped for a Stopped ("killed") run, since that's not "the job's done, do
the follow-up." It's a lightweight, fire-and-forget action, not a second
tracked job: a nonzero exit or launch failure only shows a warning
notification, never affecting the job's own already-decided pass/fail.

## 0.35.0 — Job templates live in the Configure screen

- A new Template row at the top of a job's Configure form: pick a saved
  template from the dropdown and click **Load** to apply its fields into
  the form (whether it's currently blank or already has content), or
  **Save as template…** to save the current form's fields as a new
  template (or update one, if the name already exists — with a
  confirmation before overwriting). **Delete** removes a template
  (`JobStore.deleteTemplate`, previously unreachable from any UI at all).
- "New Job" now always opens a blank Configure panel directly — the
  QuickPick that used to ask "start from a template, or blank?" *before*
  the panel even existed is gone, since templates are now visible and
  loadable from inside the panel itself.
- The right-click "Save Job as Template..." command on an existing job
  still works as a second entry point.

## 0.34.0 — Clear run history, stop a whole folder

- **"Clear Run History"** — a new right-click action on a job that's grown
  an expandable repeat-count batch group collapses it back to a flat
  single-run row, without deleting the job. Previously the only way back
  to a flat row was deleting and recreating the job entirely.
- **"Stop Folder"** — a folder's context menu (and its inline icon, next
  to "Run Folder") now includes a Stop action that stops every currently
  running job inside it, mirroring "Run Folder"'s existing job-filtering.
- Small internal cleanup: `JobStore.getJobsInFolder()` replaces three
  separate inline `getJobs().filter(j => j.folder === ...)` calls.

## 0.33.0 — Fix five undo/data-loss bugs

A dedicated sweep of the whole extension for "impossible to undo" actions
(not just the job builder) turned up five real, confirmed bugs, now fixed:

1. **The "✎ var" toggle in a job's Configure form was one-way.** Switching
   a fixed-choices dropdown to a free-text `${var:NAME}` field deleted the
   only control that could switch it back — the only route back was
   collapsing and reopening the whole Tool builder. It's now a real
   toggle: click again to switch back to the dropdown, with the value
   preserved across the swap whenever it still fits.
2. **Rescanning a tool silently dropped every flag's attached value-list
   ("value source" dropdown).** Affected "Rescan All", a sub-tool's own
   "Rescan", and — worst of all — "Save & Rescan" on the in-place tool
   edit form, meaning any edit to a tool's command or help-arg wiped every
   flag's dropdown attachment across every sub-tool. The merge that
   already carried a flag's favorite star forward across a rescan now
   carries its value-list attachment forward too.
3. **Re-adding a sub-tool under a label that already existed didn't merge
   at all** — it silently discarded the whole previous variant's
   favorites and list attachments. Now goes through the same merge as a
   rescan instead of a bare replace.
4. **"Save Job as Template" could silently overwrite a same-named
   template** with no confirmation. Now warns first.
5. **Shell & Environment's "Use My VS Code Terminal Shell" immediately
   overwrote any unsaved typing** in the Shell path/arguments/environment
   fields with no undo. Now only asks for confirmation when it would
   actually replace non-empty, different content.

One item investigated during this sweep turned out not to be a bug:
re-expanding a job's "Tool builder" after a hand-edited Command rebuilds
the command from the builder's state — this looked like a regression
against an older description of the feature, but it's the intended,
already-documented design from the builder-precedence rework (collapsed =
hand-edit is authoritative and frozen; expanded = the builder controls the
field live, an explicit and visibly-labeled choice). No change made there.

## 0.32.0 — Unified help icons, Repeat count and custom arguments relocated

First release of a broader UI/UX feedback batch (see PLAN.md's Phase 11).

- **The "(?)" help icon is now consistent across every panel.** Previously
  only the job Configure form had it — Tool Setup, Shell & Environment, and
  Parameters all still used plain, always-visible hint paragraphs. All four
  now share one `webviewHelp.ts` module, and the icon itself is bigger and
  legible (fixed pixel sizes instead of compounding `em`-relative values
  that rendered as small as ~9-11px effective size on a high-DPI display).
  Live status text (a tool's "scanned at ...", a value list's discovered
  count, etc.) stays visible as before — only genuine help copy moved
  behind the icon.
- **Repeat count** is no longer buried in a job's Advanced section — it's
  now always visible, right under Working Directory, matching how often
  it's actually used.
- **"+ Add custom argument"** now sits directly under a tool's discovered
  options instead of appearing to dangle off the value-lists section below
  it.

## 0.31.0 — Full reattachment after a window reload

The last piece of clearing out the kill/reattachment backlog. Until now, a
job that outlived a window reload just sat "running (detached)" forever —
Stop still worked, but live output capture, error/warning counts, and
Problems-panel diagnostics were frozen from the moment of the reload, and
the only way to see how it actually finished was to open its log by hand.
Now, at activation, every such job automatically resumes: a fresh tailer
re-reads its log file from the start (rebuilding correct cumulative counts
and diagnostics, since nothing survives a reload to resume from), and a
liveness poll watches for its process to actually finish. Since a
reattached process was never spawned by this session, there's no real Node
exit event or exit code available for it — its pass/fail is instead
inferred from its own captured output (a matched Fail/Pass pattern, or the
structured error parser), defaulting conservatively to failed if nothing
says otherwise, so a run that disappeared without proof can't be credited
as a pass. New pure `reattach.ts` (`decideReattachState`, unit-tested via
`run-reattach-tests.mjs`) makes that call, reusing `jobOutcome.ts`'s exact
precedence with a conservative baseline instead of an optimistic one. The
tree/status bar now show "running (resumed)" (normal blue spinner) once
re-tailing is active, distinct from the old frozen "running (detached)"
look, which is now only ever visible for the brief instant before
reattachment kicks in.

## 0.30.0 — Capture survives closing VS Code

The prerequisite for full reattachment: a job's stdout/stderr now write
directly to its log file at the OS level (an inherited file descriptor
passed straight into the spawned process, not a shell-level redirect —
works the same across bash/tcsh/csh and doesn't disturb exit-code capture)
instead of being piped through the extension host. That's what let capture
silently die on a window reload before, even though the job itself (its
own detached process group) kept running untouched. A `FileTailer` now
feeds every run's error/warning parsing and Fail/Pass pattern matching by
reading the file back, live or reattached alike, rather than the extension
host relaying the child's output itself. Two settings change meaning as a
result: `logMaxSizeMB` now caps how much of a run is fed into parsing, not
the log file's own size (which the OS controls directly now — disk usage
stays bounded by `logRetentionCount` as before); `stripAnsiCodes` no longer
has any effect (the file is always raw now — parsing still always strips
ANSI internally regardless), kept registered for backward compatibility.

## 0.29.0 — Configurable, SIGINT-first kill signal escalation

Stopping a job now runs a configurable ordered signal sequence
(`killSignals`, new setting) instead of a hardcoded SIGTERM-then-SIGKILL —
defaulting to **SIGINT, then SIGTERM, then SIGKILL**, each with its own
grace period, since ctrl+c alone is often enough for an EDA tool to release
its license cleanly, which SIGTERM doesn't always trigger. New pure
`killPlan.ts` (`computeKillSchedule`, unit-tested via `run-kill-tests.mjs`)
turns the setting into a concrete schedule — dropping unrecognized entries,
falling back to today's historical two-stage sequence if the list is empty
or entirely invalid, and always guaranteeing a final SIGKILL stage
regardless of what's configured. `killGracePeriodSeconds` (existing
setting) is kept as the fallback grace for a stage that doesn't specify its
own. Both of `stop()`'s existing branches (a live run, and a "running
(detached)" job reconstructed after a reload) now consume the same
schedule through shared logic instead of each hand-rolling its own
two-stage sequence.

## 0.28.0 — Fix a pid-reuse race in the detached-reload Stop path

A "running (detached)" job (one whose status survived a window reload,
with no live process handle) is stopped by signalling its raw pid. Until
now that path trusted a bare `/proc/<pid>` existence check with no
identity verification — if the original process had already exited and
the OS later recycled that pid for something unrelated (plausible minutes
after a reload, on a host that's spawned many short-lived subprocesses in
the interim), Stop could end up signalling the wrong process group. Fixed
by persisting each run's process start time (`/proc/<pid>/stat` field 22)
alongside its pid and verifying both match before ever sending a signal —
if they don't, the job is simply marked idle instead of being signalled.
A status persisted before this change (no recorded start time) falls back
to the previous existence-only check rather than being treated as dead.
New pure `procStat.ts` (`parseStartTimeTicks`, unit-tested via
`run-procstat-tests.mjs`) handles the actual `/proc/<pid>/stat` parsing,
including the gotcha that its `comm` field can itself contain spaces and
parens.

## 0.27.0 — README rewrite

No functional changes. The README was rewritten from scratch to actually
be readable — down from ~2400 to ~1000 words, features as one-line
bullets instead of a paragraph each, the deep architecture essay cut down
to what a marketplace visitor actually wants to know.

## 0.26.0 — Bug fixes from a focused code review

A round of independent review over everything from the last several
releases (Tool Setup folder decoupling, the Command/Tool-builder rewrite,
Parameters, the Log Viewer) turned up real bugs, now fixed:

- An "override parameter" row left intentionally blank was silently
  dropped on save instead of overriding to an empty value.
- Reopening a job that used a `${var:NAME}` parameter reference inside a
  fixed-choices dropdown field could silently lose that value the next
  time the builder rebuilt the command.
- Selecting a Tool or Sub-tool while the builder was expanded didn't
  immediately update the Command field.
- The Log Viewer could get stuck on "Loading…" forever if a single log
  file had an I/O error while the table was being built.
- A very long resolved command could push a run's recorded seed/cwd/start
  time past the Log Viewer's read window, silently dropping them from the
  table.
- Refreshing the Log Viewer while a search was active could hide newly
  appeared runs that had never actually been searched.
- Clicking a log that had since been pruned, or any other Log Viewer
  error, now shows a message instead of silently doing nothing.

## 0.25.0 — Log Viewer

A new "Log Viewer" icon (next to Shell & Environment / Tool Setup /
Parameters) opens a page listing every past run across every job, newest
first — no more digging through `.eda-runner/logs/` by hand or clicking
through jobs one at a time. Filter by job, folder, pass/fail/killed/
running, seed, or a date range; collapsible sections group everything by
job below the combined "All logs" view; a search box finds runs whose
output contains a given string (e.g. a specific `UVM_ERROR`), scoped to
whatever's currently filtered. Click any row to open that log.

Runs using `${randomSeed}` now record the actual seed value they used in
the log file itself, so it's filterable and doesn't have to be dug out of
the resolved command by eye.

## 0.24.0 — Docs only: scoped out the next two backlog items

No code changes. `PLAN.md`'s two remaining Phase 4 items — license-friendly
kill refinements, and full reattachment of a job after a window reload —
are now grounded in the current code with a concrete sub-task list and the
open questions each needs answered before implementation starts.

## 0.23.0 — Per-job parameter overrides, right in the Configure form

Follow-up to v0.22.0's Parameters panel. A job's Configure form now shows
a "Parameters" section listing every global parameter (plus any
`${var:NAME}` already in its command) as a checkbox — check "override
NAME" to set a value just for this job, or add a parameter that's only
ever used by this one job. Free-text fields throughout the Tool builder
now autocomplete `${var:NAME}` references, and a fixed-choices dropdown
can be switched to free text when a parameter reference is needed instead
of one of the listed choices.

## 0.22.0 — New Parameters panel: global values, resolved silently

Parametrized runs (`${param:NAME}`) always prompt on every Run, which is
overkill for values that should just be configured once — e.g. a shared
testbench path. A new **Parameters** panel (third view-title icon, next to
Shell & Environment and Tool Setup) lets you define global name/value
parameters, referenced in a job's Command as `${var:NAME}` and substituted
silently every run — no prompt. `${param:NAME}` is completely unaffected
and still prompts, for cases like seed-chasing where that's actually
wanted. Per-job overrides (via the Configure form) are coming in a
follow-up release; this one ships the storage, resolution, and the panel
itself.

## 0.21.0 — Command field vs. Tool builder precedence, made obvious

Whether the hand-written Command field or the Tool builder "owns" what's
in it used to depend on whether you'd typed in the field recently — hard
to predict, with a "Sync" button as an escape hatch. Precedence is now
tied to whether the Tool builder section is expanded or collapsed:
collapsed, your hand-written command is untouched; expanded, the builder
drives the field live as you check flags. A hint above the Command field
always shows which one currently owns it.

## 0.20.0 — Decouple Tool Setup scanning from a specific folder

Registering or rescanning a tool used to require the scan to actually run
from a directory containing the script — awkward when colleagues keep
separate copies of the same script under `project/work1`, `project/work2`,
etc. A job's own working directory was already fully independent at run
time; only the scan step was pinned. A tool can now optionally set its own
**scan directory** (falls back to the existing workspace `postSetupCwd`
setting when unset) and a **display name**, so the same command can be
registered more than once — one per folder, each scanned independently —
for the cases where different copies genuinely have different flags.

## 0.15.0–0.19.0 — Colleague feedback (18 fixes)

A round of feedback from colleagues who tried the extension, fixed and
shipped in five small releases:

- **Bigger, responsive Configure/Tool Setup/Shell windows**; static hint
  text moved behind a (?) hover icon instead of cluttering the form.
- **Save no longer closes the tab**, with an optional auto-save setting;
  a "Scanning…" overlay during tool scans; no more scroll-jump on a
  favorite toggle.
- **"Scan & Add" renamed to "Add"**; a search/filter box over long option
  lists in both the job builder and Tool Setup.
- **Value lists can attach to a specific flag** as its dropdown value
  source, instead of always floating as a separate, easy-to-miss control.
- **Reusable job templates** — save any job as a template, start a new one
  from it.
- **A job can never run concurrently with itself** — only its own
  sequential Repeat Count can run it again; this also makes a new **Run
  Folder** button (runs every job in a folder one after another) safe
  regardless of the experimental multi-job setting.
- **The builder now prefers a flag's short form** (`-x` over `--xylophone`)
  when both exist; a "+" button adds custom, undiscovered arguments; three
  rarely-changed fields moved into Advanced settings.
- **Folders can be dragged to reorder**, same as jobs; deleting a
  non-empty folder now warns exactly how many jobs go with it, instead of
  silently ungrouping them.
- Confirmed (no code change needed): UVM_FATAL, DSim, and Verilator fatal
  errors were already all treated as failures.

See [PLAN.md](PLAN.md) Phase 5 for the full item-by-item breakdown.

## 0.14.0 — Initial public release (pre-release channel)

First public release of EDA Job Runner, a tool-agnostic sidebar for running
and tracking EDA compile/simulation jobs (Xcelium, Questa, Icarus, Verilator,
DSim, or any custom script) without leaving VS Code. Published on the
**pre-release** channel while it settles — see the Marketplace page for how
to opt in.

Everything below was already built and used before this first public
release; this entry is a snapshot of the full feature set, not a diff.

- **Job management**: add/configure/duplicate/delete jobs from the sidebar,
  hand-editable `.vscode/eda-jobs.json` with two-way sync, a default job
  (F5 to run it), drag-and-drop reordering.
- **Folders**: group related jobs under a named, flat folder in the sidebar.
- **Run/stop**: jobs run in the configured shell (bash/zsh/tcsh/csh/etc.,
  auto-detected invocation), in their own process group so Stop actually
  frees an EDA license instead of leaving an orphaned simulator behind.
  Optional concurrent runs, and a sequential repeat count for back-to-back
  runs (e.g. 10 runs with a random seed).
- **Parametrized runs**: `${param:NAME}` prompts for a value on every run
  (remembering the last one), `${randomSeed}` fills in a fresh seed on every
  spawn with no prompt, and **Re-run Last** replays one exact prior run
  verbatim — handy for chasing a specific failing seed.
- **Live status & logs**: per-job status (idle/running/passed/failed/killed)
  persisted across reloads, full stdout/stderr capture with ANSI stripping
  and a size cap, a real-time **Live Log** viewer, and log history browsing.
- **Problems panel integration**: output is scanned for UVM messages and
  common compile errors (Questa, Icarus, DSim, Verilator) and surfaced as
  clickable diagnostics — plus a fully **tool-agnostic Fail/Pass pattern**
  override (a regex you supply) for any tool whose real verdict isn't exit
  code or one of the built-in patterns.
- **Tool Setup**: register a tool's command and its `--help` output is
  scanned into checkable flags for a job's Configure form — a GUI builder
  for the Command field, including dispatcher sub-commands, favorites,
  a choices dropdown for fixed-value flags, and named test-list dropdowns
  sourced from a file or a command.
- **Shell & Environment panel**: configure the shell, its arguments, extra
  environment variables, workspace-level setup (sourced script / commands),
  and a post-setup working directory — all from one panel, with a
  "copy my VS Code terminal shell" shortcut.

See [README.md](README.md) for the full feature list and job-file format,
and [PLAN.md](PLAN.md) for the roadmap.
