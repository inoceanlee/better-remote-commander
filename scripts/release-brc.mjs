import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ReleaseProgress } from './release-progress.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = '@inoceanlee/brc';
const registry = 'https://registry.npmjs.org/';
const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');
const help = process.argv.includes('--help');
if (process.argv.slice(2).some((arg) => !['--dry-run', '--verbose', '--help'].includes(arg))) {
  throw new Error('Usage: pnpm release:brc [--dry-run] [--verbose]');
}
if (help) {
  console.log('pnpm release:brc [--dry-run] [--verbose]');
  console.log('Validate, build, test and publish @inoceanlee/brc with interactive npm authentication.');
  console.log('Use --dry-run to validate without uploading or tagging.');
  process.exit(0);
}
if (!dryRun && !process.stdin.isTTY) {
  console.error('npm publish requires a local interactive terminal for authentication. Run pnpm release:brc locally.');
  process.exit(2);
}

const progress = new ReleaseProgress({ verbose });
function binary(command) {
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) {
    return { file: command, prefix: [] };
  }
  const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (found.status !== 0) throw new Error('Missing ' + command + ' on PATH.');
  const files = found.stdout.split(/\r?\n/).filter(Boolean);
  if (command === 'npm') {
    const cmd = files.find((file) => /npm\.cmd$/i.test(file));
    if (!cmd) throw new Error('Cannot locate npm.cmd.');
    const entrypoint = path.join(path.dirname(cmd), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(entrypoint)) throw new Error('Cannot locate npm CLI entrypoint: ' + entrypoint);
    return { file: process.execPath, prefix: [entrypoint] };
  }
  const executable = files.find((file) => /\.exe$/i.test(file));
  if (!executable) throw new Error('Cannot locate pnpm executable.');
  return { file: executable, prefix: [] };
}
const executables = Object.fromEntries(['git', 'npm', 'pnpm'].map((cmd) => [cmd, binary(cmd)]));
function quick(command, args, { allowFailure = false } = {}) {
  const executable = executables[command] ?? { file: command, prefix: [] };
  const result = spawnSync(executable.file, [...executable.prefix, ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(command + ' ' + args[0] + ' failed: ' + (result.stderr || result.stdout).slice(-1200));
  }
  return result;
}
const git = (...args) => quick('git', args).stdout.trim();
function versionForRelease(source, published) {
  const parse = (version) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Unexpected version: ' + version);
    return version.split('.').map(Number);
  };
  if (!published || published === '0.0.0-stage') return source;
  const a = parse(source), b = parse(published);
  const newer = a.findIndex((value, i) => value !== b[i]);
  return newer >= 0 && a[newer] > b[newer] ? source : [b[0], b[1], b[2] + 1].join('.');
}
function publishedVersion() {
  const result = quick('npm', ['view', name, 'version', '--json', '--registry', registry], { allowFailure: true });
  if (result.status !== 0) {
    if (/E404|Not Found/i.test((result.stderr || '') + (result.stdout || ''))) return null;
    throw new Error('Registry lookup failed: ' + (result.stderr || result.stdout).slice(-800));
  }
  return JSON.parse(result.stdout.trim());
}
function receiptFile(revision) {
  return path.join(tmpdir(), 'brc-direct-release-' + revision + '.json');
}
async function command(tool, args, options = {}) {
  const executable = executables[tool] ?? { file: tool, prefix: [] };
  return progress.command(executable.file, [...executable.prefix, ...args], { cwd: root, ...options });
}
function saveReceipt(file, data) {
  writeFileSync(file, JSON.stringify(data) + '\n', { flag: 'w', mode: 0o600 });
}
async function finishRelease(receipt) {
  let actual;
  for (let attempt = 0; attempt < 6; attempt++) {
    actual = publishedVersion();
    if (actual === receipt.version) break;
    if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (actual !== receipt.version) {
    throw new Error('npm publication is not yet visible. Rerun pnpm release:brc to verify and tag the published version.');
  }
  progress.print('  Registry verified: ' + name + '@' + actual);
  if (!git('tag', '--list', receipt.tag)) quick('git', ['tag', receipt.tag]);
  await command('git', ['push', 'origin', receipt.tag]);
  rmSync(receiptFile(receipt.revision), { force: true });
  progress.print('  Published and tagged: ' + name + '@' + actual);
}
async function main() {
  if (git('branch', '--show-current') !== 'main') throw new Error('Run releases from main.');
  if (git('status', '--porcelain')) throw new Error('Commit all changes before release.');
  const revision = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (remote !== revision) throw new Error('Push main to origin before release.');
  const account = quick('npm', ['whoami', '--registry', registry]).stdout.trim();
  if (account !== 'inoceanlee') throw new Error('npm must be logged in as inoceanlee.');
  const manifest = JSON.parse(git('show', 'HEAD:packages/cli/package.json'));
  const rootManifest = JSON.parse(git('show', 'HEAD:package.json'));
  if (manifest.name !== name) throw new Error('Unexpected npm package name.');
  if (manifest.version !== rootManifest.version) {
    throw new Error('Fork root and npm package versions must match before publishing.');
  }

  const checkpoint = receiptFile(revision);
  if (existsSync(checkpoint)) {
    if (dryRun) throw new Error('A published release is awaiting registry verification. Finish it before another dry run.');
    const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
    if (saved.revision !== revision || saved.name !== name) throw new Error('Release checkpoint does not match the current source.');
    progress.print('  Resuming release verification: ' + name + '@' + saved.version);
    await finishRelease(saved);
    return;
  }
  if (git('tag', '--points-at', 'HEAD', '--list', 'brc-v*')) throw new Error('Current source commit already released.');
  const version = versionForRelease(manifest.version, publishedVersion());
  const tag = 'brc-v' + version;
  if (git('tag', '--list', tag)) throw new Error('Release tag already exists: ' + tag);
  progress.print('Release: ' + name + '@' + version);
  const traefik = process.env.BRC_TRAEFIK_TEST_BINARY || path.resolve(root, '../traefik/traefik.exe');
  if (!existsSync(traefik)) throw new Error('Traefik test binary missing: ' + traefik);
  const output = mkdtempSync(path.join(tmpdir(), 'brc-publish-'));
  await progress.step(1, 5, '构建并打包（gzip 9 级）', async () => {
    await command(process.execPath, [path.join(root, 'scripts/pack-brc.mjs'), output, '--version=' + version, '--with-next-patch']);
  });
  const archives = readdirSync(output).filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1 || archives[0] !== 'inoceanlee-brc-' + version + '.tgz') throw new Error('Unexpected package archives.');
  const archive = path.join(output, archives[0]);
  const v = version.split('.').map(Number);
  const nextVersion = [v[0], v[1], v[2] + 1].join('.');
  const nextArchive = path.join(output, 'next-patch', 'inoceanlee-brc-' + nextVersion + '.tgz');
  if (!existsSync(nextArchive)) throw new Error('Missing upgrade test archive.');
  const env = { ...process.env, BRC_TRAEFIK_TEST_BINARY: traefik, BRC_PACKAGE_TARBALL: archive, BRC_PACKAGE_UPDATED_TARBALL: nextArchive };
  await progress.step(2, 5, '完整单测与隔离安装', async () => {
    await command('pnpm', ['test:unit'], { env });
  });
  await progress.step(3, 5, 'Traefik、OAuth 与 MCP E2E', async () => {
    await command('pnpm', ['test:e2e'], { env });
  });
  await progress.step(4, 5, '检查 npm 发行包', async () => {
    await command('npm', ['publish', archive, '--dry-run', '--access', 'public', '--registry', registry]);
  });
  if (dryRun) {
    progress.print('Dry run passed. No package published.');
    return;
  }
  await progress.step(5, 5, '发布 npm（终端身份认证）', async () => {
    await command('npm', ['publish', archive, '--access', 'public', '--registry', registry], { interactive: true });
  });
  const receipt = { revision, version, tag, name };
  saveReceipt(checkpoint, receipt);
  await finishRelease(receipt);
}
main().catch((error) => {
  console.error('\nRelease stopped: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
