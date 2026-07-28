// Pure setup-chain assembly, deliberately free of any `vscode` import so it
// can be unit-tested by the standalone Node harness
// (test-fixtures/run-setup-chain-tests.mjs) the same way the other pure
// modules are.
//
// Before this module existed, the `source <script> && <commands> && <tail>`
// assembly was written three separate times (jobRunner.ts's
// buildShellCommand, toolIntrospect.ts's runProbe, shellEnvPanel.ts's
// buildTestCommand) and two of the three copies disagreed on whether a
// blank `setup.script`/`setup.commands` entry gets dropped -- a whitespace-
// only script broke Tool Setup's Scan and value-list Refresh while the
// identical config ran a job fine. This is the one function all three now
// call, so "what I probe is what runs" is actually true.

import * as path from 'path';

export interface SetupChainInput {
  script?: string;
  commands?: string[];
}

/**
 * `source "<abs script>" && <cmd1> && … && <tail>`, with a whitespace-only
 * script and blank command entries dropped. A relative script path resolves
 * against `workspaceRoot`; an absolute one is left alone.
 */
export function buildSetupChain(setup: SetupChainInput | undefined, tail: string, workspaceRoot: string): string {
  const steps: string[] = [];
  const script = setup?.script?.trim();
  if (script) {
    const scriptPath = path.isAbsolute(script) ? script : path.join(workspaceRoot, script);
    steps.push(`source "${scriptPath}"`);
  }
  for (const cmd of setup?.commands ?? []) {
    if (cmd.trim().length > 0) {
      steps.push(cmd);
    }
  }
  steps.push(tail);
  return steps.join(' && ');
}
