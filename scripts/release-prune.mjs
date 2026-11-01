import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { RELEASE_CONFIG } from './release-config.mjs';

const categoryRules = RELEASE_CONFIG.stagePruneRules;
const categories = ['sourceMaps', 'typescript', 'tests', 'examples', 'documentation'];

function normalizeRelative(filename) {
  return filename.split(path.sep).join('/');
}

function isLicenseFile(filename) {
  return /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(path.basename(filename));
}

function collectExportTargets(value, targets = []) {
  if (typeof value === 'string' && value.startsWith('./')) {
    targets.push(value.slice(2).replaceAll('\\', '/'));
  } else if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, targets);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExportTargets(item, targets);
  }
  return targets;
}

function isExportedFile(relativePath, targets) {
  return targets.some((target) => {
    const pattern = target.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${pattern}$`).test(relativePath);
  });
}

async function readReferencedMaps(files) {
  const referenced = new Set();
  for (const filename of files) {
    if (!/\.(?:c?js|mjs)$/i.test(filename)) continue;
    const text = await readFile(filename, 'utf8');
    for (const match of text.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)) {
      const url = match[1].split(/[?#]/, 1)[0];
      if (!url || /^(?:data:|https?:|\/)/i.test(url)) continue;
      try {
        referenced.add(path.resolve(path.dirname(filename), decodeURIComponent(url)).toLowerCase());
      } catch {
        // Invalid map URLs do not identify a file that the package can load.
      }
    }
  }
  return referenced;
}

function classifyFile(relativePath, absolutePath, exportedTargets, referencedMaps) {
  const normalized = normalizeRelative(relativePath);
  const basename = path.basename(relativePath);
  if (basename === 'package.json' || isLicenseFile(basename) || isExportedFile(normalized, exportedTargets)) return null;
  if (categoryRules.testDirectories.test(normalized)) return 'tests';
  if (categoryRules.exampleDirectories.test(normalized)) return 'examples';
  if (categoryRules.documentationDirectories.test(normalized)
      || (!normalized.includes('/') && categoryRules.documentationFiles.test(basename))) {
    return 'documentation';
  }
  if (categoryRules.sourceMaps.test(basename)) {
    return referencedMaps.has(absolutePath.toLowerCase()) ? null : 'sourceMaps';
  }
  if (categoryRules.typescript.test(basename)) {
    return isExportedFile(normalized, exportedTargets) ? null : 'typescript';
  }
  if (categoryRules.runtimeAssets.test(basename)) return null;
  return null;
}

async function visitFiles(directory, packageRoot, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await visitFiles(filename, packageRoot, files);
    } else if (entry.isFile()) {
      files.push({ filename, relativePath: path.relative(packageRoot, filename) });
    }
  }
}

export async function pruneStagedDependencies(stageDir) {
  const stageRoot = path.resolve(stageDir);
  const nodeModules = path.join(stageRoot, 'node_modules');
  const stageStat = await lstat(stageRoot);
  if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) {
    throw new Error('Package stage must be a real directory.');
  }

  const result = {
    filesRemoved: 0,
    bytesRemoved: 0,
    byCategory: Object.fromEntries(categories.map((category) => [category, { files: 0, bytes: 0 }])),
  };
  let entries;
  try {
    entries = await readdir(nodeModules, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return result;
    throw error;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const packageRoots = [];
    if (entry.name.startsWith('@')) {
      for (const scoped of await readdir(path.join(nodeModules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory() && !scoped.isSymbolicLink()) packageRoots.push(path.join(nodeModules, entry.name, scoped.name));
      }
    } else {
      packageRoots.push(path.join(nodeModules, entry.name));
    }

    for (const packageRoot of packageRoots) {
      const files = [];
      await visitFiles(packageRoot, packageRoot, files);
      let manifest;
      try {
        manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
      } catch {
        manifest = {};
      }
      const exportedTargets = [
        ...collectExportTargets(manifest.exports),
        manifest.types,
        manifest.typings,
      ].filter((target) => typeof target === 'string').map((target) => target.replace(/^\.\//, ''));
      const referencedMaps = await readReferencedMaps(files.map(({ filename }) => filename));

      for (const file of files) {
        const category = classifyFile(file.relativePath, file.filename, exportedTargets, referencedMaps);
        if (!category) continue;
        const details = await lstat(file.filename);
        if (!details.isFile() || details.isSymbolicLink()) continue;
        await rm(file.filename);
        result.filesRemoved++;
        result.bytesRemoved += details.size;
        result.byCategory[category].files++;
        result.byCategory[category].bytes += details.size;
      }
    }
  }

  return result;
}
