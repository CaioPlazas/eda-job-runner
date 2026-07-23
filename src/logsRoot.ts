// Pure resolution of the effective logs-storage root, deliberately free of
// any `vscode` import (Node's own `path` is fine -- same convention as
// tailer.ts) so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-logs-root-tests.mjs) the same way the other pure
// modules are. Mirrors jobRunner.ts's `resolveCwdAbs` precedence exactly (a
// per-job override, if any, wins; else the workspace-wide setting; else a
// hardcoded default) since a log-storage-location override should behave
// identically to `postSetupCwd`'s.

import * as path from 'path';
import { substituteVars } from './shellInvocation';

export interface ResolveLogsRootInput {
  workspaceRoot: string;
  /** `eda-job-runner.logsDirectory` workspace setting, "" or undefined means unset. */
  globalSetting?: string;
  /** Per-job `JobDefinition.logsDirectory` override, "" or undefined means "inherit the workspace setting." */
  jobOverride?: string;
}

/**
 * Resolve the effective logs-storage root: `jobOverride` wins if non-blank,
 * else `globalSetting` if non-blank, else `<workspaceRoot>/.eda-runner/logs`
 * (today's hardcoded default, unchanged for anyone who hasn't set anything).
 * Supports `${workspaceFolder}`/`${env:NAME}` via the same `substituteVars`
 * every other path-like setting in this codebase already uses.
 */
export function resolveLogsRoot(input: ResolveLogsRootInput): string {
  const effective = (input.jobOverride && input.jobOverride.trim()) || (input.globalSetting && input.globalSetting.trim());
  if (!effective) {
    return path.join(input.workspaceRoot, '.eda-runner', 'logs');
  }
  return path.resolve(input.workspaceRoot, substituteVars(effective, input.workspaceRoot));
}

/**
 * The `.gitignore` line for `root`, relative to `workspaceRoot` -- undefined
 * when `root` isn't actually inside the workspace (nothing meaningful to
 * gitignore there; e.g. an absolute path elsewhere on disk, or reached via
 * enough `../` to escape the workspace).
 */
export function logsRootRelativeToWorkspace(root: string, workspaceRoot: string): string | undefined {
  const rel = path.relative(workspaceRoot, root);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return undefined;
  }
  return `${rel.split(path.sep).join('/')}/`;
}
