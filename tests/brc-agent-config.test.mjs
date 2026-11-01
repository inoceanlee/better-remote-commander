import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = await mkdtemp(path.join(os.tmpdir(), 'brc-agent-config-'));
process.env.BRC_HOME = root;
const { configManager } = await import('../packages/agent/dist/core/config-manager.js');
const file = path.join(root, 'config.json');

test('editable values are validated before persistence', async () => {
  await configManager.init();
  const original = await readFile(file, 'utf8');
  for (const value of ['abc', NaN, 0, 1.5, Infinity]) {
    await assert.rejects(configManager.setUserSetting('fileReadLineLimit', value));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  await assert.rejects(configManager.setUserSetting('defaultShell', 42));
  await assert.rejects(configManager.setUserSetting('clientId', 'changed'));
  assert.equal(await readFile(file, 'utf8'), original);
  await configManager.setUserSetting('telemetryEnabled', 'false');
  assert.equal(await configManager.getValue('telemetryEnabled'), false);
  await configManager.setUserSetting('allowedDirectories', []);
  assert.deepEqual(await configManager.getValue('allowedDirectories'), []);
});

test('editable array settings preserve individual strings and parse JSON arrays', async () => {
  await configManager.setUserSetting('allowedDirectories', 'folder[1]');
  assert.deepEqual(await configManager.getValue('allowedDirectories'), ['folder[1]']);
  await configManager.setUserSetting('blockedCommands', '"shutdown"');
  assert.deepEqual(await configManager.getValue('blockedCommands'), ['shutdown']);
  await configManager.setUserSetting('blockedCommands', '["shutdown","reboot"]');
  assert.deepEqual(await configManager.getValue('blockedCommands'), ['shutdown', 'reboot']);
});

test('home resolution follows filesystem links before parent segments', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-home-path-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, 'target', 'child'), { recursive: true });
  await symlink(path.join(dir, 'target', 'child'), path.join(dir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const { resolveAgentHome } = await import('../packages/agent/dist/core/config.js');
  const input = `${path.join(dir, 'link')}${path.sep}..`;
  assert.equal(resolveAgentHome({ BRC_HOME: input }), realpathSync.native(input));
});

test('configuration snapshots cannot mutate owned state', async () => {
  await configManager.setUserSetting('blockedCommands', ['one']);
  const snapshot = await configManager.getConfig();
  snapshot.blockedCommands.push('two');
  const value = await configManager.getValue('blockedCommands');
  value.push('three');
  assert.deepEqual(await configManager.getValue('blockedCommands'), ['one']);
});

test('concurrent durable writes preserve both settings', async () => {
  await Promise.all([
    configManager.setUserSetting('fileReadLineLimit', 123),
    configManager.setUserSetting('fileWriteLineLimit', 12),
  ]);
  const disk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(disk.fileReadLineLimit, 123);
  assert.equal(disk.fileWriteLineLimit, 12);
});

test('watch reloads an external configuration change', async () => {
  const disk = JSON.parse(await readFile(file, 'utf8'));
  disk.defaultShell = 'external-shell';
  await writeFile(file, JSON.stringify(disk));
  const deadline = Date.now() + 3000;
  while (await configManager.getValue('defaultShell') !== 'external-shell' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(await configManager.getValue('defaultShell'), 'external-shell');
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('corrupt JSON and read or lock errors do not initialize writable defaults', async () => {
  const moduleUrl = pathToFileURL(path.resolve('packages/agent/dist/core/config-manager.js')).href;
  for (const mode of ['corrupt', 'access', 'lock']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-agent-failure-'));
    const configPath = path.join(dir, 'config.json');
    const original = mode === 'corrupt' ? '{broken' : '{"defaultShell":"existing"}';
    await writeFile(configPath, original);
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { createRequire } from 'node:module';
      const lockfile = createRequire(${JSON.stringify(moduleUrl)})('proper-lockfile');
      const mode = process.env.FAILURE_MODE;
      if (mode === 'access') fs.readFile = async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
      if (mode === 'lock') lockfile.lock = async () => { throw Object.assign(new Error('lock failed'), { code: 'ELOCKED' }); };
      const { configManager } = await import(${JSON.stringify(moduleUrl)});
      await assert.rejects(configManager.init());
      await assert.rejects(configManager.setValue('defaultShell', 'changed'));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, BRC_HOME: dir, FAILURE_MODE: mode }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(configPath, 'utf8'), original);
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-object config roots reject initialization and tool updates', async (t) => {
  const managerUrl = pathToFileURL(path.resolve('packages/agent/dist/core/config-manager.js')).href;
  const dispatcherUrl = pathToFileURL(path.resolve('packages/agent/dist/dispatcher.js')).href;
  for (const original of ['null', '[]', '1', '\"text\"']) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-agent-invalid-root-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'config.json');
    await writeFile(file, original);
    const script = `
      import assert from 'node:assert/strict';
      const { configManager } = await import(${JSON.stringify(managerUrl)});
      await assert.rejects(configManager.init());
      const { callTool } = await import(${JSON.stringify(dispatcherUrl)});
      const result = await callTool('set_config_value', { key: 'defaultShell', value: 'changed' });
      assert.equal(result.isError, true);
      await new Promise(resolve => setTimeout(resolve, 100));
    `;
    const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, BRC_HOME: dir }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(await readFile(file, 'utf8'), original);
  }
});

test('dispatcher handles background usage tracking failures on damaged configuration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'brc-agent-bad-json-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'config.json'), '{broken');
  const dispatcherUrl = pathToFileURL(path.resolve('packages/agent/dist/dispatcher.js')).href;
  const script = `
    import assert from 'node:assert/strict';
    const { callTool } = await import(${JSON.stringify(dispatcherUrl)});
    const result = await callTool('get_config', {});
    assert.equal(result.isError, true);
    await new Promise(resolve => setTimeout(resolve, 100));
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', script], {
    cwd: process.cwd(), env: { ...process.env, BRC_HOME: dir }, encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
});
