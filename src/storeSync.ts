/**
 * The bookkeeping that keeps a workspace JSON store (`jobStore.ts`,
 * `toolStore.ts`) and its file on disk from disagreeing. Pure and
 * `vscode`-free so it can be unit-tested (`run-store-sync-tests.mjs`) —
 * the stores themselves own the actual fs calls and the watcher.
 *
 * Both stores have the same shape: an in-memory copy of a hand-editable,
 * git-shareable `.vscode/*.json` file, written back atomically, with a
 * `FileSystemWatcher` reloading the copy whenever the file changes. Two
 * things went wrong with that, and this module is the fix for both.
 *
 * **1. An older read could land last.** `load()` assigned whatever it read
 * unconditionally. Every write triggers the watcher, so loads and writes
 * overlap constantly; two overlapping loads can finish out of order, leaving
 * memory holding an older snapshot than disk. Nothing looks wrong — but the
 * next edit is built on that stale object and written back, silently
 * reverting the newer change on disk. `LoadGuard` makes a load applicable
 * only if it is still the newest load *and* no write started after it did.
 *
 * **2. We reloaded our own writes.** Every `persist()` produced a watcher
 * event and a full re-read + re-parse + change event, for content we already
 * had. `isSelfWrite` recognises it by exact text and skips the whole cycle.
 */

export interface LoadAttempt {
  /** Value of the store's load counter when this load started. */
  loadSeq: number;
  /** Value of the store's write counter when this load started. */
  writeSeqAtStart: number;
}

/**
 * Tracks the two counters a store needs. One instance per store; every
 * mutation of the counters goes through here so the rules stay in one place.
 */
export class LoadGuard {
  private loadSeq = 0;
  private writeSeq = 0;
  private lastWrittenText: string | undefined;

  /** Call at the top of `load()`, before the first `await`. */
  beginLoad(): LoadAttempt {
    this.loadSeq += 1;
    return { loadSeq: this.loadSeq, writeSeqAtStart: this.writeSeq };
  }

  /**
   * Call once a load's read has come back, before assigning it to the store's
   * in-memory copy. False means "throw this result away": either a newer load
   * has started since (its result is the one that should win), or a write
   * happened while we were reading (the file on disk is newer than what we
   * just read, and that write's own watcher event will bring us a fresh read).
   */
  shouldApply(attempt: LoadAttempt): boolean {
    return attempt.loadSeq === this.loadSeq && attempt.writeSeqAtStart === this.writeSeq;
  }

  /** Call at the start of a write, before it touches the disk. */
  beginWrite(text: string): void {
    this.writeSeq += 1;
    this.lastWrittenText = text;
  }

  /**
   * True when `text` read off disk is byte-identical to what this store last
   * wrote — i.e. the watcher event we're reacting to is our own write coming
   * back. Re-parsing it would be pure work for a result we already have, and
   * the `onDidChange` event it fires makes every listener redraw for nothing.
   *
   * Deliberately compares content rather than timing: a same-content write by
   * *anything else* (a colleague's identical formatting, a git checkout that
   * restores the same bytes) is equally a no-op, and a timing-based guard
   * would be a race in a way this isn't.
   */
  isSelfWrite(text: string): boolean {
    return this.lastWrittenText !== undefined && text === this.lastWrittenText;
  }

  /**
   * Bumped every time the in-memory copy actually changes — from a write or
   * from an applied external reload. Panels record the value they rendered
   * from and re-check it before saving, which is how a hand-edit made while a
   * panel was open stops being silently overwritten.
   */
  get revision(): number {
    return this.loadSeq + this.writeSeq;
  }
}
