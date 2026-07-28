import { execSync } from 'child_process';

execSync('npx esbuild ./src/webviewSteps.ts --bundle --format=esm --outfile=/tmp/webviewSteps.mjs', {
  stdio: 'inherit'
});
const { setupErrorHtml, OPEN_STEP_JS } = await import('/tmp/webviewSteps.mjs');

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failures++;
  } else {
    console.log('ok:', msg);
  }
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
{
  const html = setupErrorHtml('exited 127');
  check(html.includes('data-open-step="1"'), 'recovery button opens step 1 (Shell & Environment)');
}

// --- OPEN_STEP_JS is a non-empty client script wiring the openStep postMessage ---
check(
  typeof OPEN_STEP_JS === 'string' && OPEN_STEP_JS.includes('openStep') && OPEN_STEP_JS.includes('data-open-step'),
  'OPEN_STEP_JS wires [data-open-step] clicks to the openStep postMessage'
);

if (failures > 0) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
} else {
  console.log('\nAll webviewSteps tests passed.');
}
