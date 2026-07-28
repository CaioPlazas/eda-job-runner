// Pure "what will actually run" resolver, deliberately free of any `vscode`
// import so it can be unit-tested by the standalone Node harness
// (test-fixtures/run-command-preview-tests.mjs) the same way the other pure
// modules are.
//
// Composes only existing exported functions -- writes no new substitution
// logic -- so the preview can never drift from what jobRunner.ts actually
// runs. `${param:NAME}` cannot be resolved ahead of time (it prompts per
// run); it is rendered literally as `<prompts at run time>`.

import * as path from 'path';
import { buildSetupChain, SetupChainInput } from './setupChain';
import { buildShellInvocation, substituteVars } from './shellInvocation';
import { substituteParamVars, parseVars } from './paramVars';
import { parseParams } from './paramSubstitution';

export interface PreviewInput {
  command: string;
  cwd?: string;
  postSetupCwd?: string;
  workspaceRoot: string;
  setup?: SetupChainInput;
  shellPath: string;
  shellArgs: string[] | null;
  globalParams: Record<string, string>;
  overrides: Record<string, string>;
}

export interface Preview {
  /** cwd resolved against postSetupCwd then the workspace root. */
  resolvedCwd: string;
  /** e.g. `/bin/tcsh -c`. */
  invocation: string;
  /** setup chain && substituted command. */
  fullCommand: string;
  vars: { name: string; defined: boolean }[];
  /** `${param:NAME}` placeholders, rendered as `<prompts at run time>`. */
  prompts: string[];
}

const PROMPT_PLACEHOLDER = '<prompts at run time>';

export function buildPreview(input: PreviewInput): Preview {
  const effectivePostSetupCwd = (input.postSetupCwd && input.postSetupCwd.trim()) || '';
  const baseDir = effectivePostSetupCwd
    ? path.resolve(input.workspaceRoot, substituteVars(effectivePostSetupCwd, input.workspaceRoot))
    : input.workspaceRoot;
  const resolvedCwd = path.resolve(baseDir, input.cwd || '.');

  const prompts = parseParams(input.command).map(p => p.name);
  // ${param:NAME} is left literal (rendered as the placeholder text) since it
  // can only be resolved interactively at Run time -- never guessed ahead of
  // time here.
  let withParamsRendered = input.command;
  for (const p of parseParams(input.command)) {
    withParamsRendered = withParamsRendered.split(`\${param:${p.name}}`).join(PROMPT_PLACEHOLDER);
    if (p.default) {
      withParamsRendered = withParamsRendered.split(`\${param:${p.name}=${p.default}}`).join(PROMPT_PLACEHOLDER);
    }
  }

  const varNames = parseVars(input.command);
  const vars = varNames.map(name => ({
    name,
    defined: Object.prototype.hasOwnProperty.call(input.overrides, name) || Object.prototype.hasOwnProperty.call(input.globalParams, name)
  }));

  const substitutedCommand = substituteParamVars(withParamsRendered, input.globalParams, input.overrides);
  const fullCommand = buildSetupChain(input.setup, substitutedCommand, input.workspaceRoot);

  const { file, args } = buildShellInvocation(input.shellPath, input.shellArgs, '');
  // The invocation display is just "<file> <args minus the trailing command
  // placeholder>" -- buildShellInvocation always appends/substitutes the
  // command as the final element when given an empty string, so drop it.
  const invocationArgs = args.slice(0, -1);
  const invocation = [file, ...invocationArgs].join(' ').trim();

  return { resolvedCwd, invocation, fullCommand, vars, prompts };
}
