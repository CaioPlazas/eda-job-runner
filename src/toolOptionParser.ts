// Pure `--help` output parsing, deliberately free of any `vscode` import so
// it can be unit-tested by the standalone Node harness
// (test-fixtures/run-tool-parser-tests.mjs) the same way shellInvocation.ts
// and logParser.ts are. Targets generic GNU/argparse/click `--help`
// conventions (a 2+ space-aligned description column, `-x`/`--xxx` flags,
// an optional metavar meaning "takes a value"). Best-effort and
// tool-agnostic by design: a line it can't confidently parse is silently
// dropped rather than guessed at or thrown on.

export interface ParsedOption {
  /** All flag spellings for this option, e.g. ["-s", "--seed"]. */
  flags: string[];
  /** Placeholder text if the option takes a value (e.g. "SEED"); undefined for a pure toggle. */
  metavar?: string;
  description?: string;
}

const FLAG_LINE_STRICT = /^ {1,4}(-\S.*)$/;
// The "search deeper" pass (see parseHelpOutputDeep) tolerates option lines
// with no leading indent at all, or up to 8 spaces of it -- some tools list
// flags flush against column 0, others indent further than the 1-4 spaces
// argparse/click/GNU tools conventionally use. Widening this is safe: a
// pure-dashes section-separator line (e.g. a row of "-" used as a rule)
// still can't pass FLAG_TOKEN's character class below, so it's filtered out
// there rather than by indent.
const FLAG_LINE_DEEP = /^ {0,8}(-\S.*)$/;
const GAP = /\s{2,}/;
// Metavar is either a plain word (SEED, INTEGER) or an argparse `choices=`
// brace list ({g2012,g2009,...}) -- the latter's internal commas must not be
// treated as flag separators, which splitTopLevel (below) accounts for.
const FLAG_TOKEN = /^(-{1,2}[A-Za-z0-9][\w-]*)(?:[ =](\{[^}]*\}|[A-Za-z_][\w<>.[\]|-]*))?$/;
// Deep-only fallback: some tools spell a value-taking flag's metavar as an
// <angle-bracket> placeholder instead of FLAG_TOKEN's bare-word convention
// (SEED, INTEGER) -- either space-separated ("-F <filename>") or glued
// directly onto the flag name with no separator at all ("-g<name>=<value>").
// FLAG_TOKEN's metavar alternative requires a leading letter/underscore, so
// neither spelling matches it. The whole placeholder (optionally with a
// glued "=<value>" suffix) becomes the option's metavar -- a free-text value
// field, e.g. "myparam=5" -- rather than being split into separate fields.
const BRACKET_METAVAR_TOKEN_DEEP = /^(-{1,2}[A-Za-z0-9][\w-]*) ?(<[^>]+>(?:=<[^>]+>)?)$/;

