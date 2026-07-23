import { execSync } from 'child_process';
import * as path from 'path';

// Bundle the pure logs-root resolution logic (which itself imports
// shellInvocation.ts's substituteVars -- esbuild inlines that relative
// import into the same standalone file) and import it, the same approach
// the other pure-module test harnesses use.
execSync('npx esbuild ./src/logsRoot.ts --bundle --format=esm --platform=node --outfile=/tmp/logsRoot.mjs', {
  stdio: 'inherit'
});
const { resolveLogsRoot, logsRootRelativeToWorkspace } = await import('/tmp/logsRoot.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const ws = process.platform === 'win32' ? 'C:\\ws' : '/ws';

// --- precedence: default < global < job override ---
check(
  resolveLogsRoot({ workspaceRoot: ws }) === path.join(ws, '.eda-runner', 'logs'),
  'no override/global -> default .eda-runner/logs'
);
check(
  resolveLogsRoot({ workspaceRoot: ws, globalSetting: 'shared-logs' }) === path.resolve(ws, 'shared-logs'),
  'global setting wins over the default'
);
check(
  resolveLogsRoot({ workspaceRoot: ws, globalSetting: 'shared-logs', jobOverride: 'job-logs' }) === path.resolve(ws, 'job-logs'),
  'job override wins over the global setting'
);
check(
  resolveLogsRoot({ workspaceRoot: ws, globalSetting: 'shared-logs', jobOverride: '   ' }) === path.resolve(ws, 'shared-logs'),
  'blank/whitespace-only job override falls back to the global setting'
);

// --- ${workspaceFolder} / ${env:NAME} substitution ---
check(
  resolveLogsRoot({ workspaceRoot: ws, globalSetting: '${workspaceFolder}/logs' }) === path.resolve(ws, `${ws}/logs`),
  '${workspaceFolder} substituted'
);
{
  process.env.EDA_TEST_LOGDIR = 'from-env';
  const result = resolveLogsRoot({ workspaceRoot: ws, globalSetting: '${env:EDA_TEST_LOGDIR}' });
  check(result === path.resolve(ws, 'from-env'), '${env:NAME} substituted (got ' + result + ')');
  delete process.env.EDA_TEST_LOGDIR;
}

// --- gitignore relative-path derivation ---
check(
  logsRootRelativeToWorkspace(path.join(ws, '.eda-runner', 'logs'), ws) === '.eda-runner/logs/',
  'root inside workspace -> forward-slashed relative path with a trailing slash'
);
check(
  logsRootRelativeToWorkspace(path.join(ws, 'a', 'b'), ws) === 'a/b/',
  'nested root inside workspace -> full relative path'
);
check(
  logsRootRelativeToWorkspace(ws, ws) === undefined,
  'root equal to the workspace root itself -> undefined (nothing meaningful to ignore)'
);
check(
  logsRootRelativeToWorkspace(process.platform === 'win32' ? 'C:\\elsewhere\\logs' : '/elsewhere/logs', ws) === undefined,
  'root entirely outside the workspace (absolute, unrelated path) -> undefined'
);
check(
  logsRootRelativeToWorkspace(path.join(ws, '..', 'sibling-logs'), ws) === undefined,
  'root reached via .. (escapes the workspace) -> undefined'
);

console.log(failures === 0 ? '\nAll logs-root tests passed.' : `\n${failures} logs-root test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
