import * as vscode from 'vscode';
import * as path from 'path';
import { buildShellInvocation, resolveJobEnv, substituteVars } from './shellInvocation';
import { buildSetupChain, SetupChainInput } from './setupChain';
import { spawnCapped, SCAN_TIMEOUT_MS, SCAN_OUTPUT_CAP } from './toolIntrospect';

// A generic "run something through the setup chain and give me the output"
// request/response pair for any panel, modelled on webviewBrowse.ts's
// correlated-requestId design so one panel can have several probes in
// flight. Live form values are used (not saved config) so a probe works
// BEFORE Save -- the same guarantee ShellEnvPanel's original Test button
// already had.

export interface ProbeMessage {
  type: 'probe';
  requestId: number;
  /** Probe commands to run after the setup chain, each reported separately. */
  checks: string[];
  /** Live form values, so a probe works BEFORE Save. */
  shell: { path: string; args: string[] | null; env: Record<string, string> };
  setup: SetupChainInput;
  cwd?: string;
}

export interface ProbeCheckResult {
  command: string;
  ok: boolean;
  output: string;
}

interface ProbedMessage {
  type: 'probed';
  requestId: number;
  invocation: string;
  cwd: string;
  results: ProbeCheckResult[];
  launchError?: string;
}

const CHECK_START = (i: number) => `__EDA_PROBE_CHECK_${i}_START__`;
const CHECK_END = (i: number) => `__EDA_PROBE_CHECK_${i}_END__`;

export interface ProbeRunResult {
  invocation: string;
  cwd: string;
  results: ProbeCheckResult[];
  launchError?: string;
}

/**
 * Runs every `checks[]` entry through a **single** shell spawn (not one
 * spawn per check) -- each check's own stdout/stderr and exit status is
 * recovered afterward via a start/end marker pair wrapped around it. If the
 * setup chain itself fails, the whole thing short-circuits before any
 * marker prints, which surfaces as every check reporting `ok: false` with
 * empty output -- the correct signal that step ① is the problem, not the
 * checks themselves. Exported directly (not just via `handleProbeMessage`)
 * so a host-side caller that already knows its own checks (ShellEnvPanel's
 * probe console, which adds a "command -v <tool>" check per registered
 * tool) can run them without a postMessage round trip.
 */
export async function runProbeChecks(
  checks: string[],
  shell: { path: string; args: string[] | null; env: Record<string, string> },
  setup: SetupChainInput,
  cwd: string | undefined,
  folder: vscode.WorkspaceFolder
): Promise<ProbeRunResult> {
  const workspaceRoot = folder.uri.fsPath;
  const tail = checks.map((check, i) => `echo '${CHECK_START(i)}'; ${check}; echo "${CHECK_END(i)}:$?"`).join('\n');
  const invocationScript = buildSetupChain(setup, tail || 'true', workspaceRoot);
  const { file, args } = buildShellInvocation(shell.path, shell.args, invocationScript);

  const resolvedCwd = cwd?.trim()
    ? path.resolve(workspaceRoot, substituteVars(cwd.trim(), workspaceRoot))
    : workspaceRoot;

  const { output, launchError } = await spawnCapped(
    file,
    args,
    resolvedCwd,
    resolveJobEnv(shell.env, workspaceRoot),
    SCAN_TIMEOUT_MS,
    SCAN_OUTPUT_CAP
  );

  const results: ProbeCheckResult[] = checks.map((command, i) => {
    const start = output.indexOf(CHECK_START(i));
    if (start === -1) {
      return { command, ok: false, output: '' };
    }
    const bodyStart = start + CHECK_START(i).length;
    const endMarker = new RegExp(`${escapeRegExp(CHECK_END(i))}:(\\d+)`);
    const rest = output.slice(bodyStart);
    const endMatch = rest.match(endMarker);
    if (!endMatch || endMatch.index === undefined) {
      return { command, ok: false, output: rest.trim() };
    }
    const body = rest.slice(0, endMatch.index).trim();
    const exitCode = parseInt(endMatch[1], 10);
    return { command, ok: exitCode === 0, output: body };
  });

  return { invocation: `${file} ${args.join(' ')}`, cwd: resolvedCwd, results, launchError };
}

export async function handleProbeMessage(msg: ProbeMessage, webview: vscode.Webview, folder: vscode.WorkspaceFolder): Promise<void> {
  const run = await runProbeChecks(msg.checks, msg.shell, msg.setup, msg.cwd, folder);
  const response: ProbedMessage = { type: 'probed', requestId: msg.requestId, ...run };
  void webview.postMessage(response);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const PROBE_CSS = `
  .probeResult { margin-top: 6px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; }
  .probeResult .ok { color: var(--vscode-charts-green); }
  .probeResult .fail { color: var(--vscode-charts-red, var(--vscode-errorForeground)); }
  .probeResult .muted { color: var(--vscode-descriptionForeground); }
`;

/**
 * Client-side snippet -- embed via `${PROBE_JS}` inside a panel's own
 * `<script>` block. Provides `runProbe(checks, shell, setup, cwd)` returning
 * a Promise of the `probed` response, correlated by requestId the same way
 * `BROWSE_JS` correlates `browsed` responses.
 */
export const PROBE_JS = `
  let __probeRequestId = 0;
  const __probePending = new Map();
  window.addEventListener('message', event => {
    const m = event.data;
    if (m && m.type === 'probed' && __probePending.has(m.requestId)) {
      const resolve = __probePending.get(m.requestId);
      __probePending.delete(m.requestId);
      resolve(m);
    }
  });
  function runProbe(checks, shell, setup, cwd) {
    const requestId = ++__probeRequestId;
    return new Promise(resolve => {
      __probePending.set(requestId, resolve);
      vscode.postMessage({ type: 'probe', requestId, checks, shell, setup, cwd });
    });
  }
`;
