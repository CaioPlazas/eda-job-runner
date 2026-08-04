import { execSync } from 'child_process';

// Bundle the pure store-sync module and import it, matching the style of the
// other run-*-tests.mjs harnesses.
execSync('npx esbuild ./src/storeSync.ts --bundle --format=esm --platform=node --outfile=/tmp/storeSync.mjs', {
  stdio: 'inherit'
});
const { LoadGuard } = await import('/tmp/storeSync.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

// --- the ordinary case ----------------------------------------------------

{
  const g = new LoadGuard();
  const a = g.beginLoad();
  check(g.shouldApply(a), 'a load with nothing else happening applies');
}

// --- two overlapping loads: only the newest one may win -------------------
// This is the lost-update bug. Both reads are in flight; whichever read
// returns last used to win, even if it was the older read of an older file.

{
  const g = new LoadGuard();
  const first = g.beginLoad();
  const second = g.beginLoad();
  check(!g.shouldApply(first), 'an older overlapping load is discarded even if its read returns last');
  check(g.shouldApply(second), 'the newest load still applies');
}

// --- a write that starts mid-read invalidates that read -------------------
// The read saw the pre-write file. Applying it would put memory behind disk,
// and the next edit would be built on it and written back, reverting the write.

{
  const g = new LoadGuard();
  const attempt = g.beginLoad();
  g.beginWrite('{"jobs":[]}');
  check(!g.shouldApply(attempt), 'a read that started before an in-flight write is discarded');
}

{
  const g = new LoadGuard();
  g.beginWrite('{"jobs":[]}');
  const attempt = g.beginLoad(); // started *after* the write
  check(g.shouldApply(attempt), 'a read started after the write applies normally');
}

// --- self-write recognition ----------------------------------------------

{
  const g = new LoadGuard();
  const text = '{\n  "version": 1,\n  "jobs": []\n}\n';
  check(!g.isSelfWrite(text), 'nothing is a self-write before anything has been written');
  g.beginWrite(text);
  check(g.isSelfWrite(text), 'byte-identical content is recognised as our own write');
  check(!g.isSelfWrite(text + ' '), 'content that differs by one byte is not our write');
  g.beginWrite('{"jobs":[{"id":"a"}]}');
  check(!g.isSelfWrite(text), 'only the most recent write counts as ours');
}

// --- revision: strictly increases on any load or write --------------------
// Panels capture this when they render and re-check it before saving, so an
// edit made to the file underneath an open panel can be noticed.

{
  const g = new LoadGuard();
  const start = g.revision;
  g.beginLoad();
  check(g.revision > start, 'a load moves the revision');
  const afterLoad = g.revision;
  g.beginWrite('x');
  check(g.revision > afterLoad, 'a write moves the revision');
}

// --- a full realistic sequence -------------------------------------------
// Save -> our own watcher event -> a genuine external edit.

{
  const g = new LoadGuard();
  const ours = '{"jobs":["ours"]}';
  g.beginWrite(ours);
  const revAfterSave = g.revision;

  // The watcher fires for our own write: recognised, skipped entirely.
  check(g.isSelfWrite(ours), 'the watcher event for our own save is recognised');

  // Now someone edits the file by hand.
  const theirs = '{"jobs":["theirs"]}';
  check(!g.isSelfWrite(theirs), 'a hand edit is not mistaken for our own write');
  const attempt = g.beginLoad();
  check(g.shouldApply(attempt), 'the hand edit is applied');
  check(g.revision > revAfterSave, 'the applied external change is visible as a revision bump');
}

console.log(failures === 0 ? '\nALL STORE-SYNC ASSERTIONS PASSED' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
