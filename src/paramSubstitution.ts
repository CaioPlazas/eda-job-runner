// Pure parametrized-run helpers, deliberately free of any `vscode` import so
// they can be unit-tested by the standalone Node harness
// (test-fixtures/run-param-tests.mjs) the same way the other pure modules are.
//
// Two independent placeholder kinds a job's Command can use, both tool-agnostic
// (generic string substitution, no EDA-specific syntax):
//   ${param:NAME}          -- prompted for on every Run (skipped entirely by
//                             "Re-run Last", which replays a prior run's exact
//                             already-resolved command); the value entered is
//                             remembered per job+name as next time's default.
//   ${param:NAME=default}  -- same, but seeds the very first prompt (before
//                             any value has ever been entered for NAME on this
//                             job) with `default`.
//   ${randomSeed}          -- never prompted; replaced with a fresh random
//                             unsigned integer on every actual run (including
//                             every iteration of a repeat-count batch), so a
//                             job command doesn't need hand-editing to get a
//                             new seed each time.

export interface ParamSpec {
  name: string;
  default: string;
}

const PARAM_TOKEN = /\$\{param:([A-Za-z_][\w-]*)(?:=([^}]*))?\}/g;
const RANDOM_SEED_TOKEN = /\$\{randomSeed\}/g;

/** Every `${param:NAME}` / `${param:NAME=default}` placeholder, in first-appearance order, deduped by name. */
export function parseParams(command: string): ParamSpec[] {
  const seen = new Set<string>();
  const params: ParamSpec[] = [];
  for (const m of command.matchAll(PARAM_TOKEN)) {
    const name = m[1];
    if (seen.has(name)) {
      continue; // a name can appear more than once in the command; only prompt for it once
    }
    seen.add(name);
    params.push({ name, default: m[2] ?? '' });
  }
  return params;
}

/** Replace every `${param:NAME...}` placeholder with its resolved value (every occurrence of a name gets the same value). */
export function substituteParams(command: string, values: Record<string, string>): string {
  return command.replace(PARAM_TOKEN, (_full, name: string) => values[name] ?? '');
}

/**
 * Replace every `${randomSeed}` placeholder with one freshly generated value
 * (same value for every occurrence in this one call). `seed` in the result is
 * that generated value, or undefined when the command had no placeholder --
 * callers (jobRunner.ts) use it to record the actual seed a run used, e.g. in
 * the log header for the log viewer's seed filter.
 */
export function substituteRandomSeed(
  command: string,
  randomInt: () => number = defaultRandomInt
): { command: string; seed: string | undefined } {
  let seed: string | undefined;
  const resolved = command.replace(RANDOM_SEED_TOKEN, () => {
    if (seed === undefined) {
      seed = String(randomInt());
    }
    return seed;
  });
  return { command: resolved, seed };
}

function defaultRandomInt(): number {
  // Unsigned 31-bit range -- comfortably fits a typical EDA tool's seed argument.
  return Math.floor(Math.random() * 0x7fffffff);
}
