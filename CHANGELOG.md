# Changelog

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
