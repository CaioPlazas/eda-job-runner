import { execSync } from 'child_process';

// Bundle the list migration module to a temp ESM file and import it, the
// same approach run-list-tests.mjs uses for listSource.ts.
execSync('npx esbuild ./src/listMigration.ts --bundle --format=esm --outfile=/tmp/listMigration.mjs', {
  stdio: 'inherit'
});
const { planListMigration } = await import('/tmp/listMigration.mjs');

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

// --- Test 1: No legacy tools -> existing globals unchanged, no renames ---
{
  const existingGlobals = [
    { name: 'GlobalTests', values: ['global1', 'global2'] }
  ];
  const result = planListMigration(existingGlobals, []);
  check(eq(result.lists, existingGlobals), `no legacy -> lists unchanged (got ${JSON.stringify(result.lists)})`);
  check(eq(result.renames, []), `no legacy -> renames empty (got ${JSON.stringify(result.renames)})`);
}

// --- Test 2: Legacy list with no name collision -> added to output, no rename ---
{
  const existingGlobals = [
    { name: 'GlobalTests', values: ['global1'] }
  ];
  const legacy = [
    {
      toolId: 'toolA',
      lists: [{ name: 'ToolA_List', values: ['val1', 'val2'] }]
    }
  ];
  const result = planListMigration(existingGlobals, legacy);
  check(result.lists.length === 2, `no collision -> both lists present (got ${result.lists.length})`);
  check(eq(result.renames, []), `no collision -> renames empty (got ${JSON.stringify(result.renames)})`);
  const toolList = result.lists.find(l => l.name === 'ToolA_List');
  check(toolList !== undefined, 'no collision -> legacy list found in output');
  check(eq(toolList.values, ['val1', 'val2']), 'no collision -> legacy list values preserved');
}

// --- Test 3: Legacy list colliding with existing global -> global wins, legacy dropped, no rename ---
{
  const existingGlobals = [
    { name: 'Tests', values: ['existing_global_val'] }
  ];
  const legacy = [
    {
      toolId: 'toolA',
      lists: [{ name: 'Tests', values: ['legacy_val'] }]
    }
  ];
  const result = planListMigration(existingGlobals, legacy);
  check(result.lists.length === 1, `collides with global -> only one list (got ${result.lists.length})`);
  const kept = result.lists[0];
  check(kept.name === 'Tests', 'collides with global -> name is Tests');
  check(eq(kept.values, ['existing_global_val']), 'collides with global -> existing global values preserved (got ' + JSON.stringify(kept.values) + ')');
  check(eq(result.renames, []), 'collides with global -> no rename recorded (got ' + JSON.stringify(result.renames) + ')');
}

// --- Test 4: Two legacy tools with same name -> first keeps name, second renamed ---
{
  const existingGlobals = [];
  const legacy = [
    {
      toolId: 'toolA',
      lists: [{ name: 'Tests', values: ['toolA_val'] }]
    },
    {
      toolId: 'toolB',
      lists: [{ name: 'Tests', values: ['toolB_val'] }]
    }
  ];
  const result = planListMigration(existingGlobals, legacy);
  check(result.lists.length === 2, `two legacy same name -> two lists (got ${result.lists.length})`);
  const first = result.lists.find(l => l.name === 'Tests');
  const second = result.lists.find(l => l.name === 'Tests (2)');
  check(first !== undefined, 'two legacy same name -> first keeps original name "Tests"');
  check(second !== undefined, 'two legacy same name -> second renamed to "Tests (2)"');
  check(eq(first.values, ['toolA_val']), 'two legacy same name -> first has toolA values');
  check(eq(second.values, ['toolB_val']), 'two legacy same name -> second has toolB values');
  check(result.renames.length === 1, 'two legacy same name -> exactly one rename (got ' + result.renames.length + ')');
  check(result.renames[0].toolId === 'toolB', 'two legacy same name -> rename records toolB');
  check(result.renames[0].from === 'Tests', 'two legacy same name -> rename from is "Tests"');
  check(result.renames[0].to === 'Tests (2)', 'two legacy same name -> rename to is "Tests (2)"');
}

// --- Test 5a: scanDir inheritance: list with no scanDir inherits toolScanDir ---
{
  const existingGlobals = [];
  const legacy = [
    {
      toolId: 'toolA',
      toolScanDir: '/some/dir',
      lists: [{ name: 'Tests', values: ['val1'] }]
    }
  ];
  const result = planListMigration(existingGlobals, legacy);
  const list = result.lists.find(l => l.name === 'Tests');
  check(list !== undefined, 'scanDir inherit -> list found');
  check(list.scanDir === '/some/dir', `scanDir inherit -> inherited from toolScanDir (got ${JSON.stringify(list.scanDir)})`);
}

// --- Test 5b: scanDir inheritance: list's own scanDir wins over toolScanDir ---
{
  const existingGlobals = [];
  const legacy = [
    {
      toolId: 'toolA',
      toolScanDir: '/some/dir',
      lists: [{ name: 'Tests', scanDir: '/own/dir', values: ['val1'] }]
    }
  ];
  const result = planListMigration(existingGlobals, legacy);
  const list = result.lists.find(l => l.name === 'Tests');
  check(list !== undefined, 'scanDir own wins -> list found');
  check(list.scanDir === '/own/dir', `scanDir own wins -> list keeps own scanDir (got ${JSON.stringify(list.scanDir)})`);
}

console.log(failures === 0 ? '\nAll list-migration tests passed.' : `\n${failures} list-migration test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
