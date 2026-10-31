import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  assert.match(result.stdout, /without publishing or tagging/);
});

test('release automation rejects unsupported arguments before publishing', () => {
  const result = execute('--publish-immediately');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: pnpm release:brc/);
});

test('publishing requires a local interactive terminal before build or network work', () => {
  const result = execute();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /interactive terminal for two-factor authentication/);
});

test('release automation is exposed only as a dedicated package command', () => {
  const manifest = JSON.parse(readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(manifest.scripts['release:brc'], 'node scripts/release-brc.mjs');
});
