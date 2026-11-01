import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pairDevice, loadCredentials } from '../packages/agent/dist/transport/pairing.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const start = { device_code: 'code', user_code: 'USER', verification_uri: 'https://relay.example/verify', verification_uri_complete: 'https://relay.example/verify?code=USER', expires_in: 30, interval: 2 };

async function scenario(t, responses, options = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'brc-pairing-'));
  const previousHome = process.env.BRC_HOME;
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  const originalNow = Date.now;
  const file = path.join(home, 'device.json');
  const requests = [];
  const delays = [];
  let now = 1_000_000;
  process.env.BRC_HOME = home;
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms, ...args) => {
    delays.push(ms);
    now += ms;
    queueMicrotask(() => callback(...args));
    return 0;
  };
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body), method: init.method, contentType: init.headers['content-type'] });
    if (requests.length === 1) return Response.json({ ...start, ...options.start });
    assert.equal(existsSync(file), false, 'credentials must not exist before approval');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'unexpected poll');
    return Response.json(response, { status: response.error ? 400 : 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
    Date.now = originalNow;
    if (previousHome === undefined) delete process.env.BRC_HOME; else process.env.BRC_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const logs = [];
  return { file, requests, delays, logs, run: () => pairDevice({ relayUrl: 'https://relay.example/', name: 'test agent', deviceId: 'local-id', openBrowser: false, log: (message) => logs.push(message) }) };
}

test('pending and slow_down preserve polling protocol and save approved credentials', async (t) => {
  const s = await scenario(t, [
    { error: 'authorization_pending' }, { error: 'slow_down' },
    { device_token: 'token', device_id: 'approved-id' },
  ]);
  const credentials = await s.run();
  assert.deepEqual(s.delays, [2000, 2000, 7000]);
  assert.deepEqual(s.requests.map((r) => r.url), ['https://relay.example/device/start', 'https://relay.example/device/poll', 'https://relay.example/device/poll', 'https://relay.example/device/poll']);
  assert.deepEqual(s.requests[0].body, { client_name: 'test agent' });
  assert.deepEqual(s.requests[1].body, { device_code: 'code', device_id: 'local-id', name: 'test agent', platform: `${process.platform}/${process.arch}` });
  assert.ok(s.requests.every((r) => r.method === 'POST' && r.contentType === 'application/json'));
  assert.deepEqual(credentials, { relayUrl: 'https://relay.example', deviceId: 'approved-id', deviceToken: 'token', name: 'test agent', pairedAt: credentials.pairedAt });
  assert.ok(Number.isFinite(Date.parse(credentials.pairedAt)));
  assert.deepEqual(JSON.parse(readFileSync(s.file, 'utf8')), credentials);
  assert.deepEqual(loadCredentials(), credentials);
  assert.ok(s.logs.some((line) => line.includes('USER')));
  assert.ok(s.logs.some((line) => line.includes('credentials saved')));
});

for (const [response, message] of [
  [{ error: 'access_denied' }, /pairing denied by the relay owner/],
  [{ error: 'expired_token' }, /pairing code expired/],
  [{ error: 'unexpected' }, /pairing failed: unexpected/],
  [new Error('network interruption'), /network interruption/],
]) {
  test(`pairing leaves credentials absent on ${response.error ?? response.message}`, async (t) => {
    const s = await scenario(t, [response]);
    await assert.rejects(s.run(), message);
    assert.equal(existsSync(s.file), false);
  });
}

test('pairing times out after pending without saving credentials', async (t) => {
  const s = await scenario(t, [{ error: 'authorization_pending' }], { start: { expires_in: 1 } });
  await assert.rejects(s.run(), /pairing code expired/);
  assert.deepEqual(s.delays, [2000]);
  assert.equal(existsSync(s.file), false);
});

test('legacy credential files remain readable', async (t) => {
  const s = await scenario(t, []);
  const legacy = { relayUrl: 'https://old.example', deviceId: 'old-id', deviceToken: 'old-token', name: 'old', pairedAt: '2020-01-01T00:00:00.000Z' };
  writeFileSync(s.file, JSON.stringify(legacy));
  assert.deepEqual(loadCredentials(), legacy);
});

test('agent saves newly approved credentials once when a relay rejects its old token', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'brc-repair-'));
  const home = path.join(root, 'home');
  const trace = path.join(root, 'writes.log');
  const preload = path.join(root, 'trace.cjs');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(home);
  writeFileSync(preload, `
    const fs = require('node:fs');
    const original = fs.writeFileSync;
    fs.writeFileSync = function(file, ...args) {
      if (String(file) === process.env.PAIRING_CREDENTIAL_FILE) {
        fs.appendFileSync(process.env.PAIRING_WRITE_TRACE, 'write\\n');
      }
      return original.call(this, file, ...args);
    };
    require('node:module').syncBuiltinESMExports();
  `);
  let upgrades = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/device/start') return res.end(JSON.stringify({ ...start, expires_in: 30 }));
    if (req.url === '/device/poll') return res.end(JSON.stringify({ device_token: 'new-token', device_id: 'old-id' }));
    res.writeHead(404).end('{}');
  });
  server.on('upgrade', (req, socket) => {
    upgrades++;
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const relayUrl = `http://127.0.0.1:${server.address().port}`;
  const file = path.join(home, 'device.json');
  writeFileSync(file, JSON.stringify({ relayUrl, deviceId: 'old-id', deviceToken: 'old-token', name: 'old agent', pairedAt: '2020-01-01T00:00:00.000Z' }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  const child = spawn(process.execPath, ['--require', preload, fileURLToPath(new URL('../packages/agent/dist/cli.js', import.meta.url)), '--no-browser'], {
    env: { ...env, BRC_HOME: home, BRC_UPSTREAM_TELEMETRY: '0', PAIRING_CREDENTIAL_FILE: file, PAIRING_WRITE_TRACE: trace },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; i < 150 && upgrades < 2 && child.exitCode === null; i++) await sleep(100);
  assert.ok(upgrades >= 2, `agent did not reconnect after re-pairing:\n${output}`);
  assert.equal(readFileSync(trace, 'utf8'), 'write\n');
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.deviceToken, 'new-token');
  assert.equal(saved.deviceId, 'old-id');
  assert.equal(saved.relayUrl, relayUrl);
});
