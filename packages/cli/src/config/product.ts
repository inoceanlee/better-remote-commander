import { readFileSync } from 'node:fs';

/** Product metadata is owned by the publishable CLI package manifest. */
export function readProductVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    throw new Error('Missing or invalid CLI product version.');
  }
  return manifest.version;
}
