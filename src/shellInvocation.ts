// Pure shell-invocation helpers, deliberately free of any `vscode` import so
// they can be unit-tested by the standalone Node harness
// (test-fixtures/run-shell-tests.mjs) the same way the log parser is.

/** Placeholder token, replaced by the assembled command inside `shellArgs`. */
export const COMMAND_TOKEN = '${command}';

/**
 * The argument vector a shell needs to run a single command string, chosen by
 * shell family. `${command}` marks where the command goes.
 *
 * The important case is tcsh/csh: a bundled `-lc` is invalid there (tcsh's `-l`
 * "may be given only if it is the only flag"), which is exactly why a hardcoded
 * `-lc` broke tcsh sites. tcsh/csh source ~/.tcshrc / ~/.cshrc on every
 * non-`-f` invocation, so `-c` alone still makes module loads / aliases
 * available — no login flag needed (and it can't be combined with `-c` anyway).
 */
export function defaultArgsForShell(shellPath: string): string[] {
  const base = basename(shellPath).toLowerCase().replace(/\.exe$/, '');
  switch (base) {
    case 'tcsh':
    case 'csh':
      return ['-c', COMMAND_TOKEN];
    case 'pwsh':
    case 'powershell':
      return ['-NoLogo', '-Command', COMMAND_TOKEN];
    case 'cmd':
      return ['/d', '/s', '/c', COMMAND_TOKEN];
    case 'bash':
    case 'zsh':
    case 'sh':
    case 'ksh':
    case 'dash':
    case 'fish':
      return ['-lc', COMMAND_TOKEN];
    default:
      // Unknown shell: a bare `-c <command>` is the most portable POSIX form.
      return ['-c', COMMAND_TOKEN];
  }
}

/**
 * Build the `{ file, args }` handed to `child_process.spawn`. `shellArgs`, when
 * provided, overrides the family default; the command is substituted wherever
 * the `${command}` token appears, or appended as the final argument if the
 * token is absent. The command always stays a single argv element (never
 * string-concatenated into a flag), so there is no re-quoting or injection.
 */
export function buildShellInvocation(
  shellPath: string,
  shellArgs: string[] | null | undefined,
  command: string
): { file: string; args: string[] } {
  const file = shellPath.trim() || 'bash';
  const template = shellArgs && shellArgs.length > 0 ? shellArgs : defaultArgsForShell(file);

  const args: string[] = [];
  let substituted = false;
  for (const arg of template) {
    if (arg.includes(COMMAND_TOKEN)) {
      args.push(arg === COMMAND_TOKEN ? command : arg.split(COMMAND_TOKEN).join(command));
      substituted = true;
    } else {
      args.push(arg);
    }
  }
  if (!substituted) {
    args.push(command);
  }
  return { file, args };
}

/**
 * Expand `${workspaceFolder}` and `${env:NAME}` inside a settings value.
 * Unknown `${env:NAME}` references resolve to an empty string, matching how a
 * shell would treat an unset variable.
 */
export function substituteVars(value: string, workspaceRoot: string): string {
  return value
    .split('${workspaceFolder}')
    .join(workspaceRoot)
    .replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? '');
}

/**
 * Merge user-configured env vars on top of the inherited environment. Returns
 * `undefined` when there is nothing to add, so the caller keeps today's
 * pure-inherit behavior (passing no `env` to spawn) instead of cloning the
 * whole environment for no reason.
 */
export function resolveJobEnv(
  envSetting: Record<string, string> | undefined,
  workspaceRoot: string
): NodeJS.ProcessEnv | undefined {
  if (!envSetting) {
    return undefined;
  }
  const entries = Object.entries(envSetting).filter(([key]) => key.trim().length > 0);
  if (entries.length === 0) {
    return undefined;
  }
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, raw] of entries) {
    merged[key] = substituteVars(String(raw ?? ''), workspaceRoot);
  }
  return merged;
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
