import * as vscode from 'vscode';

/**
 * The guard for "this panel is about to overwrite a change it never saw".
 *
 * Both `.vscode/*.json` files are deliberately hand-editable and shared in
 * git, so they change from outside this extension all the time: someone edits
 * one by hand, switches branch, pulls. A panel, meanwhile, holds the snapshot
 * it rendered from — possibly minutes ago. Pressing Save wrote that snapshot
 * straight over whatever had arrived in the meantime, with no warning and no
 * way to notice afterwards.
 *
 * The store side of this is `storeSync.ts`'s revision counter; this is the
 * decision the user gets when a panel's revision no longer matches.
 *
 * Deliberately *not* offered here: an automatic merge. These files hold
 * arbitrary user structure, and silently combining two versions of a job
 * definition is a worse failure than either version winning outright.
 */
export async function confirmOverwriteIfStale(fileLabel: string, changed: boolean): Promise<boolean> {
  if (!changed) {
    return true;
  }
  const choice = await vscode.window.showWarningMessage(
    `${fileLabel} changed on disk since this window was opened.`,
    {
      modal: true,
      detail:
        'Saving now replaces those changes with what this panel is showing.\n\n' +
        'Cancel leaves everything as it is — your edits stay in this panel, so you can copy anything you need, ' +
        'close it, and reopen it to see the current file.'
    },
    'Save anyway'
  );
  return choice === 'Save anyway';
}

/** The same question as a one-line, non-modal warning — for an automatic save, where a modal dialog would be an ambush. */
export function staleWriteHint(fileLabel: string): string {
  return `${fileLabel} changed on disk — not saving automatically. Press Save to overwrite it with what's on screen.`;
}
