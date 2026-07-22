// Pure "global parameter" substitution helpers, deliberately free of any
// `vscode` import so they can be unit-tested by the standalone Node harness
// (test-fixtures/run-var-tests.mjs) the same way the other pure modules are.
//
// ${var:NAME} is a *silent* substitution -- resolved from a job's own
// override, else the workspace-wide GlobalParam default, else empty string.
// It never prompts, unlike paramSubstitution.ts's ${param:NAME} (which
// always prompts on Run and is a completely separate, untouched mechanism --
// the two token syntaxes are deliberately disjoint, see VAR_TOKEN below, so a
// command can use either or both without collision).

import { GlobalParam } from './types';

const VAR_TOKEN = /\$\{var:([A-Za-z_][\w-]*)\}/g;

/** Every `${var:NAME}` placeholder referenced in `command`, in first-appearance order, deduped by name. */
export function parseVars(command: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const m of command.matchAll(VAR_TOKEN)) {
    const name = m[1];
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

/** A job's own override wins; otherwise the global default; otherwise empty string. */
export function effectiveVarValue(name: string, globals: Record<string, string>, overrides: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(overrides, name)) {
    return overrides[name];
  }
  return globals[name] ?? '';
}

/** Replace every `${var:NAME}` placeholder with its effective value (override > global default > empty). */
export function substituteParamVars(command: string, globals: Record<string, string>, overrides: Record<string, string>): string {
  return command.replace(VAR_TOKEN, (_full, name: string) => effectiveVarValue(name, globals, overrides));
}

/** Flattens `GlobalParam[]` (as stored in `JobsFile.params`) into the `Record<string,string>` the functions above take. */
export function flattenGlobalParams(params: GlobalParam[]): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const p of params) {
    flat[p.name] = p.value;
  }
  return flat;
}
