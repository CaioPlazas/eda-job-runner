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

// --- maxBytesPerRead: one poll still catches up fully, in several reads ---
const cappedFile = join(dir, 'capped.log');
writeFileSync(cappedFile, 'a'.repeat(10));
const chunks = [];
const capped = new FileTailer(cappedFile, chunk => chunks.push(chunk), 10, { maxBytesPerRead: 4 });
await capped.pollOnce();
check(chunks.join('') === 'a'.repeat(10), `capped read still delivers everything (got ${JSON.stringify(chunks.join(''))})`);
check(chunks.length === 3, `capped read is split into bounded chunks (got ${chunks.length} chunks: ${JSON.stringify(chunks)})`);
capped.stop();

// --- startAt 'end': existing content is skipped, later appends are not ---
const endFile = join(dir, 'end.log');
writeFileSync(endFile, 'already-there\n');
let endGot = '';
const fromEnd = new FileTailer(endFile, chunk => (endGot += chunk), 10, { startAt: 'end' });
await fromEnd.pollOnce();
check(endGot === '', `startAt 'end' skips existing content (got ${JSON.stringify(endGot)})`);
appendFileSync(endFile, 'new-line\n');
await fromEnd.pollOnce();
check(endGot === 'new-line\n', `startAt 'end' still emits later appends (got ${JSON.stringify(endGot)})`);
fromEnd.stop();

// --- startAt <offset>: resumes from exactly where a caller left off ---
const offsetFile = join(dir, 'offset.log');
writeFileSync(offsetFile, 'HEADheadTAILtail');
let offsetGot = '';
const fromOffset = new FileTailer(offsetFile, chunk => (offsetGot += chunk), 10, { startAt: 8 });
await fromOffset.pollOnce();
check(offsetGot === 'TAILtail', `numeric startAt resumes at that byte (got ${JSON.stringify(offsetGot)})`);
fromOffset.stop();

// --- a pollOnce() issued while another poll is in flight still sees the tail ---
// This is what finish() depends on: the old implementation dropped the call
// outright when `polling` was set, so a run's last lines could go unparsed and
// a passPattern job could be reported as failed.
const raceFile = join(dir, 'race.log');
writeFileSync(raceFile, 'first\n');
let raceGot = '';
const racer = new FileTailer(raceFile, chunk => (raceGot += chunk), 10);
const inFlight = racer.pollOnce();
appendFileSync(raceFile, 'last\n');
await racer.pollOnce(); // issued while the first poll may still be running
await inFlight;
check(raceGot.includes('last\n'), `overlapping pollOnce still flushes the tail (got ${JSON.stringify(raceGot)})`);
racer.stop();

console.log(failures === 0 ? '\nALL TAILER ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
