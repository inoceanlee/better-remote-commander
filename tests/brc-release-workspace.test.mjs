import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withReleaseWorkspace } from '../scripts/release-workspace.mjs';

test('release workspace removes generated archives after success', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brc-release-workspace-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const output = await withReleaseWorkspace(async (directory) => {
    await writeFile(path.join(directory, 'package.tgz'), 'test');
    return directory;
  }, { parent });
  assert.equal(existsSync(output), false);
});

test('release workspace removes generated archives after failure', async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), 'brc-release-workspace-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  let generated;
  await assert.rejects(
    withReleaseWorkspace(async (directory) => {
      generated = directory;
      await writeFile(path.join(directory, 'package.tgz'), 'test');
      throw new Error('publish rejected');
    }, { parent }),
    /publish rejected/,
  );
  assert.equal(existsSync(generated), false);
});
