import { execSync } from 'child_process';

execSync('npx esbuild ./src/webviewSteps.ts --bundle --format=esm --outfile=/tmp/webviewSteps.mjs', {
  stdio: 'inherit'
});
const { stepperHtml, stepIntroHtml, stepRecipeHtml, nextStepButtonHtml, setupErrorHtml, STEPS_JS } = await import(
  '/tmp/webviewSteps.mjs'
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

const allOk = { env: 'ok', tool: 'ok', job: 'ok', params: 'ok' };
const allTodo = { env: 'todo', tool: 'todo', job: 'todo', params: 'todo' };
const mixed = { env: 'ok', tool: 'warn', job: 'todo', params: 'todo' };

// --- stepperHtml matrix: every step (1-4) x every status combination renders without throwing ---
for (const status of [allOk, allTodo, mixed]) {
  for (const step of [1, 2, 3, 4]) {
    const html = stepperHtml(step, status);
    check(typeof html === 'string' && html.length > 0, `stepperHtml(${step}, ${JSON.stringify(status)}) renders`);
  }
}

// --- D8: the arrow chain stops at ③ -- ④ is separated by a middot, never an arrow ---
{
  const html = stepperHtml(1, allTodo);
  const sepIndex = html.indexOf('<span class="sep">');
  const lastArrowIndex = html.lastIndexOf('<span class="arrow">');
  check(sepIndex > lastArrowIndex, 'the "·" separator appears after the last arrow, not before (④ is outside the arrow chain)');
  // Nothing that looks like an arrow glyph appears between the separator and the end (④'s own button).
  const afterSep = html.slice(sepIndex);
  check(!afterSep.slice(20).includes('arrow'), '④ itself is not wrapped in another arrow span');
}

// --- D8: ④ renders no glyph when todo ---
{
  const html = stepperHtml(1, allTodo);
  const step4Match = html.match(/<button[^>]*data-step="4"[^>]*>([^<]*(?:<span[^>]*>[^<]*<\/span>)?[^<]*)/);
  check(!!step4Match, 'step 4 button found in markup');
  check(!html.includes('glyph-todo">○</span> ④'), '④ does not render the "todo" ○ glyph');
  // None of the ok/warn/todo glyph classes appear immediately before ④'s label when todo.
  const idx4 = html.indexOf('data-step="4"');
  const btn4Html = html.slice(idx4, html.indexOf('</button>', idx4));
  check(!/glyph-(ok|warn|todo)/.test(btn4Html), `④ carries no state glyph at all when todo (got ${btn4Html})`);
}
{
  // When ④ is 'ok', it's still allowed a glyph -- only 'todo' is glyph-less per D8.
  const html = stepperHtml(1, allOk);
  const idx4 = html.indexOf('data-step="4"');
  const btn4Html = html.slice(idx4, html.indexOf('</button>', idx4));
  check(btn4Html.includes('glyph-ok'), `④ shows a glyph when its own state is ok (got ${btn4Html})`);
}

// --- dependency caption appears while any of ①②③ is not ok, absent once all three are ok ---
{
  const withCaption = stepperHtml(1, mixed);
  check(withCaption.includes('Each step feeds the next'), 'caption present while ①②③ incomplete');
  const withoutCaption = stepperHtml(1, allOk);
  check(!withoutCaption.includes('Each step feeds the next'), 'caption absent once ①②③ are all ok');
}

// --- stepIntroHtml: full block for todo/warn, one-line + toggle for ok ---
{
  const todoHtml = stepIntroHtml(1, 'todo');
  check(todoHtml.includes('Done when'), 'todo state renders the full banner (Done when present)');
  check(todoHtml.includes('Skip if'), 'todo state renders the Skip if line for step 1');

  const okHtml = stepIntroHtml(1, 'ok', '✓ Shell setup tested.');
  check(okHtml.includes('✓ Shell setup tested.'), 'ok state renders the supplied done line');
  check(okHtml.includes("What's this?"), 'ok state renders the What\'s this? toggle');
  const fullTextBlock = okHtml.slice(okHtml.indexOf('class="fullText"'));
  check(fullTextBlock.includes('<h3>'), 'ok state keeps the full headline present but inside the collapsed fullText block (for client-side re-expand)');
}

// --- step ③ never emits a skip line (it is the destination, no skip condition) ---
{
  const todoHtml = stepIntroHtml(3, 'todo');
  check(!todoHtml.includes('Skip if'), `step 3 has no Skip if line (got: ${todoHtml})`);
}

// --- stepRecipeHtml: auto-expanded only for todo && isEmpty ---
{
  const openRecipe = stepRecipeHtml(1, 'todo', true);
  check(openRecipe.includes('<details class="stepRecipe" open>'), 'recipe auto-expanded on genuine first visit (todo && empty)');

  const collapsedRecipe = stepRecipeHtml(1, 'todo', false);
  check(
    collapsedRecipe.includes('<details class="stepRecipe">') && !collapsedRecipe.includes('open>'),
    'recipe collapsed when todo but not empty'
  );

  const noneWhenOk = stepRecipeHtml(1, 'ok', false);
  check(noneWhenOk === '', 'recipe returns empty string once step is ok');
}

// --- setupErrorHtml: with and without a probe command, HTML-escaped ---
{
  const withoutProbe = setupErrorHtml('exited 127 with no recognizable options');
  check(withoutProbe.includes('exited 127'), 'message rendered without a probe command');
  check(!withoutProbe.includes('probeLine'), 'no probe-command block when none supplied');

  const withProbe = setupErrorHtml('exited 127', 'module load <foo> && xrun --help');
  check(withProbe.includes('probeLine'), 'probe-command block present when supplied');
  check(withProbe.includes('&lt;foo&gt;'), 'probe command is HTML-escaped (< and > become entities)');
  check(!withProbe.includes('<foo>'), 'raw unescaped probe command does not leak into markup');
}
{
  const withAmp = setupErrorHtml('failed', 'echo $A && echo $B');
  check(withAmp.includes('&amp;&amp;'), 'ampersands in the probe command are escaped');
}

// --- nextStepButtonHtml: absent for steps 3 and 4 ---
{
  check(nextStepButtonHtml(1).includes('Next:'), 'step 1 has a Next button');
  check(nextStepButtonHtml(2).includes('Next:'), 'step 2 has a Next button');
  check(nextStepButtonHtml(3) === '', 'step 3 has no Next button');
  check(nextStepButtonHtml(4) === '', 'step 4 has no Next button');
}

// --- Finding #16: no recipe or banner string contains a vendor/tool name ---
{
  const VENDOR_DENY_LIST = [
    'xcelium',
    'questa',
    'vcs',
    'verilator',
    'icarus',
    'iverilog',
    'dsim',
    'modelsim',
    'vivado',
    'quartus',
    'synopsys',
    'cadence',
    'mentor',
    'xilinx',
    'altera'
  ];
  const allStrings = [];
  for (const step of [1, 2, 3, 4]) {
    allStrings.push(stepIntroHtml(step, 'todo'));
    allStrings.push(stepRecipeHtml(step, 'todo', true));
  }
  const combined = allStrings.join('\n').toLowerCase();
  for (const vendor of VENDOR_DENY_LIST) {
    check(!combined.includes(vendor), `no occurrence of vendor/tool name "${vendor}" in step copy`);
  }
}

// --- STEPS_JS is a non-empty client script ---
check(typeof STEPS_JS === 'string' && STEPS_JS.includes('openStep'), 'STEPS_JS wires the openStep postMessage');

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll webviewSteps tests passed.');
}
