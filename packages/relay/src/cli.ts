#!/usr/bin/env node
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { applyLegacyEnv, installManagedLog, startManagedControlServer, type ManagedControlServer } from 'brc-shared';
applyLegacyEnv();
const managedLog = installManagedLog();
import { buildRelay, loadConfig } from './app.js';
import { SqliteStore } from './store/sqlite.js';

const cfg = loadConfig();
if (process.argv.includes('--initialize')) {
  try {
    SqliteStore.initialize(cfg.dbFile);
    const input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8').trim();
    if (input) {
      const administrator = JSON.parse(input) as { username?: unknown; password?: unknown };
      if (typeof administrator.username !== 'string' || typeof administrator.password !== 'string') {
        throw new Error('Invalid administrator setup input.');
      }
      const store = SqliteStore.open(cfg.dbFile);
      try { store.bootstrapAdministrator(administrator.username, administrator.password); }
      finally { store.close(); }
    }
  } catch (error) {
    console.error(`Relay database initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    await managedLog?.close();
    process.exit(1);
  }
  await managedLog?.close();
  process.exit(0);
}

const log = (level: string, msg: string) => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
};

let relay: ReturnType<typeof buildRelay>;
try {
  relay = buildRelay(cfg, log);
} catch (error) {
  console.error(`Relay startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await managedLog?.close();
  process.exit(1);
}
const listening = once(relay.http, 'listening');
relay.http.listen(cfg.port, cfg.host);
await listening;
log('info', `brc-relay ${cfg.relayVersion} listening on ${cfg.host}:${cfg.port}`);
log('info', `public URL ${cfg.publicUrl}  MCP: ${cfg.publicUrl}/mcp  pair: ${cfg.publicUrl}/device/verify`);

let control: ManagedControlServer | undefined;
let stopping = false;
const stop = async (sig?: string) => {
  if (stopping) return;
  stopping = true;
  if (sig) log('info', `${sig} received, shutting down`);
  await control?.close();
  await relay.close();
  await managedLog?.close();
};
process.on('SIGINT', () => { void stop('SIGINT').catch((error: unknown) => log('error', String(error))); });
process.on('SIGTERM', () => { void stop('SIGTERM').catch((error: unknown) => log('error', String(error))); });
control = await startManagedControlServer({
  health: async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${cfg.port}/health`);
      return response.ok
        ? { state: 'running', detail: 'Relay health endpoint is ready.' }
        : { state: 'degraded', detail: `Relay health returned HTTP ${response.status}.` };
    } catch {
      return { state: 'degraded', detail: 'Relay health endpoint is unavailable.' };
    }
  },
  stop: () => stop(),
});
