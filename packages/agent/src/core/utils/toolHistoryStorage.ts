import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import lockfile from 'proper-lockfile';

export class ToolHistoryStorage {
  readonly file: string;

  constructor(directory: string) {
    if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'tool-history.jsonl');
  }

  withLock<T>(operation: () => T): T {
    let release: (() => void) | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        release = lockfile.lockSync(this.file, { realpath: false, stale: 120_000 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ELOCKED' || attempt === 99) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return operation();
    } finally {
      // A release error must not cause a committed write to be queued again.
      try { release!(); } catch { /* The lock expires if removal fails. */ }
    }
  }

  readText(): string | null {
    try {
      return fs.readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  size(): number {
    try {
      return fs.statSync(this.file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  appendText(text: string): void {
    this.rewriteText((this.readText() ?? '') + text);
  }

  rewriteText(text: string): void {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, text, { encoding: 'utf-8', flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* The rename removes the temporary file. */ }
    }
  }
}
