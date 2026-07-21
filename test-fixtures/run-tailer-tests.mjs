import { execSync } from 'child_process';
import { writeFileSync, appendFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Bundle the pure tailer to a temp ESM file and import it, matching the style of
// run-parser-tests.mjs / run-shell-tests.mjs.
execSync('npx esbuild ./src/tailer.ts --bundle --format=esm --platform=node --outfile=/tmp/tailer.mjs', {
  stdio: 'inherit'
});
const { FileTailer } = await import('/tmp/tailer.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'eda-tail-'));
const file = join(dir, 'run.log');

let got = '';
const tailer = new FileTailer(file, chunk => (got += chunk), 10);

// --- non-existent file: pollOnce is a no-op, no throw ---
await tailer.pollOnce();
check(got === '', 'missing file -> nothing emitted');

// --- initial content is read from the top ---
writeFileSync(file, 'line1\nline2\n');
await tailer.pollOnce();
check(got === 'line1\nline2\n', `initial content read (got ${JSON.stringify(got)})`);

// --- only newly appended bytes are emitted (no re-emit of old content) ---
got = '';
appendFileSync(file, 'line3\n');
await tailer.pollOnce();
check(got === 'line3\n', `only appended bytes emitted (got ${JSON.stringify(got)})`);

// --- no change -> nothing emitted ---
got = '';
await tailer.pollOnce();
check(got === '', 'no growth -> nothing emitted');

// --- truncation/rotation: size shrinks -> re-read from the beginning ---
got = '';
writeFileSync(file, 'fresh\n'); // shorter than before, offset resets to 0
await tailer.pollOnce();
check(got === 'fresh\n', `truncation re-reads from top (got ${JSON.stringify(got)})`);

// --- stop() makes further polls no-ops ---
tailer.stop();
got = '';
appendFileSync(file, 'after-stop\n');
await tailer.pollOnce();
check(got === '', 'stopped tailer emits nothing');

console.log(failures === 0 ? '\nALL TAILER ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
