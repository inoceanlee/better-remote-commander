import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ManagedServiceSpec } from './processes.js';

export class RelayDatabase {
  constructor(
    private readonly file: string,
    private readonly relay: Pick<ManagedServiceSpec, 'entrypoint' | 'cwd' | 'env'>,
  ) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  initializeForNewRoot(rootWasEmpty: boolean, administrator?: { username: string; password: string }): void {
    if (this.exists()) return;
    if (!rootWasEmpty) {
      throw new Error(`Relay database is missing at ${this.file}; refusing to create a replacement identity in an existing data root.`);
    }

    const result = spawnSync(process.execPath, [this.relay.entrypoint, '--initialize'], {
      cwd: this.relay.cwd,
      env: { ...this.relay.env, BRC_DB: this.file },
      encoding: 'utf8',
      input: administrator ? JSON.stringify(administrator) : '',
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error) throw new Error(`Unable to initialize Relay database: ${result.error.message}`);
    if (result.status !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `Relay database initializer exited with code ${result.status ?? 'unknown'}.`;
      throw new Error(detail);
    }
    this.assertExists();
  }

  assertExists(): void {
    if (!this.exists()) {
      throw new Error(`Relay database is missing at ${this.file}; run brc setup for a new data root or restore the existing database.`);
    }
  }
}
