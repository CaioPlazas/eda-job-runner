import * as vscode from 'vscode';
import { logsRootRelativeToWorkspace } from './logsRoot';

const ASKED_KEY = 'eda-job-runner.gitignorePrompted';

/**
 * Offers, once per workspace, to add the logs root to .gitignore so
 * simulation logs never end up staged for commit. Fire-and-forget: never
 * blocks a job from starting. A no-op (and never prompts at all) when
 * `logsRoot` isn't actually inside the workspace -- e.g. an absolute path
 * elsewhere on disk (see `eda-job-runner.logsDirectory`) -- there's nothing
 * meaningful to gitignore in that case.
 */
export async function ensureGitignoreEntry(
  workspaceFolder: vscode.WorkspaceFolder,
  memento: vscode.Memento,
  logsRoot: string
): Promise<void> {
  if (memento.get<boolean>(ASKED_KEY, false)) {
    return;
  }
  const ignoreLine = logsRootRelativeToWorkspace(logsRoot, workspaceFolder.uri.fsPath);
  if (!ignoreLine) {
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

  if (existing.split('\n').some(line => line.trim() === ignoreLine || line.trim() === ignoreLine.replace(/\/$/, ''))) {
    await memento.update(ASKED_KEY, true);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    `EDA Job Runner writes simulation logs to ${ignoreLine} in this workspace. Add it to .gitignore so logs are never committed?`,
    'Add to .gitignore',
    "Don't ask again"
  );

  if (choice === 'Add to .gitignore') {
    const newContent = exists ? existing.replace(/\n?$/, '\n') + `${ignoreLine}\n` : `${ignoreLine}\n`;
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent, 'utf8'));
    await memento.update(ASKED_KEY, true);
  } else if (choice === "Don't ask again") {
    await memento.update(ASKED_KEY, true);
  }
  // If the prompt was dismissed outright, ask again on the next run.
}
