// One-shot e2e runner: boots relay + agent on a scratch port/db, auto-pairs, runs all suites, tears down.
// pnpm test:e2e     (needs `pnpm build` first)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not select a loopback port for e2e.');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
const PORT = Number(process.env.E2E_PORT ?? await availablePort());
const base = `http://127.0.0.1:${PORT}`;
const pass = 'e2e-pass-' + Math.random().toString(36).slice(2, 8);
// realpath: Windows runners hand out 8.3 short paths (RUNNER~1) which crash libuv's fs.watch
const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-e2e-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayCli = path.resolve('packages/relay/dist/cli.js');
const agentCli = path.resolve('packages/agent/dist/cli.js');

function start(name, args, env) {
  const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = '';
  p.stdout.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${d}`); });
  p.stderr.on('data', (d) => { p.out += d; if (process.env.E2E_VERBOSE) process.stderr.write(`[${name}] ${d}`); });
  procs.push(p);
  return p;
}

async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { try { const v = await fn(); if (v) return v; } catch {} await sleep(400); }
  throw new Error(`timeout waiting for ${what}`);
}

function runScript(script, ...args) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timeout = setTimeout(() => {
      p.kill();
      reject(new Error(`${script} timed out after 30 seconds`));
    }, 30_000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.once('error', (error) => { clearTimeout(timeout); reject(error); });
    p.once('close', () => { clearTimeout(timeout); resolve(out); });
  });
}

let failed = 0;
try {
  const relayEnv = {
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: base,
    BRC_ADMIN_PASSWORD: pass,
    BRC_SESSION_SECRET: 'e2e',
    BRC_DB: path.join(scratch, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(scratch, 'relay.log'),
    BRC_LOG_ROTATE_MIB: '1',
    LOG_LEVEL: 'warn',
  };
  const initialized = spawnSync(process.execPath, [relayCli, '--initialize'], {
    env: { ...process.env, ...relayEnv },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (initialized.error) throw initialized.error;
  if (initialized.status !== 0) throw new Error(`Relay database initialization failed: ${initialized.stderr.trim() || initialized.stdout.trim()}`);
  const relay = start('relay', [relayCli], relayEnv);
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 20_000, 'relay');

  const agent = start('agent', [agentCli, '--relay', base, '--name', 'e2e-agent', '--no-browser'], { BRC_HOME: path.join(scratch, 'agent-home') });
  const code = await waitFor(() => agent.out.match(/code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1], 20_000, 'pairing code');

  let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'admin', password: pass, returnTo: '/' }) });
  const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
  r = await fetch(`${base}/device/approve`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ user_code: code, decision: 'allow' }) });
  if (r.status !== 200) throw new Error(`approve failed: ${r.status}`);
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).devices === 1, 20_000, 'agent online');
  console.log(`relay + agent up on ${base} (pairing code ${code})\n`);
  relay.kill('SIGTERM');
  await waitFor(() => relay.exitCode !== null || relay.signalCode !== null, 5000, 'relay shutdown');
  start('relay', [relayCli], relayEnv);
  await waitFor(async () => (await fetch(`${base}/health`)).ok, 20_000, 'relay restart');
  await waitFor(async () => (await (await fetch(`${base}/health`)).json()).devices === 1, 20_000, 'agent reconnect after relay restart');
  console.log('Agent reconnected after Relay restart with existing database identity.');

  // rate-limit test must run last: it locks the admin login for 5 minutes.
  for (const s of ['scripts/e2e-oauth.mjs', 'scripts/e2e-admin.mjs']) {
    console.log(`== ${s}`);
    const out = await runScript(s, base, 'admin', pass);
    process.stdout.write(out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l)).map((l) => '  ' + l.slice(0, 110)).join('\n') + '\n');
    const f = (out.match(/^FAIL/gm) ?? []).length;
    if (f || !/^PASS/m.test(out)) { failed += f || 1; if (!/^PASS/m.test(out)) console.log('  (suite crashed)\n' + out.slice(-600)); }
  }
} catch (e) {
  failed++;
  console.error('runner error:', e instanceof Error ? e.message : e);
  for (const p of procs) if (p.out) console.error(p.out.slice(-800));
} finally {
  if (failed) for (const p of procs) if (p.out) console.error(`\n--- ${p.spawnargs?.[1]?.split(/[\\/]/).slice(-3).join('/')} output ---\n${p.out.slice(-3000)}`);
  for (const p of procs) { try { p.kill('SIGTERM'); } catch {} }
  await sleep(500);
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failure(s)` : '\nall e2e suites passed');
process.exit(failed ? 1 : 0);
