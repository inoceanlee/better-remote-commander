import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessManager, inspectProcess } from '../packages/cli/dist/processes.js';
import { ServiceManager } from '../packages/cli/dist/services.js';
import { startManagedControlServer } from '../packages/shared/dist/managed-control.js';

const fakeService = `
import { createServer } from 'node:http';
import { renameSync, writeFileSync } from 'node:fs';
const mode = process.env.BRC_TEST_MODE ?? 'normal';
const token = process.env.BRC_CONTROL_TOKEN;
const readyFile = process.env.BRC_CONTROL_READY_FILE;
const id = process.env.BRC_MANAGED_ID;
const name = process.env.BRC_MANAGED_SERVICE;
const servicePort = Number(process.env.BRC_TEST_PORT ?? 0);
if (servicePort) {
  const service = createServer((_req, res) => res.end('existing-service'));
  try {
    await new Promise((resolve, reject) => {
      service.once('error', reject);
      service.listen(servicePort, '127.0.0.1', resolve);
    });
  } catch {
    process.exit(23);
  }
}
const control = createServer((req, res) => {
  if (req.socket.remoteAddress !== '127.0.0.1' || req.headers.authorization !== 'Bearer ' + token) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, state: 'running', detail: 'fake service ready' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(202).end();
    if (mode !== 'hang') setTimeout(() => process.exit(0), 20);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve, reject) => {
  control.once('error', reject);
  control.listen(0, '127.0.0.1', resolve);
});
const address = control.address();
const ready = readyFile + '.tmp';
writeFileSync(ready, JSON.stringify({ id, service: name, pid: process.pid, port: address.port }));
renameSync(ready, readyFile);
if (mode === 'exit') setTimeout(() => process.exit(0), Number(process.env.BRC_TEST_EXIT_MS ?? 250));
if (process.env.BRC_TEST_READY_DELAY) await new Promise((resolve) => setTimeout(resolve, Number(process.env.BRC_TEST_READY_DELAY)));
`;

function service(name, entrypoint, root, env = {}) {
  return { name, entrypoint, workspaceRoot: root, cwd: root, args: [], env };
}

function paths(root) {
  return {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  };
}

async function makeHarness(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-lifecycle-'));
  const runtimePaths = paths(root);
  await mkdir(runtimePaths.runtime, { recursive: true });
  const entrypoint = path.join(root, 'fake-service.mjs');
  await writeFile(entrypoint, fakeService);
  const spec = service(options.name ?? 'relay', entrypoint, root, {
    BRC_TEST_MODE: options.mode ?? 'normal',
    ...(options.env ?? {}),
  });
  const manager = new ProcessManager(runtimePaths, {
    startupTimeoutMs: options.startupTimeoutMs ?? 3000,
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? 300,
    pollIntervalMs: 25,
    ...(options.processOptions ?? {}),
  });
  t.after(async () => {
    try { await manager.stop(spec); } catch { /* Preserve the original assertion failure. */ }
    await rm(root, { recursive: true, force: true });
  });
  return { root, paths: runtimePaths, spec, manager, entrypoint };
}

class FakeProcessManager {
  constructor({ failStart, delayMs = 0 } = {}) {
    this.failStart = failStart;
    this.delayMs = delayMs;
    this.calls = [];
    this.states = new Map();
    this.active = 0;
    this.maxActive = 0;
  }

  async status(spec) {
    return this.states.get(spec.name) ?? { name: spec.name, state: 'stopped', pid: null, detail: 'not started' };
  }

  async start(spec) {
    this.calls.push(`start:${spec.name}`);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs) await sleep(this.delayMs);
      if (this.failStart === spec.name) throw new Error(`failed:${spec.name}`);
      this.states.set(spec.name, { name: spec.name, state: 'running', pid: 100, detail: 'healthy' });
    } finally {
      this.active--;
    }
  }

  async stop(spec) {
    this.calls.push(`stop:${spec.name}`);
    this.states.set(spec.name, { name: spec.name, state: 'stopped', pid: null, detail: 'stopped' });
  }
}

function workspaceServices(root) {
  return [service('relay', path.join(root, 'relay.js'), root), service('agent', path.join(root, 'agent.js'), root)];
}

