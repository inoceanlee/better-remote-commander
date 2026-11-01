import assert from 'node:assert/strict';
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const native = path.resolve('packages/cli/dist/native/win32-x64/brc-process.exe');
const isWindows = process.platform === 'win32' && process.arch === 'x64';
function inspect(...pids) {
  return JSON.parse(execFileSync(native, ['inspect', ...pids.map(String)], {
    encoding: 'utf8', windowsHide: true, timeout: 8000, shell: false,
  })).processes;
}

test('native inspector is a packaged Windows executable with JSON output', { skip: !isWindows }, () => {
  assert.ok(existsSync(native));
  const [self] = inspect(process.pid);
  assert.equal(self.pid, process.pid);
  assert.equal(self.status, 'found');
  assert.match(self.createdAt, /^\d+$/);
  assert.ok(path.isAbsolute(self.executablePath));
  assert.ok(self.commandLine.includes('brc-native-process.test.mjs'));
});

test('native inspector returns one row per unique PID and distinguishes missing processes', { skip: !isWindows }, () => {
  const rows = inspect(process.pid, process.pid, 4294967295);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.pid), [process.pid, 4294967295]);
  assert.equal(rows[0].status, 'found');
  assert.equal(rows[1].status, 'not_found');
});

test('native inspector rejects invalid PID arguments', { skip: !isWindows }, () => {
  for (const pid of ['0', '-1', '1x', '4294967296', ';']) {
    const result = spawnSync(native, ['inspect', pid], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    assert.notEqual(result.status, 0, pid);
    assert.equal(result.stdout.trim(), '', pid);
  }
});

test('native inspector returns command line with quoted UTF-8 arguments', { skip: !isWindows }, async (t) => {
  const marker = 'quoted-汉字-arg="x"';
  const child = spawn(process.execPath, ['-e', 'console.log("READY");setInterval(() => {}, 1000)', marker], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false,
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await Promise.race([
    new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); }),
    sleep(5000).then(() => { throw new Error('Test child did not start'); }),
  ]);
  const [found] = inspect(child.pid);
  assert.equal(found.status, 'found');
  assert.ok(found.commandLine.includes(marker.replaceAll('"', '\\"')), found.commandLine);
});
