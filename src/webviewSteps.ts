// Pure HTML/CSS/JS strings for the ① Environment → ② Tool → ③ Job (→ ④
// Parameters, optional) setup-flow stepper shared by all four config panels.
// No `vscode` import, so this is unit-tested by the standalone Node harness
// (test-fixtures/run-steps-tests.mjs) the same way webviewHelp.ts's sibling
// modules are -- see setupState.ts for the impure state computation this
// renders.
//
// D8 is the one rule every caller must preserve: ④ is numbered and
// clickable, but it hangs off a separator, never an arrow, and never
// renders a state glyph while `todo` -- an arrow or a glyph there would
// make ④ read as a required fourth chore, which the user explicitly
// rejected in favor of "optional, trailing, outside the arrow chain."

export type StepId = 1 | 2 | 3 | 4;
export type StepState = 'todo' | 'ok' | 'warn';

export interface StepStatus {
  env: StepState;
  tool: StepState;
  job: StepState;
  params: StepState;
}

const STEP_LABELS: Record<StepId, string> = {
  1: 'Environment',
  2: 'Tool',
  3: 'Job',
  4: 'Parameters & value lists'
};

/** Command each step's stepper button/Next-button opens — shared by every panel's `openStep` handler. */
export const STEP_COMMAND: Record<StepId, string> = {
  1: 'eda-job-runner.configureShell',
  2: 'eda-job-runner.configureTools',
  3: 'eda-job-runner.addJob',
  4: 'eda-job-runner.configureParams'
};

interface StepCopy {
  headline: string;
  why: string;
  skipIf?: string;
  doneWhen: string;
}

// Copy is final-draft per the plan -- implemented close to verbatim. No
// vendor or tool name may appear here (Finding #16); enforced by a deny-list
// test in run-steps-tests.mjs so a future edit can't quietly reintroduce one.
const STEP_COPY: Record<StepId, StepCopy> = {
  1: {
    headline: '① Environment — Make your tools reachable',
    why:
      'Every tool scan and every job run is launched through the shell, environment variables and setup commands you set here. ' +
      'Get this right and the next two steps just work; get it wrong and they fail for reasons that look unrelated.',
    skipIf: 'your tools already work in a plain terminal — the defaults use the same shell as your VS Code terminal.',
    doneWhen: '<em>Test Shell Setup</em> passes.'
  },
  2: {
    headline: '② Tool — Teach the extension your tool\'s flags',
    why:
      'Registering a command runs its help output through the shell from step ①, and turns the flags it prints into checkboxes. ' +
      'A job\'s Command can then be built by clicking instead of typed from memory.',
    skipIf: 'you\'d rather type the command yourself — a build target, or a wrapper script. Jobs never require a registered tool.',
    doneWhen: 'at least one tool scans with no errors.'
  },
  3: {
    headline: '③ Job — Define what you actually run',
    why:
      'A job is a named command plus where it runs. Running one gives you a log, a pass/fail result, and its errors and warnings in the Problems panel.',
    doneWhen: 'you\'ve saved a job and run it once.'
  },
  4: {
    headline: '④ Parameters & value lists — Reusable values and dropdowns',
    why:
      'Name a value once and reference it from any job\'s Command as <code>${var:NAME}</code>. A value list turns a file — or a command\'s output, ' +
      'such as a test list — into a dropdown you pick from instead of typing.',
    skipIf: 'most workspaces never need this. Reach for it when you\'re pasting the same string into several jobs, or picking a name out of a list by hand.',
    doneWhen: '' // no completion -- it's an enhancement, not a task
  }
};

const DONE_LINE_PREFIX: Record<StepId, string> = {
  1: '✓ Shell setup tested.',
  2: '', // callers pass a computed "✓ N tools registered." string
  3: '', // callers pass a computed "✓ N jobs · last run: <name> passed" string
  4: '' // callers pass a computed "✓ N parameters, M value lists" string
};

