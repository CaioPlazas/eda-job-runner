import { execSync } from 'child_process';

// Bundle the pure job-reorder helper to a temp ESM file and import it, the
// same approach run-shell-tests.mjs uses for shellInvocation.ts.
execSync('npx esbuild ./src/jobOrder.ts --bundle --format=esm --outfile=/tmp/jobOrder.mjs', {
  stdio: 'inherit'
});
const { computeReorderedJobs } = await import('/tmp/jobOrder.mjs');

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

const job = (id, folder) => (folder ? { id, name: id, command: 'x', cwd: '.', folder } : { id, name: id, command: 'x', cwd: '.' });

// --- reorder within the same folder: insert before a later sibling ---
{
  const jobs = [job('a', 'F'), job('b', 'F'), job('c', 'F')];
  const next = computeReorderedJobs(jobs, 'c', 'b', 'F');
  check(eq(next.map(j => j.id), ['a', 'c', 'b']), `insert before sibling in same folder (got ${JSON.stringify(next.map(j => j.id))})`);
}

// --- move to a different folder, inserting before a target there ---
{
  const jobs = [job('a', 'F'), job('b', 'G'), job('c', 'G')];
  const next = computeReorderedJobs(jobs, 'a', 'c', 'G');
  check(
    eq(
      next.map(j => [j.id, j.folder]),
      [
        ['b', 'G'],
        ['a', 'G'],
        ['c', 'G']
      ]
    ),
    `move across folders + insert before target (got ${JSON.stringify(next.map(j => [j.id, j.folder]))})`
  );
}

// --- drop at folder end (no beforeId) lands after that folder's last job ---
{
  const jobs = [job('a', 'F'), job('z'), job('b', 'F')];
  const next = computeReorderedJobs(jobs, 'z', undefined, 'F');
  check(eq(next.map(j => j.id), ['a', 'b', 'z']), `drop at folder end (got ${JSON.stringify(next.map(j => j.id))})`);
}

// --- move to root/ungrouped, appended at the end of the root group ---
{
  const jobs = [job('a'), job('b', 'F'), job('c')];
  const next = computeReorderedJobs(jobs, 'b', undefined, undefined);
  check(
    eq(next.map(j => [j.id, j.folder]), [
      ['a', undefined],
      ['c', undefined],
      ['b', undefined]
    ]),
    `move to root, appended after last ungrouped job (got ${JSON.stringify(next.map(j => [j.id, j.folder]))})`
  );
}

// --- unknown id is a no-op, returns the same array reference ---
{
  const jobs = [job('a'), job('b')];
  const next = computeReorderedJobs(jobs, 'nope', 'a', undefined);
  check(next === jobs, 'unknown id is a no-op (same array reference)');
}

// --- beforeId === id (the dragged item itself vanishes from the search once
// removed, so this degrades to "append at end of its group", same as
// beforeId being absent -- the tree controller itself guards against a
// self-drop before ever calling this, so this only documents the fallback) ---
{
  const jobs = [job('a'), job('b'), job('c')];
  const next = computeReorderedJobs(jobs, 'b', 'b', undefined);
  check(eq(next.map(j => j.id), ['a', 'c', 'b']), `beforeId===id falls back to group-end append (got ${JSON.stringify(next.map(j => j.id))})`);
}

console.log(failures === 0 ? '\nAll reorder tests passed.' : `\n${failures} reorder test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
