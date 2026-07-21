import { execSync } from 'child_process';

// Bundle the pure shell-invocation helpers to a temp ESM file and import them,
// the same approach run-parser-tests.mjs uses for the log parser.
execSync('npx esbuild ./src/shellInvocation.ts --bundle --format=esm --outfile=/tmp/shellInvocation.mjs', {
  stdio: 'inherit'
});
const { buildShellInvocation, defaultArgsForShell, resolveJobEnv, substituteVars } = await import(
  '/tmp/shellInvocation.mjs'
);

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const CMD = 'make sim && vsim';

// --- bash: login shell -lc, command as its own argv element ---
{
  const inv = buildShellInvocation('bash', null, CMD);
  check(inv.file === 'bash' && eq(inv.args, ['-lc', CMD]), `bash -> -lc (got ${JSON.stringify(inv)})`);
}

// --- tcsh: the core regression. Must be -c, NEVER -lc (tcsh rejects bundled -lc) ---
{
  const inv = buildShellInvocation('/usr/bin/tcsh', null, CMD);
  check(eq(inv.args, ['-c', CMD]), `tcsh -> -c, no -lc (got ${JSON.stringify(inv.args)})`);
  check(!inv.args.includes('-lc'), 'tcsh args never contain -lc');
}

// --- csh basename resolution from an absolute path ---
check(eq(defaultArgsForShell('/bin/csh'), ['-c', '${command}']), 'csh -> -c');

// --- zsh/fish also login-shell family ---
check(eq(defaultArgsForShell('zsh'), ['-lc', '${command}']), 'zsh -> -lc');
check(eq(defaultArgsForShell('/usr/bin/fish'), ['-lc', '${command}']), 'fish -> -lc');

// --- pwsh / cmd (Windows-family arg vectors) ---
check(eq(defaultArgsForShell('pwsh'), ['-NoLogo', '-Command', '${command}']), 'pwsh -> -Command');
check(eq(defaultArgsForShell('C:\\Windows\\System32\\cmd.exe'), ['/d', '/s', '/c', '${command}']), 'cmd.exe -> /d /s /c');

// --- unknown shell falls back to a portable -c ---
check(eq(defaultArgsForShell('/opt/weirdsh'), ['-c', '${command}']), 'unknown -> -c');

// --- custom args without the token: command appended as final arg ---
{
  const inv = buildShellInvocation('bash', ['-x', '-lc'], CMD);
  check(eq(inv.args, ['-x', '-lc', CMD]), `custom no-token appends command (got ${JSON.stringify(inv.args)})`);
}

// --- custom args with the token in the middle: substituted in place ---
{
  const inv = buildShellInvocation('bash', ['-x', '${command}', '-y'], CMD);
  check(eq(inv.args, ['-x', CMD, '-y']), `token substituted in place (got ${JSON.stringify(inv.args)})`);
}

// --- empty/blank shellPath falls back to bash ---
check(buildShellInvocation('   ', null, CMD).file === 'bash', 'blank shellPath -> bash');

// --- resolveJobEnv: undefined/empty means inherit (return undefined) ---
check(resolveJobEnv(undefined, '/ws') === undefined, 'no env setting -> undefined (inherit)');
check(resolveJobEnv({}, '/ws') === undefined, 'empty env setting -> undefined (inherit)');

// --- resolveJobEnv: merges onto process.env and substitutes vars ---
{
  process.env.__EDA_TEST_BASE = 'base-value';
  const merged = resolveJobEnv({ FOO: '${workspaceFolder}/lib', BAR: '${env:__EDA_TEST_BASE}' }, '/ws');
  check(merged.FOO === '/ws/lib', `\${workspaceFolder} substituted (got ${merged.FOO})`);
  check(merged.BAR === 'base-value', `\${env:NAME} substituted (got ${merged.BAR})`);
  check(merged.PATH === process.env.PATH, 'inherited PATH preserved');
}

// --- substituteVars: unknown env ref -> empty string ---
check(substituteVars('x${env:__EDA_DEFINITELY_UNSET__}y', '/ws') === 'xy', 'unknown env ref -> empty');

console.log(failures === 0 ? '\nALL SHELL ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
