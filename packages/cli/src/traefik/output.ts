import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import unzipper from 'unzipper';
import type { BrcPaths } from '../config/paths.js';
import { errorCode, validateArchiveEntries, type TraefikRelease, type TraefikTemplates, type VersionManifest } from './core.js';


export class TraefikOutput {
  constructor(private readonly paths: BrcPaths) { }

  async writeConfig(config: TraefikTemplates): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    const configDirectory = path.join(this.paths.traefik, 'config');
    await ensureSafeDirectory(this.paths.root, configDirectory);
    await writeAtomic(path.join(configDirectory, 'dynamic.yml'), config.dynamicConfig);
    await writeAtomic(path.join(configDirectory, 'traefik.yml'), config.staticConfig);
  }

  async stageArchive(release: TraefikRelease, response: Response, expectedChecksum: string): Promise<string> {
    const archivePath = path.join(this.paths.tmp, `traefik-${randomUUID()}.zip.part`);
    const stage = path.join(this.paths.traefik, 'versions', `.staging-${release.version}-${randomUUID()}`);
    try {
      if (!response.body) throw new Error('Official Traefik ZIP has no response body.');
      await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(archivePath, { flags: 'wx' }));
      if (await sha256File(archivePath) !== expectedChecksum) throw new Error('Official Traefik ZIP SHA-256 checksum does not match.');
      await mkdir(stage);
      await this.extractExecutable(archivePath, stage);
      return stage;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(archivePath, { force: true });
    }
  }

  async writeManifest(manifest: VersionManifest): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await writeAtomic(path.join(this.paths.traefik, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async promoteVersion(stage: string, version: string, previous: string | null): Promise<void> {
    const versionsDirectory = path.join(this.paths.traefik, 'versions');
    const targetDirectory = path.join(versionsDirectory, version);
    let promoted = false;
    try {
      await lstat(targetDirectory);
      await ensureSafeDirectory(this.paths.root, targetDirectory);
      const existingExecutable = path.join(targetDirectory, 'traefik.exe');
      await ensureRegularFile(existingExecutable);
      const stagedExecutable = path.join(stage, 'traefik.exe');
      if (await sha256File(existingExecutable) !== await sha256File(stagedExecutable)) {
        throw new Error(`Traefik version directory already contains different files: ${version}`);
      }
      await rm(stage, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await rename(stage, targetDirectory);
      promoted = true;
    }

    try {
      await this.writeManifest({ version: 1, current: version, previous: previous === version ? null : previous });
    } catch (error) {
      if (promoted) await rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async executableFor(version: string): Promise<string> {
    const versionDirectory = path.join(this.paths.traefik, 'versions', version);
    await ensureSafeDirectory(this.paths.root, versionDirectory);
    const executable = path.join(versionDirectory, 'traefik.exe');
    await ensureRegularFile(executable);
    return executable;
  }

  private async extractExecutable(archivePath: string, stage: string): Promise<void> {
    const directory = await unzipper.Open.file(archivePath);
    const executable = validateArchiveEntries(directory.files);
    const executableSize = executable.uncompressedSize;
    const target = path.join(stage, 'traefik.exe');
    await pipeline(executable.stream(), createWriteStream(target, { flags: 'wx' }));
    await ensureRegularFile(target);
    if ((await stat(target)).size !== executableSize) throw new Error('Extracted Traefik executable size does not match its ZIP entry.');
  }
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

export async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
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
