import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packer = path.join(repoRoot, 'scripts', 'pack-brc.mjs');
const requiredFiles = [
  'package/package.json',
  'package/dist/cli.js',
  'package/dist/services/relay/cli.js',
  'package/dist/services/agent/cli.js',
  'package/deploy/traefik/traefik.yml',
  'package/deploy/traefik/dynamic.yml',
  'package/node_modules/brc-shared/package.json',
  'package/node_modules/unzipper/package.json',
];
const forbiddenFiles = [
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:\.npmrc|\.pnpmfile\.cjs)$/i,
  /(^|\/)(?:id_rsa|id_ed25519|credentials(?:\.json)?|secrets?)(?:\.[^/]*)?$/i,
  /\.(?:pem|key|p12|pfx|sqlite|sqlite3|db)$/i,
  /(^|\/)traefik(?:\.exe)?$/i,
  /(^|\/)node_modules\/\.pnpm(?:\/|$)/,
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed\n${result.stderr}`);
  return result.stdout.trim();
}

async function makePackageFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-package-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const outputDir = path.join(root, 'packed');
  run(process.execPath, [packer, outputDir]);
  const archives = (await readdir(outputDir)).filter((name) => name.endsWith('.tgz'));
  assert.equal(archives.length, 1, 'packer must produce exactly one tarball');
  return { root, tarball: path.join(outputDir, archives[0]) };
}

test('single package tarball is complete, self-contained, and globally installable', async (t) => {
  const { root, tarball } = await makePackageFixture(t);
  const names = run('tar', ['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
  const files = new Set(names);

  for (const name of requiredFiles) {
    assert.ok(files.has(name), `tarball is missing ${name}`);
  }
  for (const name of names) {
    assert.ok(!forbiddenFiles.some((pattern) => pattern.test(name)), `tarball contains excluded path ${name}`);
  }
  assert.ok(!names.some((name) => name.startsWith('package/deploy/traefik/') && /\.exe$/i.test(name)));

  const manifestDir = path.join(root, 'extracted');
  await mkdir(manifestDir);
  run('tar', ['-xzf', tarball, '-C', manifestDir]);
  const extractedPackage = path.join(manifestDir, 'package');
  const manifest = JSON.parse(await readFile(path.join(extractedPackage, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@inoceanlee/brc');
  assert.equal(manifest.bin?.brc, 'dist/cli.js');
  assert.ok(Object.values(manifest.dependencies ?? {}).every((value) => !value.startsWith('workspace:')));

  if (process.platform !== 'win32') {
    const cliMode = (await stat(path.join(extractedPackage, 'dist/cli.js'))).mode;
    assert.notEqual(cliMode & 0o111, 0, 'CLI bin must retain executable permissions');
  }
  const servicesUrl = pathToFileURL(path.join(extractedPackage, 'dist', 'lifecycle', 'services.js')).href;
  const settingsUrl = pathToFileURL(path.join(extractedPackage, 'dist', 'config', 'settings.js')).href;
  const dataRoot = path.join(root, 'brc-data');
  const serviceEntries = JSON.parse(run(process.execPath, [
    '--input-type=module',
    '-e',
    `
import { createDefaultServices } from ${JSON.stringify(servicesUrl)};
import { DEFAULT_SETTINGS } from ${JSON.stringify(settingsUrl)};
import path from 'node:path';
const root = ${JSON.stringify(dataRoot)};
const paths = Object.fromEntries(['traefik', 'config', 'data', 'runtime', 'logs', 'tmp'].map((name) => [name, path.join(root, name)]));
const services = createDefaultServices(paths, DEFAULT_SETTINGS, {});
console.log(JSON.stringify(services.map(({ name, entrypoint, cwd }) => ({ name, entrypoint, cwd }))));
`,
  ], { cwd: root }));
  assert.deepEqual(serviceEntries, [
    { name: 'relay', entrypoint: path.join(extractedPackage, 'dist', 'services', 'relay', 'cli.js'), cwd: extractedPackage },
    { name: 'traefik', entrypoint: path.join(extractedPackage, 'dist', 'cli.js'), cwd: extractedPackage },
    { name: 'agent', entrypoint: path.join(extractedPackage, 'dist', 'services', 'agent', 'cli.js'), cwd: extractedPackage },
  ]);


  const isolatedHome = path.join(root, 'pnpm-home');
  const isolatedStore = path.join(root, 'pnpm-store');
  const isolatedPath = path.join(root, 'path');
  const installDir = path.join(root, 'global-install');
  const env = {
    ...process.env,
    PNPM_HOME: isolatedHome,
    npm_config_store_dir: isolatedStore,
    npm_config_global_dir: installDir,
    npm_config_global_bin_dir: isolatedPath,
    npm_config_prefix: path.join(root, 'prefix'),
    PATH: process.env.PATH ?? '',
  };
  const isolatedEnv = {
    ...env,
    PATH: `${isolatedPath}${path.delimiter}${path.dirname(process.execPath)}`,
  };
  await Promise.all([isolatedHome, isolatedStore, isolatedPath].map((directory) => mkdir(directory, { recursive: true })));
  run('pnpm', ['--config.global-dir', installDir, '--config.global-bin-dir', isolatedPath, '--config.store-dir', isolatedStore, 'add', '--global', '--offline', tarball], {
    cwd: root,
    env,
    shell: process.platform === 'win32',
  });

  const help = run(bin, ['help'], { cwd: root, env: isolatedEnv, shell: process.platform === 'win32' });
  assert.match(help, /BRC unified CLI/);

  const status = run(bin, ['status'], {
    cwd: root,
    env: { ...isolatedEnv, BRC_DATA_ROOT: path.join(root, 'brc-data') },
    shell: process.platform === 'win32',
  });
  assert.match(status, /relay:/);
  assert.match(status, /agent:/);
  assert.match(status, /traefik:/);
});
