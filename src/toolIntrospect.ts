import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JobStore } from './jobStore';
import { ToolDefinition, ToolOption, ToolVariant, ValueList } from './types';
import { buildShellInvocation, resolveJobEnv, substituteVars } from './shellInvocation';
import { buildSetupChain } from './setupChain';
import { parseHelpOutput, mergeFavorites } from './toolOptionParser';
import { parseListLines } from './listSource';

// Introspects a tool by spawning it through the exact same shell-invocation
// path used for running jobs and for ShellEnvPanel's "Test Shell Setup"
// probe (buildShellInvocation/resolveJobEnv/substituteVars, workspace setup
// chain) -- no new subprocess mechanism, no native module, so this stays
// within the project's CentOS 7 / GLIBC 2.17 / no-native-deps requirement.

export const SCAN_TIMEOUT_MS = 15000;
export const SCAN_OUTPUT_CAP = 64 * 1024;
// A value-list file is read at most this far -- a real test list is thousands
// of short lines, well under 1 MiB, and this bounds a pathological/stalled read.
const LIST_FILE_CAP = 1024 * 1024;

export interface ScanResult {
  options: ToolOption[];
  rawHelp: string;
  scanError?: string;
  /** The literal `<setup chain> && <command> ...` that was run, for display in a failure/empty message. */
  probeCommand?: string;
}

export interface ProbeResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set only when the shell itself couldn't be launched (not a nonzero tool exit). */
  launchError?: string;
  /** The literal `<setup chain> && <probeCommand>` string that was run. */
  probeCommand: string;
}

/**
 * Spawn `file args` in `cwd`/`env`, capturing (and hard-capping) combined
 * stdout+stderr with a timeout, killing the process group's leaf with
 * SIGKILL on expiry. The one low-level shell-spawn primitive shared by every
 * probe-style caller (`runProbe` below and `webviewProbe.ts`'s
 * `handleProbeMessage`) — no separate subprocess mechanism per caller.
 */
export function spawnCapped(
  file: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  timeoutMs: number,
  outputCap: number
): Promise<{ output: string; code: number | null; signal: NodeJS.Signals | null; launchError?: string }> {
  return new Promise(resolve => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ output: '', code: null, signal: null, launchError: `Failed to launch shell: ${describe(err)}` });
      return;
    }

    let output = '';
    let capped = false;
    const collect = (buf: Buffer) => {
      if (capped) {
        return;
      }
      output += buf.toString('utf8');
      if (output.length > outputCap) {
        output = output.slice(0, outputCap) + '\n…(truncated)';
        capped = true;
      }
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, timeoutMs);

    child.on('error', err => {
      clearTimeout(timer);
      resolve({ output, code: null, signal: null, launchError: `Failed to launch shell: ${describe(err)}` });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ output, code, signal });
    });
  });
}

/**
 * Run `<setup chain> && <probeCommand>` through the same shell invocation that
 * jobs use, via `buildSetupChain` (the single canonical assembly — see
 * `setupChain.ts`). Shared by both the flag scan (`scanVariant`) and
 * value-list discovery (`discoverList`) so neither invents its own subprocess
 * mechanism — keeping both within the CentOS 7 / no-native-deps ground rules.
 */
async function runProbe(
  probeCommand: string,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder,
  scanDir?: string
): Promise<ProbeResult> {
  const config = vscode.workspace.getConfiguration('eda-job-runner', folder.uri);
  const shellPath = config.get<string>('shellPath', 'bash');
  const shellArgs = config.get<string[] | null>('shellArgs', null);
  const env = config.get<Record<string, string>>('env', {});
  const postSetupCwd = config.get<string>('postSetupCwd', '');
  const workspaceRoot = folder.uri.fsPath;
  const setup = jobStore.getSetup();

  const probe = buildSetupChain(setup, probeCommand, workspaceRoot);
  const { file, args } = buildShellInvocation(shellPath, shellArgs, probe);
  // A tool's own scan-directory override wins over the workspace-wide
  // postSetupCwd default -- this is what lets the same script be registered
  // twice (e.g. "work1/launch_sim", "work2/launch_sim") and scanned
  // independently from each folder. Never affects a job's own runtime cwd,
  // which is resolved separately in jobRunner.ts.
  const effectiveDir = (scanDir?.trim() || postSetupCwd.trim());
  const cwd = effectiveDir ? path.resolve(workspaceRoot, substituteVars(effectiveDir, workspaceRoot)) : workspaceRoot;

  const result = await spawnCapped(file, args, cwd, resolveJobEnv(env, workspaceRoot), SCAN_TIMEOUT_MS, SCAN_OUTPUT_CAP);
  return { ...result, probeCommand: probe };
}

