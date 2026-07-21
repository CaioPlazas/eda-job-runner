import { readFileSync } from 'fs';
import { execSync } from 'child_process';

// Compile the parser to plain JS via esbuild-less approach: use tsc output? 
// Simpler: transpile inline with a tiny require of the .ts is not possible.
// Instead, bundle just the parser to a temp CJS file with esbuild.
execSync('npx esbuild ./src/logParser.ts --bundle --format=esm --outfile=/tmp/logParser.mjs', { stdio: 'inherit' });
const { newParseState, parseLine } = await import('/tmp/logParser.mjs');

function parseFile(path) {
  const st = newParseState();
  for (const line of readFileSync(path, 'utf8').split('\n')) parseLine(line, st);
  return st;
}

let failures = 0;
function check(cond, msg) { if (!cond) { console.error('FAIL:', msg); failures++; } else console.log('ok:', msg); }

// --- DSim UVM fail: expect exactly 1 error (the UVM_ERROR message, NOT the summary), 1 warning ---
const dsimFail = parseFile('./test-fixtures/dsim_uvm_fail.log');
check(dsimFail.errorCount === 1, `dsim fail errorCount=1 (got ${dsimFail.errorCount})`);
check(dsimFail.warningCount === 1, `dsim fail warningCount=1 (got ${dsimFail.warningCount})`);
const uvmErr = dsimFail.issues.find(i => i.source === 'uvm' && i.severity === 'error');
check(uvmErr && uvmErr.file === 'tb/uvm_smoke_test.sv' && uvmErr.line === 22, `dsim fail UVM error located at tb/uvm_smoke_test.sv:22 (got ${uvmErr?.file}:${uvmErr?.line})`);

// --- DSim UVM pass: expect 0 errors, 1 warning; the "UVM_ERROR : 0" summary must NOT count ---
const dsimPass = parseFile('./test-fixtures/dsim_uvm_pass.log');
check(dsimPass.errorCount === 0, `dsim pass errorCount=0 -- summary row excluded (got ${dsimPass.errorCount})`);
check(dsimPass.warningCount === 1, `dsim pass warningCount=1 (got ${dsimPass.warningCount})`);

// --- Questa vlog error: 2 errors, both located at broken.sv line 6 ---
const questa = parseFile('./test-fixtures/questa_vlog_error.log');
check(questa.errorCount === 2, `questa errorCount=2 (got ${questa.errorCount})`);
const qLocated = questa.issues.filter(i => i.line === 6 && /broken\.sv/.test(i.file || ''));
check(qLocated.length === 2, `questa both errors located at broken.sv:6 (got ${qLocated.length})`);

// --- Icarus error: at least the 2 "error:" lines located at broken.sv ---
const icarus = parseFile('./test-fixtures/iverilog_error.log');
check(icarus.errorCount >= 2, `icarus errorCount>=2 (got ${icarus.errorCount})`);
check(icarus.issues.every(i => i.line && /broken\.sv/.test(i.file||'')), `icarus all issues located in broken.sv`);

// --- DSim compile error: 1 error at broken_dsim.sv:4:27 ---
const dsimC = parseFile('./test-fixtures/dsim_compile_error.log');
const dc = dsimC.issues.find(i => /broken_dsim\.sv/.test(i.file||''));
check(dc && dc.line === 4 && dc.column === 27, `dsim compile error at broken_dsim.sv:4:27 (got ${dc?.file}:${dc?.line}:${dc?.column})`);

// --- Real UVM regression (uvm_alu +BUG): 46 UVM_ERROR message lines, and the
//     "UVM_ERROR :   46" summary row must NOT double-count; all point to the
//     scoreboard's `uvm_error at tb/alu_pkg.sv:160 ---
const aluFail = parseFile('./test-fixtures/dsim_uvm_alu_fail.log');
check(aluFail.errorCount === 46, `uvm_alu fail errorCount=46, summary excluded (got ${aluFail.errorCount})`);
check(aluFail.issues.filter(i => i.file === 'tb/alu_pkg.sv' && i.line === 160).length === 46,
      `uvm_alu all 46 errors located at tb/alu_pkg.sv:160`);

// --- Verilator errors (real `verilator --lint-only -Wall` capture): 3 located
//     errors; the "%Error: Exiting due to 3 error(s)" summary has no
//     file:line:col and so never matches, no exclusion logic needed ---
const vErr = parseFile('./test-fixtures/verilator_error.log');
check(vErr.errorCount === 3, `verilator errorCount=3, summary excluded (got ${vErr.errorCount})`);
check(
  vErr.issues.filter(i => i.source === 'verilator' && /broken\.sv/.test(i.file || '') && i.column).length === 3,
  'verilator errors located with file:line:column'
);

// --- Verilator warnings: 3 located warnings; "%Error: Exiting due to 3
//     warning(s)" is itself %Error-prefixed but has no location, so it's
//     correctly not counted as an error ---
const vWarn = parseFile('./test-fixtures/verilator_warn.log');
check(vWarn.warningCount === 3, `verilator warningCount=3 (got ${vWarn.warningCount})`);
check(vWarn.errorCount === 0, `verilator errorCount=0 -- warning-summary row excluded (got ${vWarn.errorCount})`);

console.log(failures === 0 ? '\nALL PARSER ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
