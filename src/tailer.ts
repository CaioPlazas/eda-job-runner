import * as fs from 'fs';

/** Optional behaviours a caller can opt into; the defaults reproduce the original "read the whole file from byte 0, unbounded" tailer exactly. */
export interface FileTailerOptions {
  /**
   * Cap on how many bytes a single read+emit covers. A poll still catches up
   * fully -- it just does so in several bounded reads, awaiting between them,
   * so the extension host stays responsive instead of building one
   * whole-file string. Unset means unbounded (one read per poll).
   */
  maxBytesPerRead?: number;
  /**
   * `'end'` skips whatever is already on disk when the file is first seen and
   * only emits what arrives afterwards; a number starts from that exact byte
   * offset (for a caller that already read the earlier bytes itself and knows
   * where it stopped -- see logLiveView.ts). For viewers that just want live
   * output; anything that has to rebuild cumulative state from the whole run
   * must stay on the default `'beginning'`.
   */
  startAt?: 'beginning' | 'end' | number;
}

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
  /** True only while a drain is actually running -- lets the interval skip a tick instead of piling work up behind a slow one. */
  private draining = false;
  /** Serializes drains so an explicit `pollOnce()` always runs *after* whatever is in flight, never silently instead of it. */
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytesPerRead: number;
  private seekedToEnd: boolean;

  constructor(
    private readonly file: string,
    private readonly onData: (chunk: string) => void,
    private readonly intervalMs = 500,
    options: FileTailerOptions = {}
  ) {
    this.maxBytesPerRead = options.maxBytesPerRead && options.maxBytesPerRead > 0 ? options.maxBytesPerRead : Infinity;
    if (typeof options.startAt === 'number') {
      this.offset = Math.max(0, options.startAt);
    }
    // `true` here means "no seek pending" -- every start point except 'end' is
    // known up front; 'end' can only be resolved once the file has been seen.
    this.seekedToEnd = options.startAt !== 'end';
  }

  start(): void {
    this.stopped = false;
    void this.pollOnce();
    this.timer = setInterval(() => {
      // A drain always reads everything that's new, so skipping a tick while
      // one is running loses nothing -- it just avoids queueing a backlog of
      // polls behind a slow read (large catch-up, or a stalled NFS mount).
      if (!this.draining) {
        void this.pollOnce();
      }
    }, this.intervalMs);
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
   * call repeatedly; calls are serialized rather than dropped, so a caller
   * awaiting a final flush (see jobRunner's finish()) is guaranteed to see
   * every byte written before it called -- even if a scheduled poll happened
   * to be in flight at that moment. Exposed (and awaitable) so tests can
   * drive it deterministically without waiting on the timer.
   */
  pollOnce(): Promise<void> {
    const next = this.queue.then(() => this.drain());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async drain(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.draining = true;
    try {
      // Loop rather than read once: with maxBytesPerRead set, catching up on a
      // log that grew while we weren't looking takes several reads, and each
      // await yields the event loop between them.
      for (;;) {
        const size = await statSize(this.file);
        if (size === undefined) {
          return; // file not there (yet) — try again next tick
        }
        if (!this.seekedToEnd) {
          this.offset = size;
          this.seekedToEnd = true;
          return;
        }
        if (size < this.offset) {
          this.offset = 0; // truncated or replaced — re-read from the top
        }
        if (size === this.offset) {
          return; // nothing new
        }
        const end = Math.min(size, this.offset + this.maxBytesPerRead);
        const chunk = await readRange(this.file, this.offset, end);
        this.offset = end;
        if (chunk.length > 0 && !this.stopped) {
          this.onData(chunk);
        }
        if (this.stopped || end === size) {
          return;
        }
      }
    } finally {
      this.draining = false;
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
    // Collect-then-join rather than `buf += d`: a large catch-up read would
    // otherwise build thousands of intermediate strings, each a full copy.
    const parts: string[] = [];
    stream.on('data', d => parts.push(d as string));
    stream.on('end', () => resolve(parts.join('')));
    stream.on('error', () => resolve(parts.join('')));
  });
}
