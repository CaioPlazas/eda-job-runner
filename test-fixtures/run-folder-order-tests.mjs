import { execSync } from 'child_process';

// Bundle the pure folder-reorder helper to a temp ESM file and import it,
// the same approach run-reorder-tests.mjs uses for jobOrder.ts.
execSync('npx esbuild ./src/folderOrder.ts --bundle --format=esm --outfile=/tmp/folderOrder.mjs', {
  stdio: 'inherit'
});
const { computeReorderedFolders } = await import('/tmp/folderOrder.mjs');

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

// --- insert before a later folder ---
{
  const next = computeReorderedFolders(['A', 'B', 'C'], 'C', 'B');
  check(eq(next, ['A', 'C', 'B']), `insert before a later folder (got ${JSON.stringify(next)})`);
}

// --- insert before an earlier folder ---
{
  const next = computeReorderedFolders(['A', 'B', 'C'], 'C', 'A');
  check(eq(next, ['C', 'A', 'B']), `insert before an earlier folder (got ${JSON.stringify(next)})`);
}

// --- no beforeName -> append to the end ---
{
  const next = computeReorderedFolders(['A', 'B', 'C'], 'A', undefined);
  check(eq(next, ['B', 'C', 'A']), `no beforeName -> append to end (got ${JSON.stringify(next)})`);
}

// --- beforeName not found -> append to the end (same as undefined) ---
{
  const next = computeReorderedFolders(['A', 'B', 'C'], 'A', 'nope');
  check(eq(next, ['B', 'C', 'A']), `unknown beforeName -> append to end (got ${JSON.stringify(next)})`);
}

// --- unknown name is a no-op, returns the same array reference ---
{
  const folders = ['A', 'B'];
  const next = computeReorderedFolders(folders, 'nope', 'A');
  check(next === folders, 'unknown name is a no-op (same array reference)');
}

// --- beforeName === name falls back to end-of-list append (name is removed before the search) ---
{
  const next = computeReorderedFolders(['A', 'B', 'C'], 'B', 'B');
  check(eq(next, ['A', 'C', 'B']), `beforeName===name falls back to end append (got ${JSON.stringify(next)})`);
}

console.log(failures === 0 ? '\nAll folder-order tests passed.' : `\n${failures} folder-order test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
