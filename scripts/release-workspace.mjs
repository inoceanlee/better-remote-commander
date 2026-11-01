import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Own only release-generated archives; never touch published packages or BRC data.
export async function withReleaseWorkspace(operation, { parent = tmpdir() } = {}) {
  const directory = mkdtempSync(path.join(parent, 'brc-publish-'));
  try {
    return await operation(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
