import * as vscode from 'vscode';
import * as fs from 'fs';
import { FileTailer } from './tailer';

/**
 * A live, self-refreshing log viewer: a read-only pseudo-terminal that the
 * extension streams a file into via FileTailer (`tail -f`). Unlike opening the
 * log as an editor tab — which only updates when VS Code passively reloads the
 * file from disk — this pushes new bytes as they land, so it stays real-time
 * even for output written out-of-band (e.g. an LSF/SGE `-o` file on NFS).
 */
export class LogLiveView {
  private static readonly openByFile = new Map<string, vscode.Terminal>();

  /** `onClose`, if given, fires when the user actually closes this tail's terminal -- not when `show()` just re-focuses an already-open one for the same file. Lets a caller keep its own "which files are being tailed" record in sync. */
  static show(jobName: string, filePath: string, onClose?: () => void): void {
    const existing = LogLiveView.openByFile.get(filePath);
    if (existing) {
      existing.show();
      return;
    }

    const writeEmitter = new vscode.EventEmitter<string>();
    // Pseudo-terminals want CRLF line endings; the file uses LF.
    const emit = (text: string) => writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
    const tailer = new FileTailer(filePath, emit);

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        emit(`\x1b[2m── live tail: ${filePath} ──\x1b[0m\n`);
        if (!fs.existsSync(filePath)) {
          emit('\x1b[2m(waiting for the file to appear…)\x1b[0m\n');
        }
        tailer.start();
      },
      close: () => {
        tailer.stop();
        writeEmitter.dispose();
        LogLiveView.openByFile.delete(filePath);
        onClose?.();
      },
      // Read-only: swallow input.
      handleInput: () => undefined
    };

    const terminal = vscode.window.createTerminal({ name: `EDA Live: ${jobName}`, pty });
    LogLiveView.openByFile.set(filePath, terminal);
    terminal.show();
  }
}
