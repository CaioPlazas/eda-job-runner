import * as vscode from 'vscode';

const ASKED_KEY = 'eda-job-runner.gitignorePrompted';
const IGNORE_LINE = '.eda-runner/';

/**
 * Offers, once per workspace, to add .eda-runner/ to .gitignore so
 * simulation logs never end up staged for commit. Fire-and-forget: never
 * blocks a job from starting.
 */
export async function ensureGitignoreEntry(workspaceFolder: vscode.WorkspaceFolder, memento: vscode.Memento): Promise<void> {
  if (memento.get<boolean>(ASKED_KEY, false)) {
    return;
  }

  const gitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore');
  let existing = '';
  let exists = true;
  try {
    existing = Buffer.from(await vscode.workspace.fs.readFile(gitignoreUri)).toString('utf8');
  } catch {
    exists = false;
  }

  if (existing.split('\n').some(line => line.trim() === IGNORE_LINE || line.trim() === '.eda-runner')) {
    await memento.update(ASKED_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'EDA Job Runner writes simulation logs to .eda-runner/ in this workspace. Add it to .gitignore so logs are never committed?',
    'Add to .gitignore',
    "Don't ask again"
  );

  if (choice === 'Add to .gitignore') {
    const newContent = exists ? existing.replace(/\n?$/, '\n') + `${IGNORE_LINE}\n` : `${IGNORE_LINE}\n`;
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent, 'utf8'));
    await memento.update(ASKED_KEY, true);
  } else if (choice === "Don't ask again") {
    await memento.update(ASKED_KEY, true);
  }
  // If the prompt was dismissed outright, ask again on the next run.
}
