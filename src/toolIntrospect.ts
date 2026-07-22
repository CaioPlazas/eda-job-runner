import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { JobStore } from './jobStore';
import { ToolDefinition, ToolList, ToolOption, ToolVariant } from './types';
import { buildShellInvocation, resolveJobEnv, substituteVars } from './shellInvocation';
import { parseHelpOutput, mergeFavorites } from './toolOptionParser';
import { parseListLines } from './listSource';

// Introspects a tool by spawning it through the exact same shell-invocation
// path used for running jobs and for ShellEnvPanel's "Test Shell Setup"
// probe (buildShellInvocation/resolveJobEnv/substituteVars, workspace setup
// chain) -- no new subprocess mechanism, no native module, so this stays
// within the project's CentOS 7 / GLIBC 2.17 / no-native-deps requirement.

const SCAN_TIMEOUT_MS = 15000;
const SCAN_OUTPUT_CAP = 64 * 1024;
// A value-list file is read at most this far -- a real test list is thousands
// of short lines, well under 1 MiB, and this bounds a pathological/stalled read.
const LIST_FILE_CAP = 1024 * 1024;

export interface ScanResult {
  options: ToolOption[];
  rawHelp: string;
  scanError?: string;
}

interface ProbeResult {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set only when the shell itself couldn't be launched (not a nonzero tool exit). */
  launchError?: string;
}

/**
 * Run `<setup chain> && <probeCommand>` through the same shell invocation that
 * jobs use, capturing (and hard-capping) combined stdout+stderr with a
 * timeout. Shared by both the flag scan (`scanVariant`) and value-list
 * discovery (`discoverList`) so neither invents its own subprocess mechanism —
 * keeping both within the CentOS 7 / no-native-deps ground rules.
 */
function runProbe(
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

  const probeParts: string[] = [];
  if (setup?.script) {
    const scriptPath = path.isAbsolute(setup.script) ? setup.script : path.join(workspaceRoot, setup.script);
    probeParts.push(`source "${scriptPath}"`);
  }
  for (const cmd of setup?.commands ?? []) {
    probeParts.push(cmd);
  }
  probeParts.push(probeCommand);
  const probe = probeParts.join(' && ');

  const { file, args } = buildShellInvocation(shellPath, shellArgs, probe);
  // A tool's own scan-directory override wins over the workspace-wide
  // postSetupCwd default -- this is what lets the same script be registered
  // twice (e.g. "work1/launch_sim", "work2/launch_sim") and scanned
  // independently from each folder. Never affects a job's own runtime cwd,
  // which is resolved separately in jobRunner.ts.
  const effectiveDir = (scanDir?.trim() || postSetupCwd.trim());
  const cwd = effectiveDir ? path.resolve(workspaceRoot, substituteVars(effectiveDir, workspaceRoot)) : workspaceRoot;

  return new Promise<ProbeResult>(resolve => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(file, args, {
        cwd,
        env: resolveJobEnv(env, workspaceRoot),
        stdio: ['ignore', 'pipe', 'pipe']
      });
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
      if (output.length > SCAN_OUTPUT_CAP) {
        output = output.slice(0, SCAN_OUTPUT_CAP) + '\n…(truncated)';
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
    }, SCAN_TIMEOUT_MS);

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

/** Scan one variant: `<setup chain> && <command> ...selectArgs <helpArg>`. */
export async function scanVariant(
  command: string,
  selectArgs: string[],
  helpArg: string,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder,
  scanDir?: string
): Promise<ScanResult> {
  const { output, code, signal, launchError } = await runProbe(
    [command, ...selectArgs, helpArg].join(' '),
    jobStore,
    folder,
    scanDir
  );
  if (launchError) {
    return { options: [], rawHelp: output, scanError: launchError };
  }
  const options = parseHelpOutput(output);
  // A nonzero exit is only a real failure when it also produced nothing
  // parseable -- some tools' --help exits nonzero while still printing
  // real usage text, and that text is exactly what we came for.
  const scanError =
    options.length === 0 && (code !== 0 || signal)
      ? `exited ${code ?? 'n/a'}${signal ? ` (signal ${signal})` : ''} with no recognizable options`
      : undefined;
  return { options, rawHelp: output, scanError };
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
  list: ToolList,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder,
  scanDir?: string
): Promise<ToolList> {
  const command = list.command?.trim();
  const file = list.file?.trim();

  if (command) {
    const { output, launchError } = await runProbe(command, jobStore, folder, scanDir);
    if (launchError) {
      return { ...list, values: [], scanError: launchError };
    }
    const values = parseListLines(output, list.pattern);
    return { ...list, values, scanError: values.length === 0 ? 'command produced no list items' : undefined };
  }

  if (file) {
    try {
      const filePath = resolveListFilePath(file, folder, scanDir);
      const text = await readCapped(filePath);
      const values = parseListLines(text, list.pattern);
      return { ...list, values, scanError: values.length === 0 ? 'file has no list items' : undefined };
    } catch (err) {
      return { ...list, values: [], scanError: `Could not read file: ${describe(err)}` };
    }
  }

  return { ...list, values: [], scanError: 'no command or file source set' };
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

/** Re-discover every list on a tool sequentially, returning the refreshed list array. */
export async function scanLists(
  tool: ToolDefinition,
  jobStore: JobStore,
  folder: vscode.WorkspaceFolder
): Promise<ToolList[]> {
  const lists: ToolList[] = [];
  for (const list of tool.lists ?? []) {
    lists.push(await discoverList(list, jobStore, folder, tool.scanDir));
  }
  return lists;
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
