import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
