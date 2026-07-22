// Pure parsing of Linux's /proc/<pid>/stat, deliberately free of any `vscode`
// or `fs` dependency so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-procstat-tests.mjs) the same way the other pure modules
// are. The actual /proc read (impure) lives in jobRunner.ts.

/**
 * Extract field 22 (`starttime`, in clock ticks since boot) from the raw text
 * of /proc/<pid>/stat. Used to verify a persisted pid still refers to the
 * same process before signalling it -- a bare `/proc/<pid>` existence check
 * can't tell a still-running job apart from an unrelated process the OS later
 * recycled that pid for.
 *
 * Field 2 (`comm`, the executable name in parens) can itself contain spaces
 * and parens (e.g. a process renamed via prctl), so this can't be a naive
 * `split(' ')[21]` -- it slices past the *last* `)` in the line (comm is
 * always immediately followed by a space then the numeric `state` field,
 * which can't contain `)`) before splitting the fixed-format remainder on
 * whitespace.
 */
export function parseStartTimeTicks(statText: string): number | undefined {
  const lastParen = statText.lastIndexOf(')');
  if (lastParen === -1) {
    return undefined;
  }
  const rest = statText.slice(lastParen + 1).trim();
  if (!rest) {
    return undefined;
  }
  const fields = rest.split(/\s+/);
  // `rest` starts at field 3 (state), so field 22 (starttime) is fields[19].
  const raw = fields[19];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
