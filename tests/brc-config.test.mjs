import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';
import { resolveBrcPaths } from '../packages/cli/dist/config/paths.js';
import { LifecycleLock } from '../packages/cli/dist/lifecycle/lock.js';
import { SettingsManager } from '../packages/cli/dist/config/manager.js';
import { runConfigCommand } from '../packages/cli/dist/commands/config.js';

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-config-test-'));
  const env = { ...options.env, BRC_DATA_ROOT: root };
  const paths = resolveBrcPaths(env);
  await mkdir(paths.config, { recursive: true });
  const lock = new LifecycleLock(paths);
  const apply = options.apply ?? (async () => {});
  const manager = await SettingsManager.load(paths, env, { lock, apply });
  return { env, paths, lock, apply, manager };
}

function commandDependencies(manager, paths, output) {
  return { manager, paths, write: (message) => output.push(message) };
}

test('central settings defaults match the public configuration contract', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    version: 1,
    proxy: {
      rate: { average: 10, period: '1s', burst: 30 },
      concurrent: 16,
    },
    services: {
      relayPort: 3000,
      proxyPort: 13001,
      healthPort: 13002,
    },
    logs: {
      retentionDays: 7,
      maxTotalMiB: 50,
      rotateMiB: 4,
    },
    runtime: {
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 3_000,
    },
  });
});

test('missing configuration uses defaults and reports default sources', async (t) => {
  const { manager, paths } = await createFixture(t);

  assert.deepEqual(manager.get('proxy.rate.average'), { value: 10, source: 'default' });
  await assert.rejects(readFile(path.join(paths.config, 'brc.yaml'), 'utf8'), { code: 'ENOENT' });
});

test('registered environment values override file values and defaults', async (t) => {
  const { paths, lock, apply } = await createFixture(t);
  const filename = path.join(paths.config, 'brc.yaml');
  await writeFile(filename, 'version: 1\nproxy:\n  rate:\n    average: 18\n');
  const manager = await SettingsManager.load(paths, {
    BRC_DATA_ROOT: paths.root,
    BRC_PROXY_RATE_AVERAGE: '24',
  }, { lock, apply });

  assert.deepEqual(manager.get('proxy.rate.average'), { value: 24, source: 'environment' });
  assert.deepEqual(manager.get('proxy.rate.burst'), { value: 30, source: 'default' });
});

test('file values override defaults and report file sources', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nproxy:\n  rate:\n    average: 18\n');
  const configured = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  assert.deepEqual(configured.get('proxy.rate.average'), { value: 18, source: 'file' });
  assert.deepEqual(configured.get('proxy.rate.period'), { value: '1s', source: 'default' });
  assert.equal(manager.get('proxy.rate.average').value, 10);
});

test('unknown configuration keys are rejected', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nproxy:\n  unknown: true\n');

  await assert.rejects(manager.apply(), /unknown/i);
});

test('invalid YAML is rejected', async (t) => {
  const { paths, env, lock, apply } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: [');
  const reloaded = await SettingsManager.load(paths, env, { lock, apply });

  await assert.rejects(reloaded.apply(), /yaml/i);
});

test('out-of-range numbers are rejected', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 70000\n');

  await assert.rejects(manager.apply(), /relayPort|port|range/i);
});

test('configuration files require version 1', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'proxy:\n  rate:\n    average: 12\n');

  await assert.rejects(manager.apply(), /version/i);
});

test('environment values use the same validation as file values', async (t) => {
  const { paths, lock, apply } = await createFixture(t);

  await assert.rejects(
    SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root, BRC_PROXY_RATE_AVERAGE: 'fast' }, { lock, apply }),
    /BRC_PROXY_RATE_AVERAGE|average|number/i,
  );
});

test('service ports must remain distinct', async (t) => {
  const { manager, paths } = await createFixture(t);
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 13001\n  proxyPort: 13001\n');

  await assert.rejects(manager.apply(), /different|distinct|port/i);
});

