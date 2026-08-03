import * as vscode from 'vscode';
import * as fs from 'fs';
import { FileTailer } from './tailer';
import { readTailChunk } from './logManager';

/**
 * How much of an already-written log is replayed when a live view opens. The
 * view starts at end-of-file rather than replaying everything: a job that has
 * been running all night has a log far larger than a terminal's scrollback can
 * hold, and pushing all of it through a pseudo-terminal in one write froze the
 * window (this view also reopens by itself for every running job after a
 * reload). This seed is just enough recent context to see where the run is;
 * the full log is one click away as a normal editor tab.
 */
const SEED_TAIL_BYTES = 16 * 1024;

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
    // Built in open(), once the seed read below knows which offset to continue
    // from -- see SEED_TAIL_BYTES for why this doesn't replay from byte 0.
    let tailer: FileTailer | undefined;
    // The seed read is async, so the terminal can be closed before it lands;
    // without this, that would start a polling tailer nothing ever stops.
    let closed = false;

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      open: () => {
        emit(`\x1b[2m── live tail: ${filePath} ──\x1b[0m\n`);
        if (!fs.existsSync(filePath)) {
          emit('\x1b[2m(waiting for the file to appear…)\x1b[0m\n');
        }
        void readTailChunk(filePath, SEED_TAIL_BYTES)
          .then(seed => {
            if (seed.truncated) {
              emit(
                `\x1b[2m(showing the last ${Math.round(SEED_TAIL_BYTES / 1024)} KB — open the log file for everything before this)\x1b[0m\n`
              );
            }
            if (seed.text) {
              emit(seed.text);
            }
            return seed.endOffset;
          })
          .catch(() => 0)
          .then(startAt => {
            if (closed) {
              return;
            }
            // Continue from exactly where the seed stopped, so nothing written
            // in between is skipped or shown twice.
            tailer = new FileTailer(filePath, emit, undefined, { startAt });
            tailer.start();
          });
      },
      close: () => {
        closed = true;
        tailer?.stop();
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
