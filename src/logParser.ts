// Streaming, line-by-line parser that turns EDA tool output into structured
// issues (errors/warnings, with optional file:line) for the Problems panel and
// per-job count badges. Every pattern here is grounded in real captured output
// from the tools in examples/ (see test-fixtures/), not guessed.
//
// The headline case is UVM runtime messages. The classic trap is the
// end-of-run report summary, whose lines look almost like error messages:
//
//     UVM_ERROR tb/foo.sv(22) @ 20: uvm_test_top [SMOKE] Data mismatch...   <- a real error
//     UVM_ERROR :    1                                                       <- just a count
//
// A naive `line.includes('UVM_ERROR')` miscounts the summary row (and would
// count `UVM_ERROR :    0` as an error). We exclude summary rows explicitly and
// only ever turn genuine message lines into issues.

export type IssueSeverity = 'error' | 'warning';

export interface LogIssue {
  severity: IssueSeverity;
  /** File as printed by the tool — may be absolute, or relative to the job cwd. */
  file?: string;
  /** 1-based line number. */
  line?: number;
  /** 1-based column, when the tool reports one. */
  column?: number;
  message: string;
  /** Full original log line, for the diagnostic's detail. */
  raw: string;
  /** Which matcher produced this, e.g. "uvm", "questa" — becomes Diagnostic.source. */
  source: string;
}

export interface ParseState {
  issues: LogIssue[];
  errorCount: number;
  warningCount: number;
  /**
   * Internal: whether we're currently inside a DSim "=E:/=F:" diagnostic block.
   * DSim prints structured blocks — a "=E:[Tag]:" header followed by indented
   * "file:line:col ..." locations — and also "=W:" blocks (e.g. library lint
   * like IneffectiveDynamicCast) with the same indented-location shape. An
   * indented location only means "error" under an error block; without this
   * flag we'd wrongly flag every library-internal warning location.
   */
  dsimErrorBlock: boolean;
}

export function newParseState(): ParseState {
  return { issues: [], errorCount: 0, warningCount: 0, dsimErrorBlock: false };
}

// UVM end-of-run summary rows: "UVM_ERROR :    1". Matched first and skipped so
// they never become issues. Anchored so the count (an integer) is the ONLY
// thing after the colon — a real message never looks like this.
const UVM_SUMMARY = /^UVM_(?:INFO|WARNING|ERROR|FATAL)\s*:\s*\d+\s*$/;

// UVM message with a source location:
//   UVM_ERROR tb/foo.sv(22) @ 20: uvm_test_top [SMOKE] Data mismatch...
// Only ERROR/WARNING/FATAL become issues; UVM_INFO is not a problem.
const UVM_LOCATED = /^UVM_(ERROR|WARNING|FATAL)\s+(\S+)\((\d+)\)\s+@/;

// UVM message with no location (reporter-issued):
//   UVM_ERROR @ 0: reporter [ID] ...
// Counts toward totals but isn't clickable.
const UVM_UNLOCATED = /^UVM_(ERROR|WARNING|FATAL)\s+@/;

// Questa vlog/vcom: "** Error: ..." / "** Warning: ...". The file(line) token
// may appear before or after the (vlog-NNNN) code, so we locate it separately
// anywhere in the remainder rather than pinning its position.
const QUESTA = /^\*\*\s*(Error|Warning)\b\s*:?\s*(.*)$/;
const FILE_LINE_TOKEN = /([^\s():]+\.(?:sv|svh|v|vh|vhd|vhdl))\((\d+)\)/i;

// Icarus: "/path/foo.sv:5: error: ..." or "/path/foo.sv:5: syntax error".
const ICARUS = /^(\S+\.(?:sv|svh|v|vh)):(\d+):\s*(.*)$/i;

// DSim structured-diagnostic block header: "=E:[ParseError]:", "=W:[...]", etc.
// The severity letter (E/F = error/fatal, everything else not-an-error) decides
// whether the indented location lines that follow are real errors.
const DSIM_HEADER = /^=([A-Z]):/;

// DSim parse-error location, printed indented under a "=E:" block:
//   /tmp/broken.sv:4:27    expected 'null'...
const DSIM_LOCATED = /^\s+(\S+\.(?:sv|svh|v|vh)):(\d+):(\d+)\s+(.*)$/i;

