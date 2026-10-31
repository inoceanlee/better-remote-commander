import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ReleaseProgress } from '../scripts/release-progress.mjs';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/release-brc.mjs');
function execute(...args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: path.resolve('.'), encoding: 'utf8', timeout: 8_000, windowsHide: true,
  });
}

test('release automation advertises a safe dry-run mode', () => {
  const result = execute('--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pnpm release:brc \[--dry-run\]/);
  assert.match(result.stdout, /without uploading or tagging/);
});

test('release automation rejects unsupported arguments before publishing', () => {
  const result = execute('--publish-immediately');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: pnpm release:brc/);
});

test('publishing requires a local interactive terminal before build or network work', () => {
  const result = execute();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /local interactive terminal/);
});

test('progress runner captures child output and real progress updates', async () => {
  const output = { isTTY: false, data: '', write(text) { this.data += text; } };
  const runner = new ReleaseProgress({ output, errorOutput: output });
  await runner.step(1, 3, 'Build package', async () => {
    const result = await runner.command(process.execPath, ['-e', "process.stdout.write('BRC_PROGRESS:45\\nfinished\\n')"], { cwd: process.cwd() });
    assert.match(result.stdout, /finished/);
    assert.equal(runner.current.details, '45% gzip');
  });
  assert.match(output.data, /\[1\/3\] Build package/);
  assert.match(output.data, /✓/);
  assert.doesNotMatch(output.data, /\x1b\[2K/);
});

test('progress runner refreshes an interactive terminal while a step is active', async () => {
  const output = { isTTY: true, data: '', write(text) { this.data += text; } };
  const runner = new ReleaseProgress({ output, errorOutput: output });
  await runner.step(1, 1, 'Working', async () => {
    await new Promise((resolve) => setTimeout(resolve, 280));
  });
  assert.match(output.data, /\r\x1b\[2K/);
  assert.match(output.data, /⠋|⠙|⠹/);
  assert.match(output.data, /✓/);
});

test('progress runner preserves a concise error on subprocess failure', async () => {
  const output = { isTTY: false, data: '', write(text) { this.data += text; } };
  const runner = new ReleaseProgress({ output, errorOutput: output });
  await assert.rejects(
    runner.step(2, 3, 'Test failure', async () => runner.command(process.execPath, ['-e', "console.error('known failure');process.exit(3)"])),
    /known failure/,
  );
  assert.match(output.data, /✗/);
});

test('Fork root and published CLI use the same explicit release version', () => {
  const root = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
  const published = JSON.parse(readFileSync(path.resolve('packages/cli/package.json'), 'utf8'));
  assert.equal(root.version, published.version);
  assert.match(published.version, /^\d+\.\d+\.\d+$/);
  const [major, minor] = published.version.split('.').map(Number);
  assert.ok(major > 2 || (major === 2 && minor >= 1), 'Fork first feature release is at least 2.1.0');
});

test('direct publication uses an interactive npm process', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(source, /await command\('npm', \['publish', archive, '--access', 'public', '--registry', registry\], \{ interactive: true \}\)/);
  assert.doesNotMatch(source, /'stage', 'publish'/);
  assert.doesNotMatch(source, /awaitApproval/);
});

test('interactive subprocess inherits stdin and displays its output', () => {
  const source = [
    "import { ReleaseProgress } from './scripts/release-progress.mjs';",
    "const progress = new ReleaseProgress();",
    "await progress.step(1, 1, 'Authenticate', async () => {",
    "  await progress.command(process.execPath, ['-e',",
    "    \"process.stdin.once('data', v => { console.log('RECEIVED:' + v.toString().trim()); });\"",
    "  ], { interactive: true });",
    "});",
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: path.resolve('.'), input: 'test-otp-input\\n', encoding: 'utf8', timeout: 8_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RECEIVED:test-otp-input/);
  assert.match(result.stdout, /Authenticate/);
});

test('release automation is exposed only as a dedicated package command', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(manifest.scripts['release:brc'], 'node scripts/release-brc.mjs');
});
