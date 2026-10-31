import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(process.argv[2] ?? path.join(workspaceRoot, 'dist-pack'));
const options = new Set(process.argv.slice(3));
if ([...options].some((option) => option !== '--with-next-patch' && !/^--version=\d+\.\d+\.\d+$/.test(option))) {
  throw new Error(`Unknown pack-brc option: ${[...options].find((option) => option !== '--with-next-patch' && !/^--version=\d+\.\d+\.\d+$/.test(option))}`);
}
const withNextPatch = options.has('--with-next-patch');
const requestedVersion = [...options].find((option) => option.startsWith('--version='))?.slice('--version='.length);
const packageDir = path.join(workspaceRoot, 'packages');
const workDir = await mkdtemp(path.join(os.tmpdir(), 'brc-pack-'));
const stageDir = path.join(workDir, 'package');
const isolatedPnpmHome = path.join(workDir, 'pnpm-home');
const isolatedStore = path.join(workDir, 'pnpm-store');
const isolatedCache = path.join(workDir, 'pnpm-cache');
const isolatedState = path.join(workDir, 'pnpm-state');
const sourcePackages = ['cli', 'relay', 'agent', 'shared'];

function resolvePnpmCommand() {
  if (process.platform !== 'win32') return { file: 'pnpm', shell: false };
  const result = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Cannot find pnpm on PATH.');
  const candidates = result.stdout.split(/\r?\n/).map((candidate) => candidate.trim()).filter(Boolean);
  const file = candidates.find((candidate) => /\.exe$/i.test(candidate))
    ?? candidates.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate));
  if (!file) throw new Error('Cannot find an executable pnpm command on PATH.');
  return { file, shell: !/\.exe$/i.test(file) };
}

const pnpmCommand = resolvePnpmCommand();

const pnpmIsolationEnv = {
  PNPM_HOME: isolatedPnpmHome,
  PNPM_CONFIG_STORE_DIR: isolatedStore,
  PNPM_CONFIG_STATE_DIR: isolatedState,
  PNPM_CONFIG_CACHE_DIR: isolatedCache,
};

function verifyPnpmIsolation() {
  for (const [setting, expected] of [
    ['store-dir', isolatedStore],
    ['state-dir', isolatedState],
    ['cache-dir', isolatedCache],
  ]) {
    const result = spawnSync(pnpmCommand.file, ['config', 'get', setting], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      windowsHide: true,
      shell: pnpmCommand.shell,
      timeout: 10_000,
      env: { ...process.env, ...pnpmIsolationEnv },
    });
    if (result.error) throw result.error;
    const actual = path.resolve(result.stdout.trim());
    if (result.status !== 0 || actual.toLowerCase() !== path.resolve(expected).toLowerCase()) {
      throw new Error(`pnpm ${setting} did not resolve to the isolated temporary directory.`);
    }
  }
}

function runPnpm(args, cwd) {
  const { file: command, shell } = pnpmCommand;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    timeout: 300_000,
    shell,
    env: { ...process.env, ...pnpmIsolationEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}`);
}

async function maximizeGzipCompression(destination, version) {
  const archive = path.join(destination, `inoceanlee-brc-${version}.tgz`);
  const staging = `${archive}.gzip-level-9`;
  try {
    await pipeline(
      createReadStream(archive),
      createGunzip(),
      createGzip({ level: 9 }),
      createWriteStream(staging, { flags: 'wx' }),
    );
    await rename(staging, archive);
  } finally {
    await rm(staging, { force: true });
  }
}

function collectRuntimeDependencies(manifests) {
  const dependencies = {};
  for (const manifest of manifests) {
    for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
      if (name === 'brc-shared') continue;
      if (dependencies[name] && dependencies[name] !== version) {
        throw new Error(`Conflicting runtime dependency versions for ${name}: ${dependencies[name]} and ${version}`);
      }
      dependencies[name] = version;
    }
  }
  return dependencies;
}

try {
  verifyPnpmIsolation();
  runPnpm(['-r', '--filter', './packages/*', 'build'], workspaceRoot);

  const manifests = await Promise.all(sourcePackages.map(async (name) =>
    JSON.parse(await readFile(path.join(packageDir, name, 'package.json'), 'utf8'))));
  const [cliManifest, , , sharedManifest] = manifests;
  const dependencies = collectRuntimeDependencies(manifests);
  dependencies['brc-shared'] = `file:vendor/brc-shared`;

  await mkdir(path.join(stageDir, 'dist', 'services'), { recursive: true });
  await mkdir(path.join(stageDir, 'vendor', 'brc-shared'), { recursive: true });
  await mkdir(path.join(stageDir, 'deploy'), { recursive: true });
  await cp(path.join(packageDir, 'cli', 'dist'), path.join(stageDir, 'dist'), { recursive: true });
  await cp(path.join(packageDir, 'relay', 'dist'), path.join(stageDir, 'dist', 'services', 'relay'), { recursive: true });
  await cp(path.join(packageDir, 'agent', 'dist'), path.join(stageDir, 'dist', 'services', 'agent'), { recursive: true });
  await cp(path.join(packageDir, 'shared', 'dist'), path.join(stageDir, 'vendor', 'brc-shared', 'dist'), { recursive: true });
  await writeFile(path.join(stageDir, 'vendor', 'brc-shared', 'package.json'), JSON.stringify(sharedManifest, null, 2));
  await cp(path.join(workspaceRoot, 'deploy', 'traefik'), path.join(stageDir, 'deploy', 'traefik'), { recursive: true });
  await cp(path.join(packageDir, 'cli', 'README.md'), path.join(stageDir, 'README.md'));
  await cp(path.join(workspaceRoot, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  const packageManifest = {
    ...cliManifest,
    version: requestedVersion ?? cliManifest.version,
    files: ['dist', 'deploy', 'README.md', 'LICENSE'],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await mkdir(outputDir, { recursive: true });
  await runPnpm(['install', '--prod', '--ignore-scripts', '--no-frozen-lockfile'], stageDir);

  const bundledSharedPath = path.join(stageDir, 'node_modules', 'brc-shared');
  await rm(bundledSharedPath, { recursive: true, force: true });
  await cp(path.join(stageDir, 'vendor', 'brc-shared'), bundledSharedPath, { recursive: true });
  await rm(path.join(stageDir, 'vendor'), { recursive: true, force: true });
  packageManifest.dependencies['brc-shared'] = sharedManifest.version;
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await chmod(path.join(stageDir, 'dist', 'cli.js'), 0o755);
  runPnpm(['pack', '--pack-destination', outputDir], stageDir);
  await maximizeGzipCompression(outputDir, packageManifest.version);
  if (withNextPatch) {
    const version = packageManifest.version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!version) throw new Error(`Cannot create next-patch package from unstable version ${packageManifest.version}.`);
    packageManifest.version = `${version[1]}.${version[2]}.${Number(version[3]) + 1}`;
    await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);
    const nextPatchDir = path.join(outputDir, 'next-patch');
    await mkdir(nextPatchDir, { recursive: true });
    await runPnpm(['pack', '--pack-destination', nextPatchDir], stageDir);
    await maximizeGzipCompression(nextPatchDir, packageManifest.version);
  }
} finally {
  await rm(workDir, { recursive: true, force: true });
}