test('protects managed control endpoints and runs shutdown once', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-control-'));
  const env = {
    BRC_CONTROL_TOKEN: 'a'.repeat(64),
    BRC_CONTROL_READY_FILE: path.join(root, 'relay.ready.json'),
    BRC_MANAGED_ID: '00000000-0000-4000-8000-000000000001',
    BRC_MANAGED_SERVICE: 'relay',
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let control;
  const stops = [];
  try {
    control = await startManagedControlServer({
      health: () => ({ state: 'running', detail: 'Relay ready.' }),
      stop: () => { stops.push('stop'); },
    });
    assert.ok(control);
    const endpoint = `http://127.0.0.1:${control.port}`;
    assert.equal((await fetch(`${endpoint}/health`)).status, 404);
    assert.equal((await fetch(`${endpoint}/health`, {
      headers: { authorization: 'Bearer invalid' },
    })).status, 404);
    const health = await fetch(`${endpoint}/health`, {
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    });
    assert.deepEqual(await health.json(), { ok: true, state: 'running', detail: 'Relay ready.' });
    assert.equal((await fetch(`${endpoint}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    })).status, 202);
    assert.equal((await fetch(`${endpoint}/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.BRC_CONTROL_TOKEN}` },
    })).status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stops, ['stop']);
  } finally {
    await control?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to stop and preserves a malformed process record', async (t) => {
  const harness = await makeHarness(t);
  const filename = path.join(harness.paths.runtime, 'relay.json');
  const contents = '{malformed';
  await writeFile(filename, contents);

  await assert.rejects(harness.manager.stop(harness.spec), /JSON|malformed|incomplete/i);
  assert.equal(await readFile(filename, 'utf8'), contents);
  assert.equal((await harness.manager.status(harness.spec)).state, 'degraded');
});

test('starts in order, makes start and stop idempotent, and stops in reverse order', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const processes = new FakeProcessManager();
  const manager = new ServiceManager(runtimePaths, workspaceServices(root), processes);

  await manager.start();
  await manager.start();
  await manager.stop();
  await manager.stop();

  assert.deepEqual(processes.calls, ['start:relay', 'start:agent', 'stop:agent', 'stop:relay']);
});

test('rolls back already-started services when a later service fails', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const processes = new FakeProcessManager({ failStart: 'agent' });
  const manager = new ServiceManager(paths(root), workspaceServices(root), processes);

  await assert.rejects(manager.start(), /failed:agent/);

  assert.deepEqual(processes.calls, ['start:relay', 'start:agent', 'stop:relay']);
  assert.equal((await processes.status({ name: 'relay' })).state, 'stopped');
});

test('serializes lifecycle calls across manager instances sharing one runtime root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-services-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimePaths = paths(root);
  const processes = new FakeProcessManager({ delayMs: 150 });
  const services = workspaceServices(root);
  const first = new ServiceManager(runtimePaths, services, processes);
  const second = new ServiceManager(runtimePaths, services, processes);

  const firstRun = first.start();
  const secondRun = second.restart();
  const results = await Promise.allSettled([firstRun, secondRun]);

  assert.equal(processes.maxActive, 1);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

test('persists identity and allows another CLI instance to inspect and stop the child', async (t) => {
  const harness = await makeHarness(t);
  const { manager, spec } = harness;

  await manager.start(spec);
  const started = await manager.status(spec);
  const nextCli = new ProcessManager(harness.paths, { shutdownTimeoutMs: 300, pollIntervalMs: 25 });
  const observed = await nextCli.status(spec);

  assert.equal(started.state, 'running');
  assert.equal(typeof started.pid, 'number');
  assert.equal(observed.pid, started.pid);
  assert.match(observed.detail, /fake service ready/);
  await nextCli.stop(spec);
  assert.equal((await manager.status(spec)).state, 'stopped');
});

test('lets the CLI process exit while the managed service keeps running', async (t) => {
  const harness = await makeHarness(t);
  const processManagerUrl = JSON.stringify(new URL('../packages/cli/dist/processes.js', import.meta.url).href);
  const source = `import { ProcessManager } from ${processManagerUrl};
await new ProcessManager(${JSON.stringify(harness.paths)}, { startupTimeoutMs: 3000, shutdownTimeoutMs: 300, pollIntervalMs: 25 }).start(${JSON.stringify(harness.spec)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: 'ignore',
    windowsHide: true,
  });
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('CLI process remained open after starting the managed service.'));
    }, 8000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal((await harness.manager.status(harness.spec)).state, 'running');
});

test('reports an exited process as stopped and refuses a reused PID', async (t) => {
  const exited = await makeHarness(t);
  await exited.manager.start(exited.spec);
  const running = await exited.manager.status(exited.spec);
  assert.equal(running.state, 'running');
  assert.ok(running.pid);
  process.kill(running.pid);
  let afterExit = await exited.manager.status(exited.spec);
  for (let attempt = 0; attempt < 5 && afterExit.state !== 'stopped'; attempt++) {
    await sleep(100);
    afterExit = await exited.manager.status(exited.spec);
  }
  assert.equal(afterExit.state, 'stopped');
  const harness = await makeHarness(t);
  let reused = false;
  const manager = new ProcessManager(harness.paths, {
    startupTimeoutMs: 3000,
    shutdownTimeoutMs: 150,
    pollIntervalMs: 25,
    inspectProcess: async (pid) => {
      const identity = await inspectProcess(pid);
      return reused && identity ? { ...identity, createdAt: `${identity.createdAt}-reused` } : identity;
    },
  });
  await manager.start(harness.spec);
  reused = true;

  await assert.rejects(manager.stop(harness.spec), /identity|reused|match/i);
  assert.equal((await manager.status(harness.spec)).state, 'degraded');
  reused = false;
  await manager.stop(harness.spec);
});

test('leaves an unrelated listener untouched when a service port is occupied', async (t) => {
  const listener = createServer((_req, res) => res.end('preserved'));
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => listener.close(() => resolve())));
  const port = listener.address().port;
  const harness = await makeHarness(t, { env: { BRC_TEST_PORT: String(port) } });

  await assert.rejects(harness.manager.start(harness.spec), /exited|ready|start/i);
  const response = await fetch(`http://127.0.0.1:${port}`);

  assert.equal(await response.text(), 'preserved');
  assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
});

test('force-stops only identity-matched process after controlled shutdown times out', async (t) => {
  const harness = await makeHarness(t, { mode: 'hang', shutdownTimeoutMs: 150 });
  const neighbor = service('agent', harness.entrypoint, harness.root, { BRC_TEST_MODE: 'normal' });
  await harness.manager.start(harness.spec);
  await harness.manager.start(neighbor);
  const neighborRecord = await harness.manager.status(neighbor);

  await harness.manager.stop(harness.spec);

  assert.equal((await harness.manager.status(harness.spec)).state, 'stopped');
  const neighborStatus = await harness.manager.status(neighbor);
  assert.equal(neighborStatus.pid, neighborRecord.pid);
  assert.equal(neighborStatus.state, 'running');
  await harness.manager.stop(neighbor);
});
