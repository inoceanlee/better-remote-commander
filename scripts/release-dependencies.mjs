import { cp, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export async function installLockedRuntimeDependencies({ workspaceRoot, stageDir, workDir, sourcePackages, runPnpm }) {
  const dependencyWorkspace = path.join(workDir, 'locked-workspace');
  await mkdir(path.join(dependencyWorkspace, 'packages'), { recursive: true });
  for (const filename of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await copyFile(path.join(workspaceRoot, filename), path.join(dependencyWorkspace, filename));
  }
  for (const name of sourcePackages) {
    if (!/^[a-z0-9-]+$/i.test(name)) throw new Error(`Invalid workspace package name: ${name}`);
    const destination = path.join(dependencyWorkspace, 'packages', name);
    await mkdir(destination, { recursive: true });
    await copyFile(
      path.join(workspaceRoot, 'packages', name, 'package.json'),
      path.join(destination, 'package.json'),
    );
  }

  await runPnpm([
    'install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--node-linker=hoisted',
  ], dependencyWorkspace);

  const nodeModules = path.join(stageDir, 'node_modules');
  await rm(nodeModules, { recursive: true, force: true });
  await cp(path.join(dependencyWorkspace, 'node_modules'), nodeModules, {
    recursive: true,
    dereference: true,
  });
}
