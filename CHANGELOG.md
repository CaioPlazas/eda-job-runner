# Changelog

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
