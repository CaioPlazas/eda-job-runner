// Pure "value list" helpers, deliberately free of any `vscode` import so they
// can be unit-tested by the standalone Node harness
// (test-fixtures/run-list-tests.mjs) the same way the other pure modules are.
//
// A "value list" is the tool-agnostic primitive behind the test-list dropdown
// in the job builder: a set of strings discovered from a source (a file, or a
// command's stdout -- the impure part lives in toolIntrospect.ts), turned into
// selectable values here, then inserted into a job's Command via a
// user-supplied template so the extension never assumes any tool's flag syntax.

const INSERT_VALUE_TOKEN = /\$\{value\}/g;

/**
 * Turn raw list text (a file's contents, or a command's stdout) into the
 * discovered values, generically: split on newlines, trim, drop blank lines
 * and `#`-comment lines. When `pattern` is given it's applied per surviving
 * line as a regex -- capture group 1 if present, else the whole match -- so a
 * messy real-world list (columns, prefixes, annotations) can be reduced to
 * just the test name. Lines that don't match `pattern` are dropped. Results
 * are deduped in first-appearance order and capped at `MAX_LIST_VALUES` so a
 * pathological source can't produce a dropdown huge enough to jank the
 * builder webview (a real test list is far smaller than this).
 */
export const MAX_LIST_VALUES = 5000;

export function parseListLines(text: string, pattern?: string): string[] {
  let regex: RegExp | undefined;
  if (pattern && pattern.trim().length > 0) {
    try {
      regex = new RegExp(pattern);
    } catch {
      // An invalid user-supplied pattern falls back to no extraction rather
      // than throwing -- the raw (comment/blank-filtered) lines are still useful.
      regex = undefined;
    }
  }

  const seen = new Set<string>();
  const values: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (values.length >= MAX_LIST_VALUES) {
      break;
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    let value: string | undefined = line;
    if (regex) {
      const m = regex.exec(line);
      if (!m) {
        continue; // pattern given but this line doesn't match -- not a list item
      }
      value = (m[1] ?? m[0]).trim();
    }
    if (value.length === 0 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }
  return values;
}

/**
 * Insert a picked value into its Command fragment. `${value}` in the template
 * is replaced with `value` (every occurrence); an empty/undefined template
 * defaults to a bare `${value}`, so the plain "just the value" case needs no
 * configuration.
 */
export function applyInsertTemplate(template: string | undefined, value: string): string {
  const t = template && template.trim().length > 0 ? template : '${value}';
  return t.replace(INSERT_VALUE_TOKEN, value);
}
