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

export const BUILTIN_SEED_PATTERNS: SeedPatternSource[] = [
  { label: 'Questa/Xcelium (-sv_seed)', pattern: /-sv_seed[= ]+(\w+)/i },
  { label: 'Questa/Xcelium (-svseed)', pattern: /-svseed[= ]+(\w+)/i },
  { label: 'VCS-style (+ntb_random_seed)', pattern: /\+ntb_random_seed=(\w+)/i },
  { label: 'Generic plusarg (+seed=)', pattern: /\+seed=(\w+)/i },
  { label: 'Generic flag (-seed)', pattern: /-seed[= ]+(\w+)/i },
  { label: 'Verilator (--seed)', pattern: /--seed[= ]+(\w+)/i },
  // Loosest fallback, tried last: any "seed" word near a value, e.g. a
  // tool's own banner line like "Seed: 12345" or "random seed = 987654321".
  { label: 'Generic "seed = value"', pattern: /\bseed\s*[=:]\s*(\w+)/i }
];

/**
 * Compile a user-supplied seed-pattern regex, case-insensitively. Undefined
 * for blank or invalid input -- never throws, mirroring jobOutcome.ts's
 * `compilePattern`.
 */
export function compileSeedPattern(source: string | undefined): RegExp | undefined {
  const trimmed = (source ?? '').trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new RegExp(trimmed, 'i');
  } catch {
    return undefined;
  }
}

/**
 * Find a seed value in `text` (typically a log's head+tail slice). Tries
 * `customPattern` first if it compiles and matches, then each built-in
 * pattern in order. Returns undefined if nothing matches.
 */
export function detectSeed(text: string, customPattern?: string): string | undefined {
  const custom = compileSeedPattern(customPattern);
  if (custom) {
    const m = custom.exec(text);
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
