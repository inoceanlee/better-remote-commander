#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { applyLegacyEnv, installManagedLog, startManagedControlServer, type ManagedControlServer } from 'brc-shared';
applyLegacyEnv();
const managedLog = installManagedLog();
import { buildRelay, loadConfig } from './app.js';

const cfg = loadConfig();
if (!cfg.adminPassword) {
  console.error('BRC_ADMIN_PASSWORD is required');
  await managedLog?.close();
  process.exit(2);
}
if (!cfg.sessionSecret) {
  cfg.sessionSecret = randomBytes(32).toString('hex');
  console.warn('BRC_SESSION_SECRET not set: using a random secret (browser sessions reset on restart)');
}

const log = (level: string, msg: string) => {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
};

const relay = buildRelay(cfg, log);
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
