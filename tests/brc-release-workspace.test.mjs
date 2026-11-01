import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ReleaseArtifactStore, ReleaseLock } from '../scripts/release-artifact.mjs';
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

test('release artifacts persist validated archive and reject archive tampering', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-release-artifacts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'candidate.tgz');
  await writeFile(archive, 'release bytes');
  const store = new ReleaseArtifactStore(path.join(root, 'store'));
  const input = {
    archive, revision: 'a'.repeat(40), name: '@inoceanlee/brc',
    version: '2.1.3', buildFingerprint: 'fingerprint',
    validations: { unit: true, package: true, e2e: true, dryRun: true },
  };
  const saved = await store.save(input);
  assert.equal((await store.find(input)).integrity, saved.integrity);
  await writeFile(saved.archivePath, 'changed bytes');
  assert.equal(await store.find(input), null);
});

test('unknown publish attempts persist and prevent a second upload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-release-attempt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, 'candidate.tgz');
  await writeFile(archive, 'release bytes');
  const store = new ReleaseArtifactStore(path.join(root, 'store'));
  const artifact = await store.save({
    archive, revision: 'b'.repeat(40), name: '@inoceanlee/brc',
    version: '2.1.3', buildFingerprint: 'fingerprint',
    validations: { unit: true, package: true, e2e: true, dryRun: true },
  });
  const attempted = await store.markAttempted(artifact);
  assert.equal(attempted.publishAttempted, true);
  assert.equal((await store.find(artifact)).publishAttempted, true);
});

test('release lock rejects concurrent owners without replacing the active lock', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'brc-release-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = new ReleaseLock(path.join(root, 'release.lock'));
  let release;
  const owner = lock.withExclusive(() => new Promise((resolve) => { release = resolve; }));
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(lock.withExclusive(() => 'second'), /already held/);
  release('first');
  assert.equal(await owner, 'first');
  assert.equal(await lock.withExclusive(() => 'next'), 'next');
});
