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
  planPrune([f('only', 1000)], { maxCount: 0, maxTotalBytes: 1 }).length === 0,
  'the newest (only) run is never deleted by the size cap, even alone over it'
);

// --- batch families: a repeat-count batch's lanes (`_<i>-<total>.log`) count as one family ---
const batchNewest = [f('t9_3-3.log', 50), f('t8_2-3.log', 50), f('t7_1-3.log', 50)]; // one batch of 3, newest -- 150 bytes total
const soloMiddle = [f('t6.log', 50)]; // a single non-batch run
const batchOlder = [f('t5_3-3.log', 50), f('t4_2-3.log', 50), f('t3_1-3.log', 50)]; // an older batch of 3 -- 150 bytes total
const withBatches = [...batchNewest, ...soloMiddle, ...batchOlder]; // 3 families: newest batch, solo, older batch

check(
  JSON.stringify(planPrune(withBatches, { maxCount: 2, maxTotalBytes: 0 }).sort()) ===
    JSON.stringify(['t3_1-3.log', 't4_2-3.log', 't5_3-3.log'].sort()),
  'count cap of 2 families keeps the newest batch (3 files) + the solo run intact, deletes the whole older batch'
);
check(
  JSON.stringify(planPrune(withBatches, { maxCount: 1, maxTotalBytes: 0 }).sort()) ===
    JSON.stringify(['t3_1-3.log', 't4_2-3.log', 't5_3-3.log', 't6.log'].sort()),
  'count cap of 1 family keeps only the newest batch as a whole -- the solo run and the older batch are all pruned, never split'
);
check(
  planPrune(batchNewest, { maxCount: 0, maxTotalBytes: 1 }).length === 0,
  'the newest family is never size-pruned even when it is a multi-file batch that alone exceeds the cap'
);
check(
  JSON.stringify(planPrune(withBatches, { maxCount: 0, maxTotalBytes: 250 }).sort()) ===
    JSON.stringify(['t3_1-3.log', 't4_2-3.log', 't5_3-3.log'].sort()),
  'size cap keeps the newest batch (150 bytes) + solo run (200 total, under the 250 cap) intact, cuts the whole older batch once it would push over'
);
check(
  (() => {
    // A batch stopped early (killed) after only 2 of 10 iterations still forms one family.
    const partial = [f('p2_2-10.log', 50), f('p1_1-10.log', 50)];
    return planPrune(partial, { maxCount: 0, maxTotalBytes: 1 }).length === 0;
  })(),
  'a batch interrupted before reaching its total still closes its family at i===1, and is still the newest family exemption'
);

console.log(failures === 0 ? '\nAll log-retention tests passed.' : `\n${failures} log-retention test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
