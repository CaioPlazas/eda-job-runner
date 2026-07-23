import { execSync } from 'child_process';

execSync('npx esbuild ./src/logRetention.ts --bundle --format=esm --outfile=/tmp/logRetention.mjs', {
  stdio: 'inherit'
});
const { planPrune } = await import('/tmp/logRetention.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
}

const f = (path, size) => ({ path, size });
// Newest-first, matching listRuns's convention.
const five = [f('r5', 100), f('r4', 100), f('r3', 100), f('r2', 100), f('r1', 100)];

// --- both 0/unlimited -> nothing deleted ---
check(planPrune(five, { maxCount: 0, maxTotalBytes: 0 }).length === 0, 'both caps off -> deletes nothing');

// --- count-only ---
check(
  JSON.stringify(planPrune(five, { maxCount: 2, maxTotalBytes: 0 })) === JSON.stringify(['r3', 'r2', 'r1']),
  'count-only: keeps the 2 newest, deletes the rest oldest-first order'
);
check(planPrune(five, { maxCount: 10, maxTotalBytes: 0 }).length === 0, 'count cap above the actual count -> deletes nothing');

// --- size-only ---
check(
  JSON.stringify(planPrune(five, { maxCount: 0, maxTotalBytes: 250 })) === JSON.stringify(['r3', 'r2', 'r1']),
  'size-only: keeps r5+r4 (200 bytes, under the 250 cap), deletes the rest once r3 would push it over'
);
check(planPrune(five, { maxCount: 0, maxTotalBytes: 100000 }).length === 0, 'size cap far above the actual total -> deletes nothing');

// --- both together: count cap applies first, then size cap among survivors ---
check(
  JSON.stringify(planPrune(five, { maxCount: 3, maxTotalBytes: 150 })) === JSON.stringify(['r2', 'r1', 'r4', 'r3']),
  'count cap (keep 3) applies first, then size cap (150 bytes) prunes further among those 3 survivors (only r5 fits under 150 bytes)'
);

// --- edge cases ---
check(planPrune([], { maxCount: 5, maxTotalBytes: 500 }).length === 0, 'empty input -> deletes nothing');
check(
  JSON.stringify(planPrune([f('only', 1000)], { maxCount: 0, maxTotalBytes: 1 })) === JSON.stringify(['only']),
  'a single run alone already over the size cap is still deleted (no "keep at least one" exemption)'
);

console.log(failures === 0 ? '\nAll log-retention tests passed.' : `\n${failures} log-retention test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
