import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from './paths.js';
import type { BrcSettings } from './settings.js';

interface YamlSerializer {
  safeDump(value: unknown, options: { noRefs: boolean }): string;
}

const requireFromHere = createRequire(import.meta.url);

export function serializeSettings(settings: Readonly<BrcSettings>): string {
  const yaml = requireFromHere('js-yaml') as YamlSerializer;
  return yaml.safeDump(settings, { noRefs: true });
}

async function writeAtomically(filename: string, contents: string): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(filename), { recursive: true });
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeConfigText(paths: BrcPaths, contents: string): Promise<void> {
  await writeAtomically(path.join(paths.config, 'brc.yaml'), contents);
}

export async function writeLastGoodText(paths: BrcPaths, contents: string): Promise<void> {
  await writeAtomically(path.join(paths.config, 'brc.yaml.last-good'), contents);
}

export async function removeConfigFile(paths: BrcPaths): Promise<void> {
  await rm(path.join(paths.config, 'brc.yaml'), { force: true });
}

export async function removeLastGoodFile(paths: BrcPaths): Promise<void> {
  await rm(path.join(paths.config, 'brc.yaml.last-good'), { force: true });
}

export async function writeSettings(paths: BrcPaths, settings: Readonly<BrcSettings>): Promise<string> {
  const contents = serializeSettings(settings);
  await writeConfigText(paths, contents);
  return contents;
}
