# Changelog

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
