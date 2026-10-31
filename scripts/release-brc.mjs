import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = '@inoceanlee/brc';
const registry = 'https://registry.npmjs.org/';
const binaryCache = new Map();
const dryRun = process.argv.includes('--dry-run');
const help = process.argv.includes('--help');
if (process.argv.slice(2).some((arg) => !['--dry-run', '--help'].includes(arg))) {
  throw new Error('Usage: pnpm release:brc [--dry-run|--help]');
}
if (help) {
  console.log('pnpm release:brc [--dry-run]');
  console.log('Validate main, build, test, package and publish @inoceanlee/brc.');
  console.log('Use --dry-run to run every check without publishing or tagging.');
  process.exit(0);
}

function binary(command) {
  if (process.platform !== 'win32' || !['pnpm', 'npm'].includes(command)) {
    return { file: command, shell: false };
  }
  if (binaryCache.has(command)) return binaryCache.get(command);
  const found = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (found.status !== 0) throw new Error('Missing ' + command + ' on PATH.');
  const paths = found.stdout.split(/\r?\n/).filter(Boolean);
  const file = paths.find((item) => /\.exe$/i.test(item))
    ?? paths.find((item) => /\.(?:cmd|bat)$/i.test(item));
  if (!file) throw new Error('Missing executable for ' + command);
  const resolved = { file, shell: !/\.exe$/i.test(file) };
  binaryCache.set(command, resolved);
  return resolved;
}

function run(command, args, { interactive = false, env = process.env, allowFailure = false } = {}) {
  const target = binary(command);
  const result = spawnSync(target.file, args, {
    cwd: root, env, shell: target.shell, windowsHide: true,
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: interactive ? 'inherit' : 'pipe',
    timeout: interactive ? undefined : 600_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    const details = (result.stderr || result.stdout || '').trim().slice(-2200);
    throw new Error(command + ' ' + args[0] + ' failed: ' + details);
  }
  return result;
}

function patchVersion(source, published) {
  const parse = (value) => {
    if (!/^\d+\.\d+\.\d+$/.test(value)) throw new Error('Unsupported release version: ' + value);
    return value.split('.').map(Number);
  };
  const left = parse(source);
  if (!published) return source;
  const right = parse(published);
  const sourceIsNewer = left.some((n, i) => n !== right[i] && left.slice(0, i).every((m, j) => m === right[j]) && n > right[i]);
  return sourceIsNewer ? source : [right[0], right[1], right[2] + 1].join('.');
}

function release() {
  const git = (...args) => run('git', args).stdout.trim();
  if (git('branch', '--show-current') !== 'main') throw new Error('Run releases from main.');
  if (git('status', '--porcelain')) throw new Error('Commit all changes before release.');
  const revision = git('rev-parse', 'HEAD');
  const remote = git('ls-remote', 'origin', 'refs/heads/main').split(/\s+/)[0];
  if (remote !== revision) throw new Error('Push main to origin before release.');
  const existingTags = git('tag', '--points-at', 'HEAD', '--list', 'brc-v*');
  if (existingTags) throw new Error('Current source commit already released: ' + existingTags);
  const account = run('npm', ['whoami', '--registry', registry]).stdout.trim();
  if (account !== 'inoceanlee') throw new Error('npm must be logged in as inoceanlee.');

  const lookup = run('npm', ['view', name, 'version', '--json', '--registry', registry], { allowFailure: true });
  if (lookup.status !== 0 && !/E404|Not Found/i.test((lookup.stderr ?? '') + (lookup.stdout ?? ''))) {
    throw new Error('Unable to read npm package version: ' + (lookup.stderr || lookup.stdout).slice(-1200));
  }
  const latest = lookup.status === 0 ? JSON.parse(lookup.stdout.trim()) : null;
  const manifest = JSON.parse(run('git', ['show', 'HEAD:packages/cli/package.json']).stdout);
  if (manifest.name !== name) throw new Error('Unexpected npm package name.');
  const version = patchVersion(manifest.version, latest);
  const tag = 'brc-v' + version;
  if (git('tag', '--list', tag)) throw new Error('Release tag already exists: ' + tag);
  console.log('Release: ' + name + '@' + version + ' (' + revision.slice(0, 9) + ')');
  console.log('1/5 Build and assemble npm tarball');
  const traefik = path.resolve(root, '../traefik/traefik.exe');
  if (!existsSync(traefik)) throw new Error('Traefik integration test binary is missing: ' + traefik);
  const output = mkdtempSync(path.join(tmpdir(), 'brc-publish-'));
  run(process.execPath, [path.join(root, 'scripts/pack-brc.mjs'), output, '--version=' + version, '--with-next-patch']);
  const archives = readdirSync(output).filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1 || archives[0] !== 'inoceanlee-brc-' + version + '.tgz') {
    throw new Error('Unexpected npm package archive list: ' + archives.join(', '));
  }
  const nextVersion = version.replace(/\d+$/, (minor) => String(Number(minor) + 1));
  const nextArchive = path.join(output, 'next-patch', 'inoceanlee-brc-' + nextVersion + '.tgz');
  if (!existsSync(nextArchive)) throw new Error('Missing next-patch test archive.');
  const archive = path.join(output, archives[0]);
  console.log('2/5 Run all tests against the prepared package');
  const testEnv = {
    ...process.env,
    BRC_TRAEFIK_TEST_BINARY: traefik,
    BRC_PACKAGE_TARBALL: archive,
    BRC_PACKAGE_UPDATED_TARBALL: nextArchive,
  };
  run('pnpm', ['test:unit'], { env: testEnv });
  run('pnpm', ['test:e2e'], { env: testEnv });
  console.log('3/5 Validate npm package contents');
  run('npm', ['publish', archive, '--dry-run', '--access', 'public', '--registry', registry]);
  if (dryRun) {
    console.log('Dry run passed. Release archive: ' + archive);
    return;
  }
  console.log('4/5 Publish to npm');
  run('npm', ['publish', archive, '--access', 'public', '--registry', registry], { interactive: true });
  console.log('5/5 Verify registry and tag release');
  const result = run('npm', ['view', name + '@' + version, 'version', '--json', '--registry', registry]);
  if (JSON.parse(result.stdout.trim()) !== version) throw new Error('Published version verification failed.');
  run('git', ['tag', tag]);
  run('git', ['push', 'origin', tag]);
  console.log('Published and tagged: ' + name + '@' + version);
}
release();
