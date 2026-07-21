import * as vscode from 'vscode';
import * as fs from 'fs';
import { defaultArgsForShell } from './shellInvocation';

export interface DetectedShell {
  path: string;
  /** Command-capable args for this shell family (includes the ${command} token). */
  args: string[];
  env: Record<string, string>;
  /** Human-readable note about where the shell was detected from. */
  source: string;
}

interface TerminalProfile {
  path?: string | string[];
  args?: string[];
  env?: Record<string, string | null>;
  source?: string;
}

/**
 * Read the shell VS Code itself would use — the default integrated-terminal
 * profile for this platform, falling back to `vscode.env.shell`. Over
 * Remote-SSH the extension host runs on the remote, so this reflects the
 * remote server's shell, which is what jobs actually run against.
 *
 * Interactive profile `args` (e.g. a bare `-l`) can't run a command, so they
 * are intentionally not copied verbatim; `defaultArgsForShell` yields the
 * correct command-capable vector for the same family (bash/zsh `-lc` already
 * carries login).
 */
export function detectVscodeShell(): DetectedShell {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  const term = vscode.workspace.getConfiguration('terminal.integrated');
  const defaultName = term.get<string | null>(`defaultProfile.${plat}`, null);
  const profiles = term.get<Record<string, TerminalProfile | null>>(`profiles.${plat}`, {}) ?? {};

  let path: string | undefined;
  let env: Record<string, string> = {};
  let source: string;

  const profile = defaultName ? profiles[defaultName] : undefined;
  const profilePath = profile ? firstExistingPath(profile.path) : undefined;
  if (profilePath) {
    path = profilePath;
    env = cleanEnv(profile?.env);
    source = `terminal profile "${defaultName}"`;
  } else if (vscode.env.shell && vscode.env.shell.trim().length > 0) {
    path = vscode.env.shell;
    source = 'vscode.env.shell';
  } else {
    path = 'bash';
    source = 'fallback default';
  }

  return { path, args: defaultArgsForShell(path), env, source };
}

function firstExistingPath(p: string | string[] | undefined): string | undefined {
  if (!p) {
    return undefined;
  }
  const candidates = Array.isArray(p) ? p : [p];
  const nonEmpty = candidates.filter(c => typeof c === 'string' && c.trim().length > 0);
  return nonEmpty.find(c => existsSafe(c)) ?? nonEmpty[0];
}

function existsSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Drop null-valued keys (VS Code uses null to *unset* a var) and stringify. */
function cleanEnv(env: Record<string, string | null> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value !== null && value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}
