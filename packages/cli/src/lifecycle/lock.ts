import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, stat, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { inspectProcess } from './processes.js';
import type { BrcPaths } from '../config/paths.js';

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export class LifecycleLock {
  private queue: Promise<void> = Promise.resolve();
  private readonly context = new AsyncLocalStorage<LifecycleLock>();

  constructor(private readonly paths: BrcPaths) {}

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.context.getStore() === this) {
      return Promise.reject(new Error('Lifecycle lock cannot be acquired recursively.'));
    }
    const result = this.queue.then(() => this.execute(operation));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.runtime, { recursive: true });
    const identity = await inspectProcess(process.pid);
    if (!identity) throw new Error('Cannot verify the CLI process identity for lifecycle locking.');

    const filename = path.join(this.paths.runtime, 'lifecycle.lock');
    const id = randomUUID();
    let handle: FileHandle;
    try {
      handle = await open(filename, 'wx', 0o600);
    } catch (error) {
      if (errorCode(error) === 'EEXIST') throw new Error('Another BRC lifecycle operation is in progress.');
      throw error;
    }

    const identityOnDisk = await handle.stat();
    let recordWritten = false;
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, ...identity, workspaceRoot: this.paths.root, id })}\n`, 'utf8');
      recordWritten = true;
      return await this.context.run(this, operation);
    } finally {
      try {
        await handle.close();
      } finally {
        await this.releaseIfOwned(filename, id, identityOnDisk, recordWritten);
      }
    }
  }

  private async releaseIfOwned(
    filename: string,
    id: string,
    identityOnDisk: Awaited<ReturnType<FileHandle['stat']>>,
    recordWritten: boolean,
  ): Promise<void> {
    if (recordWritten) {
      let contents: string;
      try {
        contents = await readFile(filename, 'utf8');
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }

      let record: unknown;
      try {
        record = JSON.parse(contents) as unknown;
      } catch {
        return;
      }
      if (!record || typeof record !== 'object' || Array.isArray(record) || !('id' in record) || record.id !== id) return;
    } else {
      let current;
      try {
        current = await stat(filename);
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return;
        throw error;
      }
      if (current.dev !== identityOnDisk.dev || current.ino !== identityOnDisk.ino) return;
    }

    try {
      await unlink(filename);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
