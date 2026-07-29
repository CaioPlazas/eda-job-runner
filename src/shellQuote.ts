/** Safely quotes an arbitrary string for a POSIX shell by wrapping it in single quotes, escaping any embedded single quote as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Bare-word passthrough for values that don't need quoting -- spaces, quotes,
 * $, `, ;, &, |, <, >, (, ), *, ?, [, ], {, }, #, ~, !, \, and newlines all
 * trigger quoting. Mirrors the safe-character boundary Python's shlex.quote
 * uses, which already covers typical EDA argument syntax (+define+FOO=1,
 * /path/to/file.f, v1.2.3) as safe-unquoted.
 */
export function shellQuoteIfNeeded(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : shellQuote(s);
}
