import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import unzipper, { type ZipEntry } from 'unzipper';
import type { BrcPaths } from '../config/paths.js';
import { MAX_EXECUTABLE_BYTES, ensureRegularFile, safeArchivePath, sha256File, type TraefikRelease } from './core.js';

const RELEASE_API_URL = 'https://api.github.com/repos/traefik/traefik/releases/latest';

export interface TraefikInputOptions {
  releaseApiUrl?: string;
  fetch?: typeof fetch;
}

export class TraefikInput {
  private readonly fetchImpl: typeof fetch;
  private readonly releaseApiUrl: string;

  constructor(private readonly paths: BrcPaths, options: TraefikInputOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.releaseApiUrl = options.releaseApiUrl ?? RELEASE_API_URL;
  }

  async latestRelease(): Promise<TraefikRelease> {
    const response = await this.fetchImpl(this.releaseApiUrl, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'brc-unified-cli' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Cannot query the official Traefik release feed: HTTP ${response.status}.`);
    const value = await response.json() as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Official Traefik release metadata is malformed.');
    const release = value as Record<string, unknown>;
    if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string') {
      throw new Error('The latest Traefik release is not a stable release.');
    }
    const match = release.tag_name.match(/^v(\d+\.\d+\.\d+)$/);
    if (!match) throw new Error(`Official Traefik release tag is invalid: ${release.tag_name}`);
    const version = match[1];
    const archiveName = `traefik_v${version}_windows_amd64.zip`;
    const checksumName = `traefik_v${version}_checksums.txt`;
    if (!Array.isArray(release.assets)) throw new Error('Official Traefik release has no asset list.');
    const assets = release.assets as unknown[];
    const findAsset = (name: string): string => {
      const asset = assets.find((item) => item && typeof item === 'object' && (item as Record<string, unknown>).name === name) as Record<string, unknown> | undefined;
      const url = asset?.browser_download_url;
      const expected = `https://github.com/traefik/traefik/releases/download/v${version}/${name}`;
      if (url !== expected) throw new Error(`Official Traefik asset is missing or has an unexpected URL: ${name}`);
      return expected;
    };
    return { version, archiveName, archiveUrl: findAsset(archiveName), checksumUrl: findAsset(checksumName) };
  }

  async downloadAndStage(release: TraefikRelease): Promise<string> {
    const checksumResponse = await this.fetchImpl(release.checksumUrl, { signal: AbortSignal.timeout(30_000) });
    if (!checksumResponse.ok) throw new Error(`Cannot download the official Traefik checksum file: HTTP ${checksumResponse.status}.`);
    const expectedChecksum = this.readChecksum(await checksumResponse.text(), release.archiveName);
    const archivePath = path.join(this.paths.tmp, `traefik-${randomUUID()}.zip.part`);
    const stage = path.join(this.paths.traefik, 'versions', `.staging-${release.version}-${randomUUID()}`);
    try {
      const archiveResponse = await this.fetchImpl(release.archiveUrl, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!archiveResponse.ok || !archiveResponse.body) throw new Error(`Cannot download the official Traefik ZIP: HTTP ${archiveResponse.status}.`);
      await pipeline(Readable.fromWeb(archiveResponse.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(archivePath, { flags: 'wx' }));
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

  private readChecksum(contents: string, filename: string): string {
    for (const line of contents.split(/\r?\n/)) {
      const match = line.trim().match(/^([a-f\d]{64})\s+\*?(.+)$/i);
      if (match?.[2] === filename) return match[1].toLowerCase();
    }
    throw new Error(`Official Traefik checksum file does not contain ${filename}.`);
  }

  private async extractExecutable(archivePath: string, stage: string): Promise<void> {
    const directory = await unzipper.Open.file(archivePath);
    const names = new Set<string>();
    let executable: ZipEntry | undefined;
    for (const entry of directory.files) {
      if (!safeArchivePath(entry.path)) throw new Error(`Traefik ZIP contains an unsafe path: ${entry.path}`);
      if (names.has(entry.path)) throw new Error(`Traefik ZIP contains a duplicate path: ${entry.path}`);
      names.add(entry.path);
      if (entry.path === 'traefik.exe' && entry.type === 'File') executable = entry;
    }
    const executableSize = executable?.uncompressedSize;
    if (!executable || typeof executableSize !== 'number' || executableSize < 1 || executableSize > MAX_EXECUTABLE_BYTES) {
      throw new Error('Traefik ZIP does not contain a valid root-level traefik.exe.');
    }
    const target = path.join(stage, 'traefik.exe');
    await pipeline(executable.stream(), createWriteStream(target, { flags: 'wx' }));
    await ensureRegularFile(target);
    if ((await stat(target)).size !== executableSize) throw new Error('Extracted Traefik executable size does not match its ZIP entry.');
  }
}
