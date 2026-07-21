import * as fs from 'fs';

/**
 * Incrementally streams new bytes appended to a file, `tail -f` style. Polls via
 * `fs.stat` rather than `fs.watch`/inotify on purpose: EDA farm output files
 * (LSF/SGE `-o` files) usually live on NFS, where inotify events do not fire, so
 * only size-polling reliably notices growth. Handles truncation/rotation (size
 * shrinks) by restarting from the beginning.
 *
 * The read/offset logic is kept free of any `vscode` dependency so it can be
 * unit-tested by the standalone Node harness (test-fixtures/run-tailer-tests.mjs).
 */
export class FileTailer {
  private offset = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(
    private readonly file: string,
    private readonly onData: (chunk: string) => void,
    private readonly intervalMs = 500
  ) {}

  start(): void {
    this.stopped = false;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Read whatever has been appended since the last read and emit it. Safe to
   * call repeatedly; overlapping calls are coalesced. Exposed (and awaitable)
   * so tests can drive it deterministically without waiting on the timer.
   */
  async pollOnce(): Promise<void> {
    if (this.stopped || this.polling) {
      return;
    }
    this.polling = true;
    try {
      const size = await statSize(this.file);
      if (size === undefined) {
        return; // file not there (yet) — try again next tick
      }
      if (size < this.offset) {
        this.offset = 0; // truncated or replaced — re-read from the top
      }
      if (size === this.offset) {
        return; // nothing new
      }
      const chunk = await readRange(this.file, this.offset, size);
      this.offset = size;
      if (chunk.length > 0 && !this.stopped) {
        this.onData(chunk);
      }
    } finally {
      this.polling = false;
    }
  }
}

function statSize(file: string): Promise<number | undefined> {
  return new Promise(resolve => {
    fs.stat(file, (err, st) => resolve(err ? undefined : st.size));
  });
}

function readRange(file: string, start: number, end: number): Promise<string> {
  return new Promise(resolve => {
    // end is exclusive here; createReadStream's `end` is inclusive.
    const stream = fs.createReadStream(file, { start, end: end - 1, encoding: 'utf8' });
    let buf = '';
    stream.on('data', d => (buf += d));
    stream.on('end', () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}
