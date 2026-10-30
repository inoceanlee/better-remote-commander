import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface VersionManifest {
  version: 1;
  current: string;
  previous: string | null;
}

export interface TraefikRelease {
  version: string;
  archiveUrl: string;
  checksumUrl: string;
  archiveName: string;
}

export const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;

export function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

export function parseManifest(value: unknown): VersionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Traefik version manifest is malformed.');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !isVersion(manifest.current)
    || !(manifest.previous === null || isVersion(manifest.previous))
    || manifest.previous === manifest.current) {
    throw new Error('Traefik version manifest is malformed.');
  }
  return { version: 1, current: manifest.current, previous: manifest.previous };
}

export async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Traefik path is outside its installation directory: ${directory}`);
  }

  await mkdir(resolvedRoot, { recursive: true });
  let current = resolvedRoot;
  const rootInfo = await lstat(current);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error(`Traefik installation path is not a regular directory: ${current}`);
  if (relative === '') return;

  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await lstat(current);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await mkdir(current);
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Traefik path is not a regular directory: ${current}`);
  }
}

export async function ensureRegularFile(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Traefik path is not a regular file: ${filename}`);
}

export async function readManifest(root: string): Promise<VersionManifest | null> {
  const filename = path.join(root, 'versions.json');
  try {
    await ensureRegularFile(filename);
    return parseManifest(JSON.parse(await readFile(filename, 'utf8')) as unknown);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

export function safeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
  const segments = value.endsWith('/') ? value.slice(0, -1).split('/') : value.split('/');
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

export async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

export function quoteYaml(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

export function renderTemplate(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) result = result.replaceAll(placeholder, value);
  if (/@@BRC_[A-Z_]+@@/.test(result)) throw new Error('Traefik configuration has an unresolved template value.');
  return result;
}

export async function writeAtomic(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}
