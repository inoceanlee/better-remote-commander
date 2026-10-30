import { spawnSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(process.argv[2] ?? path.join(workspaceRoot, 'dist-pack'));
const packageDir = path.join(workspaceRoot, 'packages');
const workDir = await mkdtemp(path.join(os.tmpdir(), 'brc-pack-'));
const stageDir = path.join(workDir, 'package');
const isolatedPnpmHome = path.join(workDir, 'pnpm-home');
const isolatedStore = path.join(workDir, 'pnpm-store');
const sourcePackages = ['cli', 'relay', 'agent', 'shared'];

function runPnpm(args, cwd) {
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      PNPM_HOME: isolatedPnpmHome,
      npm_config_store_dir: isolatedStore,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with exit code ${result.status}`);
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
  await cp(path.join(workspaceRoot, 'README.md'), path.join(stageDir, 'README.md'));
  await cp(path.join(workspaceRoot, 'LICENSE'), path.join(stageDir, 'LICENSE'));

  const packageManifest = {
    ...cliManifest,
    files: ['dist', 'deploy', 'README.md', 'LICENSE'],
    dependencies,
    bundledDependencies: Object.keys(dependencies),
  };
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await mkdir(outputDir, { recursive: true });
  await runPnpm(['--config.store-dir', isolatedStore, 'install', '--prod', '--ignore-scripts', '--no-frozen-lockfile'], stageDir);

  const bundledSharedPath = path.join(stageDir, 'node_modules', 'brc-shared');
  await rm(bundledSharedPath, { recursive: true, force: true });
  await cp(path.join(stageDir, 'vendor', 'brc-shared'), bundledSharedPath, { recursive: true });
  await rm(path.join(stageDir, 'vendor'), { recursive: true, force: true });
  packageManifest.dependencies['brc-shared'] = sharedManifest.version;
  await writeFile(path.join(stageDir, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`);

  await chmod(path.join(stageDir, 'dist', 'cli.js'), 0o755);
  runPnpm(['pack', '--pack-destination', outputDir], stageDir);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
