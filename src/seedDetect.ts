// Pure seed-value detection from a run's own captured output, deliberately
// free of any `vscode` import so it can be unit-tested by the standalone
// Node harness (test-fixtures/run-seed-tests.mjs) the same way the other
// pure modules are. Mirrors logParser.ts's per-tool pattern style, but for
// a different purpose: the Log Viewer's `# seed:` header field is only ever
// populated when a job's Command uses the `${randomSeed}` placeholder (see
// paramSubstitution.ts) -- a job that specifies its seed any other way
// (typed literally, `${param:SEED}`, or the tool echoing it in its own
// startup banner) leaves that field empty, showing "–" in the Viewer even
// though the seed is right there in the log. This module recovers it from
// the log body itself as a fallback.
//
// Unlike logParser.ts's patterns (grounded in real captured tool output),
// these are best-effort guesses at common EDA tool conventions -- there was
// no real Questa/Xcelium/etc. sample available to ground them against, so a
// per-tool custom override (Tool Setup's "Seed pattern" field) exists
// specifically to let a user correct/extend this for their site's actual
// tool output.

export interface SeedPatternSource {
  /** A short label for where this pattern came from, shown in the paste-and-preview tester (e.g. "Questa/Xcelium (-sv_seed)"). */
  label: string;
  /** Capture group 1 is the seed value. */
  pattern: RegExp;
}

// A seed value must look like a plausible number -- a decimal integer or a
// 0x-prefixed hex one -- never a bare word. Without this shape constraint
// (and the trailing \b, which forces the whole token to match rather than
// just a leading prefix of it): "Simulation seed: automatic" would capture
// seed "automatic", and a flag immediately followed by an unrelated
// positional argument with no real value of its own (e.g. "-sv_seed
// tb_top") would capture that argument instead.
const SEED_VALUE = '(0x[0-9a-fA-F]+|\\d+)\\b';

export const BUILTIN_SEED_PATTERNS: SeedPatternSource[] = [
  { label: 'Questa/Xcelium (-sv_seed)', pattern: new RegExp(`-sv_seed[= ]+${SEED_VALUE}`, 'i') },
  { label: 'Questa/Xcelium (-svseed)', pattern: new RegExp(`-svseed[= ]+${SEED_VALUE}`, 'i') },
  { label: 'VCS-style (+ntb_random_seed)', pattern: new RegExp(`\\+ntb_random_seed=${SEED_VALUE}`, 'i') },
  { label: 'Generic plusarg (+seed=)', pattern: new RegExp(`\\+seed=${SEED_VALUE}`, 'i') },
  { label: 'Generic flag (-seed)', pattern: new RegExp(`-seed[= ]+${SEED_VALUE}`, 'i') },
  { label: 'Verilator (--seed)', pattern: new RegExp(`--seed[= ]+${SEED_VALUE}`, 'i') },
  // Loosest fallback, tried last: any "seed" word near a value, e.g. a
  // tool's own banner line like "Seed: 12345" or "random seed = 987654321".
  { label: 'Generic "seed = value"', pattern: new RegExp(`\\bseed\\s*[=:]\\s*${SEED_VALUE}`, 'i') }
];

// The classic catastrophic-backtracking shape: a quantified sub-pattern
// nested inside a group that is itself quantified, e.g. `(a+)+` or `(x*)*`.
// A JS regex engine's backtracking cost for these is exponential in the
// input length -- unmatched input as short as ~30 characters can already
// take seconds, and every few characters beyond that roughly doubles it
// (verified empirically against V8) -- so no input-length cap can bound the
// runtime to something safe; the pattern itself has to be refused before it
// ever runs. This is a heuristic, not a full regex-safety proof (it won't
// catch a shape nested another level deeper, e.g. `((a+)+)+`), but it
// catches the overwhelmingly common accidental case of a hand-typed
// "seed pattern" with a doubled-up quantifier.
const CATASTROPHIC_SHAPE = /\([^()]*[+*][^()]*\)[+*]/;

/**
 * Compile a user-supplied seed-pattern regex, case-insensitively. Undefined
 * for blank, invalid, or catastrophically-backtracking input -- never
 * throws, mirroring jobOutcome.ts's `compilePattern`.
 */
export function compileSeedPattern(source: string | undefined): RegExp | undefined {
  const trimmed = (source ?? '').trim();
  if (!trimmed || CATASTROPHIC_SHAPE.test(trimmed)) {
    return undefined;
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch {
    return undefined;
  }
}

// Secondary, performance-oriented bound (not a safety guarantee by itself --
// see CATASTROPHIC_SHAPE above for the real defense): a custom pattern that
// passed the shape check is still user-authored and re-runs once per row
// every time the Log Viewer's table builds, so cap how much of the log text
// it scans rather than the full ~8KB head+tail slice. Taken from both ends
// of `text` (not just a prefix) so a seed banner near the tail is still
// reachable; the built-in patterns below are hand-written, fixed-structure,
// and effectively linear, so they still scan the full text.
const CUSTOM_PATTERN_TEXT_CAP = 1000;

function boundedForCustomPattern(text: string): string {
  if (text.length <= CUSTOM_PATTERN_TEXT_CAP * 2) {
    return text;
  }
  return text.slice(0, CUSTOM_PATTERN_TEXT_CAP) + text.slice(-CUSTOM_PATTERN_TEXT_CAP);
}

/**
 * Find a seed value in `text` (typically a log's head+tail slice). Tries
 * `customPattern` first if it compiles and matches, then each built-in
 * pattern in order. Returns undefined if nothing matches.
 */
export function detectSeed(text: string, customPattern?: string): string | undefined {
  const custom = compileSeedPattern(customPattern);
  if (custom) {
    const m = custom.exec(boundedForCustomPattern(text));
    if (m && m[1]) {
      return m[1];
    }
  }
  for (const { pattern } of BUILTIN_SEED_PATTERNS) {
    const m = pattern.exec(text);
    if (m && m[1]) {
      return m[1];
    }
  }
  return undefined;
}