/** Split on top-level commas only -- commas inside a `{...}` choices list don't separate flags. */
export function splitTopLevel(head: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < head.length; i++) {
    const ch = head[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ',' && depth === 0) {
      parts.push(head.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(head.slice(start));
  return parts;
}

function parseOptionLine(rawLine: string, deep: boolean): ParsedOption | undefined {
  const lineMatch = (deep ? FLAG_LINE_DEEP : FLAG_LINE_STRICT).exec(rawLine);
  if (!lineMatch) {
    return undefined; // no qualifying indent + leading '-': section header, positional arg, prose, etc.
  }
  let rest = lineMatch[1];
  if (deep) {
    // Some tools join co-equal flag spellings with " / " instead of a comma
    // (e.g. "-32 / -64"); normalize to comma-joined so splitTopLevel/FLAG_TOKEN
    // handle it the same way as the standard "-a, --alpha" spelling. Only the
    // exact " / " substring qualifies, so "-l/-logfile" (no surrounding
    // spaces) and "[on/off]" (inside a metavar) are left untouched.
    rest = rest.replace(/ \/ /g, ', ');
  }
  const gap = GAP.exec(rest);
  const head = (gap ? rest.slice(0, gap.index) : rest).trim();
  const description = gap ? rest.slice(gap.index + gap[0].length).trim() : undefined;
  if (!head) {
    return undefined;
  }

  const flags: string[] = [];
  let metavar: string | undefined;
  for (const part of splitTopLevel(head)) {
    const trimmed = part.trim();
    const token = FLAG_TOKEN.exec(trimmed);
    if (token) {
      flags.push(token[1]);
      if (token[2]) {
        metavar = token[2];
      }
      continue;
    }
    const bracketed = deep ? BRACKET_METAVAR_TOKEN_DEEP.exec(trimmed) : null;
    if (bracketed) {
      flags.push(bracketed[1]);
      metavar = bracketed[2];
      continue;
    }
    // e.g. click's "--flag / --no-flag" boolean syntax -- documented gap, not a crash
  }
  if (flags.length === 0) {
    return undefined;
  }
  return { flags, metavar, description: description || undefined };
}

/**
 * Strip a uniform comment prefix (e.g. "# ") that some tools wrap every line
 * of help output in (Tcl/csh-sourced tools commonly emit their output this
 * way). Only strips when EVERY non-blank line shares the exact same 2-char
 * prefix -- a partial match would mean the prefix is coincidental, not a
 * genuine comment wrapper, and stripping it would corrupt real content.
 */
function stripUniformCommentPrefix(text: string): string {
  const lines = text.split(/\r?\n/);
  const nonBlank = lines.filter(l => l.trim().length > 0);
  if (nonBlank.length === 0 || !nonBlank.every(l => l.startsWith('# '))) {
    return text;
  }
  return lines.map(l => (l.startsWith('# ') ? l.slice(2) : l)).join('\n');
}

function parseHelpOutputInternal(helpText: string, deep: boolean): ParsedOption[] {
  const text = deep ? stripUniformCommentPrefix(helpText) : helpText;
  const options: ParsedOption[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const opt = parseOptionLine(line, deep);
    if (!opt) {
      continue;
    }
    if (opt.flags.every(f => f === '-h' || f === '--help')) {
      continue; // never useful to build into a run command
    }
    const key = opt.flags.join('|');
    if (seen.has(key)) {
      continue; // help text sometimes repeats an option (usage line + options section)
    }
    seen.add(key);
    options.push(opt);
  }
  return options;
}

/** Parse a tool's captured `--help` text into its discovered flags, using the
 * conservative GNU/argparse/click-oriented rules this parser has always used. */
export function parseHelpOutput(helpText: string): ParsedOption[] {
  return parseHelpOutputInternal(helpText, false);
}

/**
 * "Search deeper": re-parse the same captured help text with looser rules,
 * for tools whose `--help` doesn't follow common flag-listing conventions --
 * wider indent tolerance, "/"-joined flag spellings, glued flag+placeholder
 * syntax, and a uniform comment-prefix strip. Opt-in and separate from
 * `parseHelpOutput` (rather than merged into it) so the well-tested default
 * path stays exactly as conservative as before; a caller only reaches for
 * this after the default pass finds zero options on real output.
 */
export function parseHelpOutputDeep(helpText: string): ParsedOption[] {
  return parseHelpOutputInternal(helpText, true);
}

/**
 * Carry hand-set-in-Tool-Setup customizations -- a "favorite" star and a
 * flag's attached value-list ("value source") -- forward across a rescan.
 * Rescanning always produces a fresh options list (parsed straight from the
 * tool's current `--help`, which has no concept of either), so both have to
 * be re-applied by matching on the option's own flag spelling, not list
 * position (which a scan can freely reorder). Previously this only carried
 * `favorite` forward, silently dropping every flag's `valueListName` on
 * every rescan (including the automatic rescan after editing a tool's
 * command/help-arg) -- a real, if easy to reproduce, data-loss bug.
 */
export function mergeFavorites<T extends { flags: string[]; favorite?: boolean; valueListName?: string }>(
  previous: T[],
  next: T[]
): T[] {
  const byFlags = new Map(previous.map(o => [o.flags.join('|'), o]));
  return next.map(o => {
    const prior = byFlags.get(o.flags.join('|'));
    if (!prior) {
      return o;
    }
    return {
      ...o,
      favorite: prior.favorite ? true : o.favorite,
      valueListName: prior.valueListName ?? o.valueListName
    };
  });
}

/**
 * If `metavar` is an argparse `choices=` brace list (e.g. "{qrun,dsim}"),
 * return its individual choices so a value-taking flag can be rendered as a
 * dropdown instead of free text; undefined for a plain metavar word (e.g.
 * "SEED") or empty braces, which keep the existing free-text input. A pure
 * derivation from `metavar` -- not persisted alongside it -- so it always
 * reflects the freshest scan without needing its own merge-across-rescans
 * logic (unlike `favorite`, which is hand-set and must survive a rescan).
 */
export function parseChoices(metavar: string | undefined): string[] | undefined {
  if (!metavar || !metavar.startsWith('{') || !metavar.endsWith('}')) {
    return undefined;
  }
  const inner = metavar.slice(1, -1);
  if (!inner.trim()) {
    return undefined;
  }
  return splitTopLevel(inner)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

const SUBCOMMAND_CHOICES = /\{([\w-]+(?:,[\w-]+)+)\}/;

/**
 * Detect an argparse subparser signature — the `{choice1,choice2,...}`
 * token argparse renders for `add_subparsers()` in both the usage line and
 * the positional-arguments block. Returns candidate sub-command names to
 * offer as tool variants; empty if the tool doesn't look like a dispatcher.
 */
export function detectSubcommandChoices(helpText: string): string[] {
  const match = SUBCOMMAND_CHOICES.exec(helpText);
  if (!match) {
    return [];
  }
  return match[1].split(',');
}
