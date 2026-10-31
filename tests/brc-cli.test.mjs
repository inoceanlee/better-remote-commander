import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SqliteStore } from '../packages/relay/dist/store/sqlite.js';

const cliEntry = fileURLToPath(new URL('../packages/cli/dist/cli.js', import.meta.url));
const cliUrl = JSON.stringify(pathToFileURL(cliEntry).href);
const pathsEntry = fileURLToPath(new URL('../packages/cli/dist/config/paths.js', import.meta.url));
const pathsUrl = JSON.stringify(pathToFileURL(pathsEntry).href);

function runCliProcess(args, dataRoot = path.join(os.tmpdir(), 'brc-cli-process-test'), extraEnv = {}) {
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  return spawnSync(process.execPath, [cliEntry, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...inheritedEnv, ...extraEnv, BRC_DATA_ROOT: dataRoot },
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
test('non-interactive uninstall requires --yes and preserves private data', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-uninstall-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const marker = path.join(root, 'data', 'private.sqlite');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, 'isolated database');

  const result = runCliProcess(['uninstall'], root);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--yes/);
  assert.equal(await readFile(marker, 'utf8'), 'isolated database');
});

test('CLI entrypoint runs through a directory junction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-junction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = path.join(root, 'alias');
  await symlink(path.dirname(cliEntry), alias, process.platform === 'win32' ? 'junction' : 'dir');
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('BRC_')));
  const result = spawnSync(process.execPath, [path.join(alias, path.basename(cliEntry)), 'help'], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...inheritedEnv, BRC_DATA_ROOT: path.join(root, 'data') },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /BRC unified CLI/);
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
test('uninstall accepts --yes and owns its stop-clean-remove ordering', () => {
  const result = probeResult(runProbe(`
const calls = [];
let cleanCount = 0;
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = {
  uninstall: async ({ yes }, clean) => {
    calls.push(['uninstall', yes]);
    await clean();
    calls.push('remove package');
    return 0;
  },
};
const exitCode = await runCli(['uninstall', '--yes'], { paths, commands, clean: async () => { cleanCount++; calls.push('clean'); }, write: () => {}, writeError: () => {} });
console.log(JSON.stringify({ exitCode, cleanCount, calls }));
`));

  assert.deepEqual(result, {
    exitCode: 0,
    cleanCount: 1,
    calls: [['uninstall', true], 'clean', 'remove package'],
  });
});

test('failed uninstall does not run automatic cleanup out of order', () => {
  const result = probeResult(runProbe(`
let cleanCount = 0;
const errors = [];
const paths = { root: 'root', traefik: 'traefik', config: 'config', data: 'data', runtime: 'runtime', logs: 'logs', tmp: 'tmp' };
const commands = { uninstall: async () => { throw new Error('service stop failed'); } };
const exitCode = await runCli(['uninstall', '--yes'], { paths, commands, clean: async () => { cleanCount++; }, write: () => {}, writeError: (message) => errors.push(message) });
console.log(JSON.stringify({ exitCode, cleanCount, errors }));
`));

  assert.equal(result.exitCode, 1);
  assert.equal(result.cleanCount, 0);
  assert.match(result.errors.join('\\n'), /service stop failed/);
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
  SqliteStore.initialize(path.join(fixture.root, 'data', 'relay.sqlite'));
  const result = runCliProcess(['start'], fixture.root, { BRC_ADMIN_PASSWORD: '', BRC_RELAY_PORT: '13000' });
  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.expiredLog), false);
  const relayLog = await readFile(path.join(fixture.root, 'logs', 'relay.log'), 'utf8');
  assert.match(relayLog, /Relay administrator identity is missing or ambiguous/);
});
test('noninteractive first setup fails before creating a new identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-first-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = runCliProcess(['setup'], root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /interactive terminal.*administrator password/i);
  assert.equal(existsSync(path.join(root, 'data', 'relay.sqlite')), false);
});

test('public URL persists through separate CLI invocations', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-public-url-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = 'https://brc.example.com';
  const saved = runCliProcess(['config', 'set', 'services.publicUrl', origin], root);
  assert.equal(saved.status, 0, saved.stderr);
  assert.match(saved.stdout, /Restart/);
  const loaded = runCliProcess(['config', 'get', 'services.publicUrl'], root);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.match(loaded.stdout, /services\.publicUrl = https:\/\/brc\.example\.com \(file\)/);
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

test('config set persists validated settings in the selected data root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-cli-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = runCliProcess(['config', 'set', 'proxy.rate.average', '20'], root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /proxy\.rate\.average = 20/);
  const config = await readFile(path.join(root, 'config', 'brc.yaml'), 'utf8');
  assert.match(config, /average: 20/);
});