test('config path prints the selected configuration file', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['path'], commandDependencies(manager, paths, output));

  assert.equal(result, 0);
  assert.equal(output.join('\n'), path.join(paths.config, 'brc.yaml'));
});

test('config get reports value and source', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['get', 'proxy.rate.average'], commandDependencies(manager, paths, output));

  assert.equal(result, 0);
  assert.match(output.join('\n'), /proxy\.rate\.average/);
  assert.match(output.join('\n'), /10/);
  assert.match(output.join('\n'), /default/);
});

test('config show reports all effective values and sources', async (t) => {
  const { manager, paths } = await createFixture(t);
  const output = [];

  const result = await runConfigCommand(['show'], commandDependencies(manager, paths, output));
  const text = output.join('\n');

  assert.equal(result, 0);
  assert.match(text, /proxy\.rate\.average/);
  assert.match(text, /10/);
  assert.match(text, /default/);
  assert.match(text, /services\.relayPort/);
});

test('config set applies valid values and flags static service changes for restart', async (t) => {
  let appliedRelayPort = 0;
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => { appliedRelayPort = settings.services.relayPort; },
  });
  const output = [];

  const result = await runConfigCommand(['set', 'services.relayPort', '3100'], commandDependencies(manager, paths, output));

  assert.equal(result, 0);
  assert.equal(manager.get('services.relayPort').value, 3100);
  assert.equal(appliedRelayPort, 3100);
  assert.match(output.join('\n'), /restart/i);
});

test('config apply loads and applies user-edited configuration', async (t) => {
  let appliedRelayPort = 0;
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => { appliedRelayPort = settings.services.relayPort; },
  });
  await writeFile(path.join(paths.config, 'brc.yaml'), 'version: 1\nservices:\n  relayPort: 3100\n');
  const output = [];

  const result = await runConfigCommand(['apply'], commandDependencies(manager, paths, output));

  assert.equal(result, 0);
  assert.equal(manager.get('services.relayPort').value, 3100);
  assert.equal(appliedRelayPort, 3100);
});

test('failed config application restores the last valid file and settings', async (t) => {
  const { manager, paths, env, apply } = await createFixture(t, {
    apply: async (settings) => {
      if (settings.services.relayPort === 3100) throw new Error('apply failed');
    },
  });
  await manager.set('services.relayPort', 3001);
  const filename = path.join(paths.config, 'brc.yaml');
  const lastValidFile = await readFile(filename, 'utf8');
  await writeFile(filename, 'version: 1\nservices:\n  relayPort: 3100\n');
  const reloaded = await SettingsManager.load(paths, env, { lock: new LifecycleLock(paths), apply });

  await assert.rejects(reloaded.apply(), /apply failed/);

  assert.equal(reloaded.get('services.relayPort').value, 3001);
  assert.equal(await readFile(filename, 'utf8'), lastValidFile);
  assert.equal(await readFile(path.join(paths.config, 'brc.yaml.last-good'), 'utf8'), lastValidFile);
});

test('failed first config write removes new file and preserves defaults', async (t) => {
  const { manager, paths } = await createFixture(t, {
    apply: async (settings) => {
      if (settings.services.relayPort === 3100) throw new Error('apply failed');
    },
  });
  const filename = path.join(paths.config, 'brc.yaml');

  await assert.rejects(manager.set('services.relayPort', 3100), /apply failed/);

  assert.equal(manager.get('services.relayPort').value, 3000);
  await assert.rejects(readFile(filename, 'utf8'), { code: 'ENOENT' });
});

test('concurrent setting changes preserve both values on disk', async (t) => {
  const { manager, paths, lock, apply } = await createFixture(t);
  const secondManager = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  await Promise.all([
    manager.set('proxy.rate.average', 20),
    secondManager.set('proxy.rate.burst', 40),
  ]);
  const persisted = await SettingsManager.load(paths, { BRC_DATA_ROOT: paths.root }, { lock, apply });

  assert.equal(persisted.get('proxy.rate.average').value, 20);
  assert.equal(persisted.get('proxy.rate.burst').value, 40);
});
