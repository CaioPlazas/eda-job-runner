# Changelog

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
