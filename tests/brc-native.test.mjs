import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const binary = path.resolve('native/brc-process/target/x86_64-pc-windows-msvc/release/brc-process.exe');
function run(...args) {
  return spawnSync(binary, args, { encoding: 'utf8', windowsHide: true, shell: false, timeout: 5_000 });
}
test('native inspector exists and returns a complete identity for current PID', () => {
  assert.equal(existsSync(binary), true);
  const result = run('inspect', String(process.pid), String(process.pid));
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.processes.length, 1);
  assert.equal(parsed.processes[0].status, 'found');
  assert.ok(/^\d+$/.test(parsed.processes[0].createdAt));
  assert.ok(parsed.processes[0].executablePath.toLowerCase().includes('node'));
  assert.ok(parsed.processes[0].commandLine.includes('brc-native.test.mjs'));
});
test('native inspector rejects malformed arguments and reports missing processes', () => {
  assert.notEqual(run('inspect', '-1').status, 0);
  assert.notEqual(run('inspect', 'abc').status, 0);
  assert.notEqual(run('noop', '123').status, 0);
  const result = run('inspect', '4294967294');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { processes: [{ pid: 4294967294, status: 'not_found' }] });
});
