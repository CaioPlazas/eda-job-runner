import * as vscode from 'vscode';
import { JobStore } from './jobStore';

// T2.1's zero-config on-ramp (D3): three jobs that need nothing installed --
// no simulator, no tool registration, just commands any shell already has --
// so a brand-new user can try Run/Stop/the log/the Problems panel before
// setting up anything real. Written through JobStore.addJob (never a raw
// writeFile) so they're indistinguishable from a hand-created job.

const EXAMPLE_PREFIX = 'example: ';

export async function createExampleJobs(jobStore: JobStore): Promise<void> {
  const alreadyExists = jobStore.getJobs().some(j => j.name.startsWith(EXAMPLE_PREFIX));
  if (alreadyExists) {
    void vscode.window.showInformationMessage('EDA Job Runner: example jobs already exist.');
    return;
  }

  await jobStore.addJob({
    name: `${EXAMPLE_PREFIX}passes`,
    command: 'echo "TEST RESULT: PASS"',
    cwd: '.'
  });
  await jobStore.addJob({
    name: `${EXAMPLE_PREFIX}fails`,
    command: 'echo "UVM_ERROR fake error"; exit 1',
    cwd: '.'
  });
  await jobStore.addJob({
    name: `${EXAMPLE_PREFIX}slow (try Stop)`,
    command: 'for i in $(seq 1 30); do echo "step $i"; sleep 1; done',
    cwd: '.'
  });

  void vscode.window.showInformationMessage('EDA Job Runner: added 3 example jobs -- try Run, Stop, and the log.');
}
