import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { JobStore } from './jobStore';
import { ToolStore } from './toolStore';
import { JobRunner } from './jobRunner';
import { StepId, StepState, StepStatus } from './webviewSteps';

const SHELL_TEST_KEY = 'edaJobRunner.shellTestOk';
const FIRST_RUN_KEY = 'edaJobRunner.firstRunDone';

interface ShellTestRecord {
  hash: string;
  at: number;
}

interface ShellConfigForHash {
  shellPath: string;
  shellArgs: string[] | null;
  env: Record<string, string>;
  setupScript?: string;
  setupCommands?: string[];
  postSetupCwd: string;
}

/** Covers every field that, if changed, means step ①'s prior "tested" verdict no longer applies. */
export function shellConfigHash(config: ShellConfigForHash): string {
  const material = JSON.stringify({
    shellPath: config.shellPath,
    shellArgs: config.shellArgs,
    env: config.env,
    setupScript: config.setupScript ?? '',
    setupCommands: config.setupCommands ?? [],
    postSetupCwd: config.postSetupCwd
  });
  return crypto.createHash('sha256').update(material).digest('hex');
}

/** Called by ShellEnvPanel when Test Shell Setup passes. */
export function recordShellTestPass(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, config: ShellConfigForHash): void {
  const record: ShellTestRecord = { hash: shellConfigHash(config), at: Date.now() };
  void context.workspaceState.update(keyFor(SHELL_TEST_KEY, folder), record);
}

/** Called by JobRunner (or its caller) the first time any job finishes a run in this workspace. */
export function recordFirstRunDone(context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): void {
  void context.workspaceState.update(keyFor(FIRST_RUN_KEY, folder), true);
}

function keyFor(base: string, folder: vscode.WorkspaceFolder): string {
  return `${base}::${folder.uri.toString()}`;
}

export function computeStepStatus(
  toolStore: ToolStore,
  jobStore: JobStore,
  jobRunner: JobRunner,
  context: vscode.ExtensionContext,
  folder: vscode.WorkspaceFolder
): StepStatus {
  return {
    env: computeEnvState(jobStore, context, folder),
    tool: computeToolState(toolStore),
    job: computeJobState(jobStore, jobRunner, context, folder),
    params: computeParamsState(jobStore)
  };
}

function computeEnvState(jobStore: JobStore, context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): StepState {
  const config = vscode.workspace.getConfiguration('eda-job-runner', folder.uri);
  const setup = jobStore.getSetup();
  const current = shellConfigHash({
    shellPath: config.get<string>('shellPath', 'bash'),
    shellArgs: config.get<string[] | null>('shellArgs', null),
    env: config.get<Record<string, string>>('env', {}),
    setupScript: setup?.script,
    setupCommands: setup?.commands,
    postSetupCwd: config.get<string>('postSetupCwd', '')
  });
  const record = context.workspaceState.get<ShellTestRecord>(keyFor(SHELL_TEST_KEY, folder));
  return record && record.hash === current ? 'ok' : 'todo';
}

function computeToolState(toolStore: ToolStore): StepState {
  const tools = toolStore.getTools();
  if (tools.length === 0) {
    return 'todo';
  }
  const anyError = tools.some(t => t.variants.some(v => v.scanError));
  return anyError ? 'warn' : 'ok';
}

function computeJobState(jobStore: JobStore, jobRunner: JobRunner, context: vscode.ExtensionContext, folder: vscode.WorkspaceFolder): StepState {
  const jobs = jobStore.getJobs();
  if (jobs.length === 0) {
    return 'todo';
  }
  const firstRunDone = context.workspaceState.get<boolean>(keyFor(FIRST_RUN_KEY, folder), false);
  if (firstRunDone) {
    return 'ok';
  }
  const anyCompleted = jobs.some(j => {
    const state = jobRunner.getStatus(j.id).state;
    return state === 'passed' || state === 'failed' || state === 'killed';
  });
  if (anyCompleted) {
    recordFirstRunDone(context, folder);
    return 'ok';
  }
  return 'warn'; // jobs exist, none run yet
}

function computeParamsState(jobStore: JobStore): StepState {
  const params = jobStore.getParams();
  const lists = jobStore.getLists();
  if (params.length === 0 && lists.length === 0) {
    return 'todo';
  }
  const anyError = lists.some(l => l.scanError);
  return anyError ? 'warn' : 'ok';
}

/** Human-readable done-line per step, for stepIntroHtml. */
export function doneLineFor(
  step: StepId,
  _status: StepStatus,
  toolStore: ToolStore,
  jobStore: JobStore,
  jobRunner: JobRunner
): string | undefined {
  switch (step) {
    case 1:
      return '✓ Shell setup tested.';
    case 2: {
      const count = toolStore.getTools().length;
      return count > 0 ? `✓ ${count} tool${count === 1 ? '' : 's'} registered.` : undefined;
    }
    case 3: {
      const jobs = jobStore.getJobs();
      const lastRun = [...jobs].reverse().find(j => {
        const s = jobRunner.getStatus(j.id).state;
        return s === 'passed' || s === 'failed';
      });
      if (!lastRun) {
        return `✓ ${jobs.length} job${jobs.length === 1 ? '' : 's'}.`;
      }
      const state = jobRunner.getStatus(lastRun.id).state;
      return `✓ ${jobs.length} job${jobs.length === 1 ? '' : 's'} · last run: ${lastRun.name} ${state}`;
    }
    case 4: {
      const params = jobStore.getParams().length;
      const lists = jobStore.getLists().length;
      return `✓ ${params} parameter${params === 1 ? '' : 's'}, ${lists} value list${lists === 1 ? '' : 's'}`;
    }
  }
}
