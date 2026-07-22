// Pure log-header/trailer parsing, deliberately free of any `vscode` import
// so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-log-index-tests.mjs) the same way the other pure
// modules are. Feeds the log viewer's table without needing a persisted
// index -- every log file jobRunner.ts writes already carries everything
// the viewer needs in its own header (written once, at the top of the file)
// and trailer (written once, at the very end): job name, lane label, the
// fully resolved command (including any ${randomSeed} value, separately
// tagged as `# seed:` for the viewer's seed filter), start time, final
// state, exit code, and parsed error/warning counts. Reading only a small
// head/tail slice of each file (see logManager.ts's `readHeadTail`) is
// enough -- the full body is never needed just to list/filter/sort runs.

export interface LogHeaderInfo {
  jobName?: string;
  laneLabel?: string;
  command?: string;
  seed?: string;
  cwd?: string;
  started?: string;
}

export interface LogTrailerInfo {
  state?: string;
  exitCode?: string;
  signal?: string;
  errorCount?: number;
  warningCount?: number;
  patternNote?: string;
  ended?: string;
}

export interface LogFilenameInfo {
  /** Sortable timestamp exactly as embedded in the filename, e.g. "2026-07-22_10-30-00-000". */
  timestamp?: string;
  laneSuffix?: string;
}

const JOB_LINE = /^# job: (.+?)(?: \(run (.+)\))?$/m;
const COMMAND_LINE = /^# command: (.*)$/m;
const SEED_LINE = /^# seed: (.*)$/m;
const CWD_LINE = /^# cwd: (.*)$/m;
const STARTED_LINE = /^# started: (.*)$/m;

/** Parses the header block `runLane` writes at the top of every log file (see jobRunner.ts). Best-effort -- an unrecognized/truncated header yields fewer fields, never throws. */
export function parseLogHeader(text: string): LogHeaderInfo {
  const info: LogHeaderInfo = {};
  const job = JOB_LINE.exec(text);
  if (job) {
    info.jobName = job[1];
    if (job[2]) {
      info.laneLabel = job[2];
    }
  }
  const command = COMMAND_LINE.exec(text);
  if (command) {
    info.command = command[1];
  }
  const seed = SEED_LINE.exec(text);
  if (seed) {
    info.seed = seed[1];
  }
  const cwd = CWD_LINE.exec(text);
  if (cwd) {
    info.cwd = cwd[1];
  }
  const started = STARTED_LINE.exec(text);
  if (started) {
    info.started = started[1];
  }
  return info;
}

// Matches the trailer `finish()` writes (jobRunner.ts): state word, exit code
// (a number or "n/a"), an optional signal, optional error/warning counts, an
// optional pattern-match note, and the ISO end timestamp.
const TRAILER_LINE =
  /^# EDA Job Runner: (\S+) \(exit ([^,)]+)(?:, signal (\S+))?(?:, (\d+) error\(s\) (\d+) warning\(s\) parsed)?\)(.*) at (.+)$/m;

/** Parses the trailer line `finish()` appends when a run completes. Returns an empty object for a still-running (no trailer yet) or unrecognized log. */
export function parseLogTrailer(text: string): LogTrailerInfo {
  const m = TRAILER_LINE.exec(text);
  if (!m) {
    return {};
  }
  const info: LogTrailerInfo = { state: m[1], exitCode: m[2] };
  if (m[3]) {
    info.signal = m[3];
  }
  if (m[4] !== undefined && m[5] !== undefined) {
    info.errorCount = Number(m[4]);
    info.warningCount = Number(m[5]);
  }
  const note = m[6].trim();
  if (note) {
    info.patternNote = note;
  }
  info.ended = m[7];
  return info;
}

const FILENAME_PATTERN = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3})(?:_(.+))?\.log$/;

/** Parses a log's own filename (see logManager.ts's `timestamp()`) as a fallback sort/display key when a file can't be read at all. */
export function parseLogFilename(filename: string): LogFilenameInfo {
  const m = FILENAME_PATTERN.exec(filename);
  if (!m) {
    return {};
  }
  const info: LogFilenameInfo = { timestamp: m[1] };
  if (m[2]) {
    info.laneSuffix = m[2];
  }
  return info;
}

/** Case-insensitive plain-substring search -- the "as good as we can do for now" full-text log search. */
export function searchMatches(content: string, query: string): boolean {
  if (!query.trim()) {
    return true;
  }
  return content.toLowerCase().includes(query.toLowerCase());
}