// Verilator lint/compile diagnostic. Real format (captured from Verilator
// 5.020, `verilator --lint-only -Wall`):
//   %Error: broken.sv:3:10: Can't find definition of variable: 'undeclared_sig'
//   %Warning-WIDTHTRUNC: warnmod.sv:4:12: Operator ASSIGNW expects 4 bits...
// The severity may carry a message code ("-WIDTHTRUNC"); "%Warning*" is a
// warning, "%Error*"/"%Fatal*" an error. Requiring file:line:col means the
// end-of-run summary rows ("%Error: Exiting due to 2 error(s)", which have
// no location) simply never match -- the same trap UVM_SUMMARY handles
// explicitly, but here it falls out of the shape of the regex for free.
const VERILATOR = /^%(Error|Warning|Fatal)(?:-[A-Z0-9_]+)?:\s+(\S+?):(\d+):(\d+):\s*(.*)$/;

/**
 * Parse a single log line, mutating `state` in place. Safe to call once per
 * line as output streams in.
 */
export function parseLine(line: string, state: ParseState): void {
  const trimmedEnd = line.replace(/\s+$/, '');

  // Track DSim diagnostic-block context first. A header line opens (or closes)
  // an error block; a non-indented, non-header line ends any open block.
  const header = DSIM_HEADER.exec(trimmedEnd);
  if (header) {
    state.dsimErrorBlock = header[1] === 'E' || header[1] === 'F';
  } else if (state.dsimErrorBlock && trimmedEnd.length > 0 && !/^\s/.test(trimmedEnd)) {
    state.dsimErrorBlock = false;
  }

  if (UVM_SUMMARY.test(trimmedEnd)) {
    return; // report-summary row — never an issue
  }

  let m: RegExpMatchArray | null;

  if ((m = UVM_LOCATED.exec(trimmedEnd))) {
    add(state, {
      severity: m[1] === 'WARNING' ? 'warning' : 'error',
      file: m[2],
      line: Number(m[3]),
      message: trimmedEnd,
      raw: line,
      source: 'uvm'
    });
    return;
  }

  if ((m = UVM_UNLOCATED.exec(trimmedEnd))) {
    add(state, {
      severity: m[1] === 'WARNING' ? 'warning' : 'error',
      message: trimmedEnd,
      raw: line,
      source: 'uvm'
    });
    return;
  }

  if ((m = QUESTA.exec(trimmedEnd))) {
    const severity: IssueSeverity = m[1] === 'Warning' ? 'warning' : 'error';
    const loc = FILE_LINE_TOKEN.exec(m[2]);
    add(state, {
      severity,
      file: loc?.[1],
      line: loc ? Number(loc[2]) : undefined,
      message: m[2] || trimmedEnd,
      raw: line,
      source: 'questa'
    });
    return;
  }

  if (state.dsimErrorBlock && (m = DSIM_LOCATED.exec(trimmedEnd))) {
    add(state, {
      severity: 'error',
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      message: m[4],
      raw: line,
      source: 'dsim'
    });
    return;
  }

  if ((m = VERILATOR.exec(trimmedEnd))) {
    add(state, {
      severity: m[1] === 'Warning' ? 'warning' : 'error',
      file: m[2],
      line: Number(m[3]),
      column: Number(m[4]),
      message: m[5] || trimmedEnd,
      raw: line,
      source: 'verilator'
    });
    return;
  }

  if ((m = ICARUS.exec(trimmedEnd))) {
    const rest = m[3];
    // Icarus prints plain "syntax error" lines and "error: ..." lines; treat a
    // "warning" mention as a warning, everything else it flags as an error.
    const severity: IssueSeverity = /\bwarning\b/i.test(rest) ? 'warning' : 'error';
    add(state, {
      severity,
      file: m[1],
      line: Number(m[2]),
      message: rest || trimmedEnd,
      raw: line,
      source: 'icarus'
    });
    return;
  }
}

// Counts stay exact for any log size; stored issue objects (which back the
// Problems panel) are capped so a pathological log can't exhaust memory. 5000
// is already far more diagnostics than a Problems panel is useful with.
const MAX_STORED_ISSUES = 5000;

function add(state: ParseState, issue: LogIssue): void {
  if (state.issues.length < MAX_STORED_ISSUES) {
    state.issues.push(issue);
  }
  if (issue.severity === 'error') {
    state.errorCount++;
  } else {
    state.warningCount++;
  }
}
