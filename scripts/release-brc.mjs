import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
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
  console.log('Validate, build, test and stage @inoceanlee/brc for browser 2FA approval.');
  console.log('Use --dry-run to validate without uploading or tagging.');
  process.exit(0);
}
if (!dryRun && !process.stdin.isTTY) {
  console.error('npm approval requires a local interactive terminal. Run pnpm release:brc locally.');
  process.exit(2);
}

const progress = new ReleaseProgress({ verbose });
function binary(command) {
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) return command;
  const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (found.status !== 0) throw new Error('Missing ' + command + ' on PATH.');
  const files = found.stdout.split(/\r?\n/).filter(Boolean);
  return files.find((file) => /\.exe$/i.test(file)) ?? files.find((file) => /\.cmd$/i.test(file)) ?? command;
}
const executables = Object.fromEntries(['git', 'npm', 'pnpm'].map((cmd) => [cmd, binary(cmd)]));
function quick(command, args, { allowFailure = false } = {}) {
  const file = executables[command] ?? command;
  const result = spawnSync(file, args, {
    cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file),
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
  return path.join(tmpdir(), 'brc-release-stage-' + revision + '.json');
}
async function command(tool, args, options = {}) {
  return progress.command(executables[tool] ?? tool, args, { cwd: root, ...options });
}
function saveReceipt(file, data) {
  writeFileSync(file, JSON.stringify(data) + '\n', { flag: 'w', mode: 0o600 });
}
async function awaitApproval(version, receipt) {
  let actual = publishedVersion();
  if (actual !== version) {
    const stageList = quick('npm', ['stage', 'list', name, '--registry', registry, '--json']);
    progress.print('  npm 待审批版本: ' + version);
    if (verbose) progress.print('  Staged packages: ' + stageList.stdout.trim().slice(0, 1500));
    progress.print('  在 https://www.npmjs.com 登录，打开 Staged Packages，审核并批准 ' + name + '@' + version + '。');
    progress.print('  审批需要在 npm 网站完成 2FA；不要将验证码或令牌输入脚本。');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question('  网站批准后，返回终端按 Enter 继续验证（Ctrl+C 可保留待审批版本）：');
    } finally { rl.close(); }
    actual = publishedVersion();
  }
  if (actual !== version) {
    throw new Error('Registry version not yet approved. Staged version remains available. Rerun pnpm release:brc after approval.');
  }
  progress.print('  Registry verified: ' + name + '@' + actual);
  const tag = receipt.tag;
  if (!git('tag', '--list', tag)) quick('git', ['tag', tag]);
  await command('git', ['push', 'origin', tag]);
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
  if (manifest.name !== name) throw new Error('Unexpected npm package name.');

  const checkpoint = receiptFile(revision);
  if (existsSync(checkpoint)) {
    if (dryRun) throw new Error('A release is awaiting approval. Finalize it before starting another dry run.');
    const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
    if (saved.revision !== revision || saved.name !== name) throw new Error('Release checkpoint does not match the current source.');
    progress.print('  Resuming staged release: ' + name + '@' + saved.version);
    await awaitApproval(saved.version, saved);
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
    progress.print('Dry run passed. No package staged or published.');
    return;
  }
  await progress.step(5, 5, '上传 npm 待审批版本', async () => {
    await command('npm', ['stage', 'publish', archive, '--access', 'public', '--registry', registry]);
  });
  const receipt = { revision, version, tag, name };
  saveReceipt(checkpoint, receipt);
  await awaitApproval(version, receipt);
}
main().catch((error) => {
  console.error('\nRelease stopped: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