/** Scan one variant: `<setup chain> && <command> ...selectArgs <helpArg>`. */
export async function scanVariant(
  command: string,
  selectArgs: string[],
  helpArg: string,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder,
  scanDir?: string
): Promise<ScanResult> {
  const { output, code, signal, launchError, probeCommand } = await runProbe(
    [command, ...selectArgs, helpArg].join(' '),
    jobStore,
    folder,
    scanDir
  );
  if (launchError) {
    return { options: [], rawHelp: output, scanError: launchError, probeCommand };
  }
  const options = parseHelpOutput(output);
  // A nonzero exit is only a real failure when it also produced nothing
  // parseable -- some tools' --help exits nonzero while still printing
  // real usage text, and that text is exactly what we came for.
  const scanError =
    options.length === 0 && (code !== 0 || signal)
      ? `exited ${code ?? 'n/a'}${signal ? ` (signal ${signal})` : ''} with no recognizable options`
      : undefined;
  return { options, rawHelp: output, scanError, probeCommand };
}

/** Scan every variant of a tool sequentially, returning the updated variant list. */
export async function scanTool(
  tool: ToolDefinition,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder
): Promise<ToolVariant[]> {
  const helpArg = tool.helpArg?.trim() || '--help';
  const variants: ToolVariant[] = [];
  for (const variant of tool.variants) {
    const result = await scanVariant(tool.command, variant.selectArgs, helpArg, jobStore, folder, tool.scanDir);
    variants.push({
      label: variant.label,
      selectArgs: variant.selectArgs,
      options: mergeFavorites(variant.options, result.options),
      rawHelp: result.rawHelp,
      scanError: result.scanError
    });
  }
  return variants;
}

/**
 * (Re)discover a value list's members from its source and return an updated
 * copy (definition preserved, `values`/`scanError` refreshed). A command
 * source runs `<setup chain> && <command>` via the shared probe; a file
 * source is read from disk (path resolved against `postSetupCwd`, then the
 * workspace root). Both feed `parseListLines` with the list's optional
 * pattern. A list with neither source keeps zero values.
 */
export async function discoverList(
  list: ValueList,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder,
  scanDir?: string
): Promise<{ list: ValueList; probeCommand?: string }> {
  const command = list.command?.trim();
  const file = list.file?.trim();

  if (command) {
    const { output, launchError, probeCommand } = await runProbe(command, jobStore, folder, scanDir);
    if (launchError) {
      return { list: { ...list, values: [], scanError: launchError }, probeCommand };
    }
    const values = parseListLines(output, list.pattern);
    return {
      list: { ...list, values, scanError: values.length === 0 ? 'command produced no list items' : undefined },
      probeCommand
    };
  }

  if (file) {
    try {
      const filePath = resolveListFilePath(file, folder, scanDir);
      const text = await readCapped(filePath);
      const values = parseListLines(text, list.pattern);
      return { list: { ...list, values, scanError: values.length === 0 ? 'file has no list items' : undefined } };
    } catch (err) {
      return { list: { ...list, values: [], scanError: `Could not read file: ${describe(err)}` } };
    }
  }

  return { list: { ...list, values: [], scanError: 'no command or file source set' } };
}

/**
 * Read at most `LIST_FILE_CAP` bytes of a file, so a giant or NFS-stalled test
 * list can't hang the Tool Setup handler or exhaust memory (the command
 * source is already capped by runProbe). A file over the cap is read
 * partially — plenty for a real test list, which is thousands of short lines.
 */
async function readCapped(filePath: string): Promise<string> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(LIST_FILE_CAP);
    const { bytesRead } = await handle.read(buffer, 0, LIST_FILE_CAP, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Re-discover every list in a workspace-wide list array sequentially, returning the refreshed list array. */
export async function scanAllLists(
  lists: ValueList[],
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder
): Promise<ValueList[]> {
  const refreshed: ValueList[] = [];
  for (const list of lists) {
    const { list: updated } = await discoverList(list, jobStore, folder, list.scanDir);
    refreshed.push(updated);
  }
  return refreshed;
}

/** Resolve a list file path the same way a scan's cwd resolves: against a tool's own scanDir override, then postSetupCwd, then workspace root. */
function resolveListFilePath(file: string, folder: vscode.WorkspaceFolder, scanDir?: string): string {
  const workspaceRoot = folder.uri.fsPath;
  const resolved = substituteVars(file, workspaceRoot);
  if (path.isAbsolute(resolved)) {
    return resolved;
  }
  const config = vscode.workspace.getConfiguration('eda-job-runner', folder.uri);
  const postSetupCwd = config.get<string>('postSetupCwd', '');
  const effectiveDir = scanDir?.trim() || postSetupCwd.trim();
  const baseDir = effectiveDir ? path.resolve(workspaceRoot, substituteVars(effectiveDir, workspaceRoot)) : workspaceRoot;
  return path.resolve(baseDir, resolved);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