export const STEPS_CSS = `
  .stepper { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-bottom: 6px; font-size: 13px; }
  .stepper .step { cursor: pointer; padding: 2px 6px; border-radius: 3px; border: none; background: none; color: var(--vscode-foreground); font: inherit; }
  .stepper .step:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,0.15)); }
  .stepper .step.current { font-weight: 600; text-decoration: underline; }
  .stepper .arrow { color: var(--vscode-descriptionForeground); margin: 0 2px; }
  .stepper .sep { color: var(--vscode-descriptionForeground); margin: 0 8px; }
  .stepper .glyph-ok { color: var(--vscode-charts-green); }
  .stepper .glyph-warn { color: var(--vscode-charts-yellow); }
  .stepper .glyph-todo { color: var(--vscode-descriptionForeground); }
  .stepper .step4 { color: var(--vscode-descriptionForeground); }
  .stepCaption { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 0 0 10px 0; }
  .stepIntro { border-left: 3px solid var(--vscode-textLink-foreground, var(--vscode-focusBorder)); padding: 6px 10px; margin-bottom: 10px; background: var(--vscode-textBlockQuote-background, transparent); }
  .stepIntro.warn { border-left-color: var(--vscode-charts-yellow); }
  .stepIntro h3 { margin: 0 0 4px 0; font-size: 14px; }
  .stepIntro p { margin: 4px 0; font-size: 13px; color: var(--vscode-descriptionForeground); }
  .stepIntro .doneLine { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .stepIntro .doneLine .ok { color: var(--vscode-charts-green); }
  .stepIntro .whatsThis { background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }
  .stepIntro .fullText { display: none; }
  .stepIntro .fullText.expanded { display: block; margin-top: 8px; }
  .stepRecipe { margin-bottom: 10px; font-size: 13px; }
  .stepRecipe summary { cursor: pointer; color: var(--vscode-textLink-foreground); }
  .stepRecipe ol { margin: 6px 0 0 0; padding-left: 20px; color: var(--vscode-descriptionForeground); }
  .setupError { border-left: 3px solid var(--vscode-charts-yellow); padding: 6px 10px; margin: 8px 0; font-size: 13px; }
  .setupError .probeLine { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.15)); padding: 4px 6px; margin: 6px 0; white-space: pre-wrap; }
  .setupError .actions { margin-top: 8px; display: flex; gap: 8px; }
`;

function glyph(state: StepState, isStep4: boolean): string {
  if (isStep4 && state === 'todo') {
    return ''; // D8: step 4 never gets a glyph while todo -- muted text only
  }
  if (state === 'ok') {
    return '<span class="glyph-ok">✓</span> ';
  }
  if (state === 'warn') {
    return '<span class="glyph-warn">⚠</span> ';
  }
  return '<span class="glyph-todo">○</span> ';
}

function stateFor(step: StepId, status: StepStatus): StepState {
  switch (step) {
    case 1:
      return status.env;
    case 2:
      return status.tool;
    case 3:
      return status.job;
    case 4:
      return status.params;
  }
}

