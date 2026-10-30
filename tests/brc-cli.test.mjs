import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const cliEntry = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const cliUrl = JSON.stringify(pathToFileURL(cliEntry).href);
const pathsEntry = fileURLToPath(new URL('../packages/cli/dist/paths.js', import.meta.url));
const pathsUrl = JSON.stringify(pathToFileURL(pathsEntry).href);

function runCliProcess(args, dataRoot = path.join(os.tmpdir(), 'brc-cli-process-test'), extraEnv = {}) {
  return spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...extraEnv, BRC_DATA_ROOT: dataRoot },
  });
}

async function makeCleanupFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-clean-'));
  const logs = path.join(root, 'logs');
  await mkdir(logs, { recursive: true });
  const expiredLog = path.join(logs, 'expired.log');
  await writeFile(expiredLog, 'expired');
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(expiredLog, old, old);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, expiredLog };
}

function runProbe(body) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { runCli } from ${cliUrl};\nimport { resolveBrcPaths } from ${pathsUrl};\n${body}`], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

function probeResult(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('no arguments show status summary and command help', () => {
  const result = runCliProcess([]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC unified CLI/);
  assert.match(result.stdout, /brc status/);
});

test('help explains package-only removal and full uninstall', () => {
  const result = runCliProcess(['help']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm remove -g @inoceanlee\/brc/);
  assert.match(result.stdout, /brc uninstall/);
});

test('unknown commands return usage error', () => {
  const result = runCliProcess(['unknown']);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unknown command/);
});

test('invalid command arguments do not invoke command handlers', () => {
  const result = probeResult(runProbe(`
const calls = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => { calls.push(name); return 0; }]));
const exitCode = await runCli(['update', 'relay'], { paths, commands, clean: async () => {}, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, calls }));
`));

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.calls, []);
});

test('command exit code survives one cleanup failure', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const calls = [];
const errors = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => { calls.push(name); return name === 'start' ? 37 : 0; }]));
const exitCode = await runCli(['start'], { paths, commands, clean: async () => { cleanCount += 1; throw new Error('cleanup failed'); }, write: () => {}, writeError: (message) => errors.push(message) });
console.log(JSON.stringify({ exitCode, cleanCount, calls, errors }));
`));

  assert.equal(result.exitCode, 37);
  assert.equal(result.cleanCount, 1);
  assert.deepEqual(result.calls, ['start']);
  assert.match(result.errors.join('\n'), /cleanup failed/);
});

test('clean command runs cleanup once without recursion', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = Object.fromEntries(['setup', 'start', 'stop', 'restart', 'status', 'logs', 'updateTraefik', 'uninstall'].map((name) => [name, async () => 0]));
const exitCode = await runCli(['clean'], { paths, commands, clean: async () => { cleanCount += 1; }, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, cleanCount }));
`));

  assert.deepEqual(result, { exitCode: 0, cleanCount: 1 });
});

test('brc clean removes expired files and reports the cleanup result', async (t) => {
  const fixture = await makeCleanupFixture(t);
  const result = runCliProcess(['clean'], fixture.root);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.expiredLog), false);
  assert.match(result.stdout, /BRC cleanup: removed 1 items/);
});

test('automatic cleanup runs after help, invalid commands, and startup failure', async (t) => {
  for (const args of [['help'], ['unknown']]) {
    const fixture = await makeCleanupFixture(t);
    const result = runCliProcess(args, fixture.root);
    assert.equal(result.status, args[0] === 'help' ? 0 : 2, result.stderr);
    assert.equal(existsSync(fixture.expiredLog), false);
  }

  const fixture = await makeCleanupFixture(t);
  const result = runCliProcess(['start'], fixture.root, { BRC_ADMIN_PASSWORD: '', BRC_RELAY_PORT: '13000' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.expiredLog), false);
  const relayLog = await readFile(path.join(fixture.root, 'logs', 'relay.log'), 'utf8');
  assert.match(relayLog, /BRC_ADMIN_PASSWORD is required/);
});
test('data-root override resolves isolated paths without using Agent BRC_HOME', () => {
  const override = path.join(os.tmpdir(), 'isolated-brc');
  const result = probeResult(runProbe(`
const paths = resolveBrcPaths({ BRC_DATA_ROOT: ${JSON.stringify(override)}, BRC_HOME: 'agent-credentials' });
console.log(JSON.stringify(paths));
`));
  const root = path.resolve(override);

  assert.deepEqual(result, {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  });
  for (const value of Object.values(result)) assert.equal(path.isAbsolute(value), true);
});