/** Breadcrumb: ① → ② → ③, then a separated ④ (D8: never an arrow, never a glyph while todo). */
export function stepperHtml(current: StepId, status: StepStatus): string {
  const stepBtn = (step: StepId, label: string) => {
    const state = stateFor(step, status);
    const isStep4 = step === 4;
    const cls = ['step', step === current ? 'current' : '', isStep4 ? 'step4' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${cls}" data-step="${step}">${glyph(state, isStep4)}${label}</button>`;
  };

  const chain = [
    stepBtn(1, '① Environment'),
    '<span class="arrow">→</span>',
    stepBtn(2, '② Tool'),
    '<span class="arrow">→</span>',
    stepBtn(3, '③ Job')
  ].join('');

  const step4 = stepBtn(4, '④ Parameters & value lists (optional)');

  const anyIncomplete = status.env !== 'ok' || status.tool !== 'ok' || status.job !== 'ok';
  const caption = anyIncomplete
    ? `<p class="stepCaption">Each step feeds the next — the shell from ① runs ②'s scan, and ②'s flags build ③'s command.</p>`
    : '';

  return `<div class="stepper">${chain}<span class="sep">·</span>${step4}</div>${caption}`;
}

/**
 * The self-erasing banner (D9). `state !== 'ok'` renders the full
 * headline / why / skip-if / done-when block from the step contract;
 * `state === 'ok'` renders the one-line `doneLine` plus a "What's this?"
 * toggle that re-expands the full text client-side.
 */
export function stepIntroHtml(step: StepId, state: StepState, doneLine?: string): string {
  const copy = STEP_COPY[step];
  const cls = state === 'warn' ? 'stepIntro warn' : 'stepIntro';

  const fullText = `
    <h3>${copy.headline}</h3>
    <p>${copy.why}</p>
    ${copy.skipIf ? `<p><strong>Skip if</strong> ${copy.skipIf}</p>` : ''}
    ${copy.doneWhen ? `<p><strong>Done when</strong> ${copy.doneWhen}</p>` : ''}
  `;

  if (state !== 'ok') {
    return `<div class="${cls}">${fullText}</div>`;
  }

  const line = doneLine || DONE_LINE_PREFIX[step] || '✓ Done.';
  return `
    <div class="${cls}">
      <div class="doneLine"><span class="ok">${line}</span> <button type="button" class="whatsThis" data-step="${step}">What's this?</button></div>
      <div class="fullText" data-step-fulltext="${step}">${fullText}</div>
    </div>
  `;
}

const RECIPE_STEPS: Record<StepId, string[]> = {
  1: [
    'Open a terminal where your tool already runs correctly.',
    'Whatever you type — or your shell startup files run — before launching it is what belongs here: a file you source → <strong>Setup script</strong>; commands you run each time → <strong>Setup commands</strong>, one per line; variables you export (licence servers, install roots) → <strong>Environment variables</strong>.',
    'Not sure what your site uses? Check your shell startup file, your team\'s onboarding notes, or whoever maintains the tool installation.',
    'If your tool only works from a particular directory, put it in <strong>Post-setup working directory</strong>.',
    'Click <strong>Test Shell Setup</strong>. Add anything you want confirmed — a licence variable, a <code>which</code> — under <em>Also check</em>.'
  ],
  2: [
    '<strong>Command</strong> is exactly what you type in a terminal to launch the tool. If it\'s a script in your project, use its path — or <strong>Browse…</strong>.',
    'Click <strong>Find it</strong> to confirm the name resolves after your step ① setup.',
    'Click <strong>Scan</strong>. The flags it prints become checkboxes for your jobs.',
    'Nothing found? Use <strong>Show output</strong> to see what it actually printed, and try a different help argument.',
    '<strong>Sub-commands</strong> are only for tools that take a mode as their first argument, each with its own flags. If yours doesn\'t, skip it.'
  ],
  3: [
    '<strong>Command</strong>: what you\'d type to run one build or one test.',
    '<strong>Working Directory</strong>: where you\'d be standing when you typed it.',
    'Tick flags under <strong>Tool builder</strong> instead of typing them, if you registered a tool in step ②.',
    'Check the <strong>Will run</strong> box below the Command — it shows exactly what will execute, and where. If it doesn\'t match what you\'d type by hand, fix it now.',
    '<strong>Save & Run.</strong>'
  ],
  4: [
    'Pasting the same string into several jobs? Make it a <strong>parameter</strong> and reference it as <code>${var:NAME}</code>.',
    'Picking a name out of a file or a command\'s output by hand? Make that a <strong>value list</strong> and pick it from a dropdown instead.',
    'Point the list at the file or command, then <strong>Refresh</strong> to see what it found.'
  ]
};

/**
 * P5's "How do I fill this in?" recipe. A `<details>` auto-expanded only
 * when `state === 'todo' && isEmpty` (genuine first visit), collapsed
 * otherwise, and returning '' when `state === 'ok'` — the same self-erasing
 * rule as `stepIntroHtml`.
 */
export function stepRecipeHtml(step: StepId, state: StepState, isEmpty: boolean): string {
  if (state === 'ok') {
    return '';
  }
  const items = RECIPE_STEPS[step].map(s => `<li>${s}</li>`).join('');
  const open = state === 'todo' && isEmpty ? ' open' : '';
  return `<details class="stepRecipe"${open}><summary>How do I fill this in?</summary><ol>${items}</ol></details>`;
}

/** Next-step button for the bottom action row; '' for steps 3 and 4. */
export function nextStepButtonHtml(current: StepId): string {
  if (current === 3 || current === 4) {
    return '';
  }
  const next = (current + 1) as StepId;
  return `<button type="button" class="secondary" data-open-step="${next}">Next: ${STEP_LABELS[next]} →</button>`;
}

/** Explanatory block for a scan/list failure that is probably a step-① problem. */
export function setupErrorHtml(message: string, probeCommand?: string): string {
  const probeLine = probeCommand ? `<div class="probeLine">${escapeHtml(probeCommand)}</div>` : '';
  return `
    <div class="setupError">
      <div>⚠ ${escapeHtml(message)}</div>
      ${probeCommand ? `<p>The scan ran this through your configured shell:</p>${probeLine}` : ''}
      <p>If this tool needs a module load or a licence variable first, set it in Shell &amp; Environment.</p>
      <div class="actions">
        <button type="button" class="secondary" data-open-step="1">Open Shell &amp; Environment</button>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Client-side JS: step clicks + Next → postMessage({type:'openStep', step}); What's-this toggle. */
export const STEPS_JS = `
  document.addEventListener('click', event => {
    const stepBtn = event.target.closest('[data-step]');
    if (stepBtn && !stepBtn.classList.contains('whatsThis')) {
      vscode.postMessage({ type: 'openStep', step: Number(stepBtn.dataset.step) });
      return;
    }
    const nextBtn = event.target.closest('[data-open-step]');
    if (nextBtn) {
      vscode.postMessage({ type: 'openStep', step: Number(nextBtn.dataset.openStep) });
      return;
    }
    const whatsThis = event.target.closest('.whatsThis');
    if (whatsThis) {
      const step = whatsThis.dataset.step;
      const fullText = document.querySelector('[data-step-fulltext="' + step + '"]');
      if (fullText) {
        fullText.classList.toggle('expanded');
      }
    }
  });
`;
