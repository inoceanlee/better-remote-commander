import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { TRAEFIK_RELEASE_LOOKUP_ATTEMPTS, TRAEFIK_RELEASE_RETRY_DELAY_MS } from '../config/settings.js';
import { errorCode, parseManifest, parseRelease, type TraefikRelease, type TraefikTemplates, type VersionManifest } from './core.js';
import { ensureRegularFile } from './output.js';

const RELEASE_API_URL = 'https://api.github.com/repos/traefik/traefik/releases/latest';

export interface TraefikInputOptions {
  releaseApiUrl?: string;
  fetch?: typeof fetch;
}

export class TraefikInput {
  private readonly fetchImpl: typeof fetch;
  private readonly releaseApiUrl: string;

  constructor(options: TraefikInputOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.releaseApiUrl = options.releaseApiUrl ?? RELEASE_API_URL;
  }

  private async queryRelease(): Promise<Response> {
    const maxAttempts = TRAEFIK_RELEASE_LOOKUP_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.releaseApiUrl, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'brc-unified-cli' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch (error) {
        if (attempt === maxAttempts) throw new Error('Cannot reach the official Traefik release feed. Retry brc setup.', { cause: error });
        await sleep(TRAEFIK_RELEASE_RETRY_DELAY_MS);
        continue;
      }
      if (response.ok) return response;
      const rateLimited = response.headers.get('x-ratelimit-remaining') === '0';
      if (rateLimited) {
        throw new Error(`GitHub API rate limit reached (HTTP ${response.status}). Retry brc setup after the limit resets.`);
      }
      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterSeconds = retryAfterHeader === null ? NaN : Number(retryAfterHeader);
      if (response.status === 429 && Number.isFinite(retryAfterSeconds)
        && retryAfterSeconds > TRAEFIK_RELEASE_RETRY_DELAY_MS / 1000) {
        throw new Error(`GitHub API is throttling requests (HTTP 429). Retry after ${retryAfterSeconds} seconds before running brc setup.`);
      }
      const transient = [403, 429, 500, 502, 503, 504].includes(response.status);
      if (!transient || attempt === maxAttempts) {
        throw new Error(`Cannot query the official Traefik release feed: HTTP ${response.status}. Retry brc setup after verifying GitHub access.`);
      }
      await response.body?.cancel();
      await sleep(TRAEFIK_RELEASE_RETRY_DELAY_MS);
    }
    throw new Error('Traefik release lookup failed.');
  }

  async latestRelease(): Promise<TraefikRelease> {
    const response = await this.queryRelease();
    return parseRelease(await response.json() as unknown);
  }

  async readTemplates(): Promise<TraefikTemplates> {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDirectory, '../../deploy/traefik'),
      path.resolve(moduleDirectory, '../../../../deploy/traefik'),
    ];
    for (const directory of candidates) {
      try {
        return {
          staticConfig: await readFile(path.join(directory, 'traefik.yml'), 'utf8'),
          dynamicConfig: await readFile(path.join(directory, 'dynamic.yml'), 'utf8'),
        };
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    throw new Error('Traefik deployment templates are missing from the BRC package.');
  }
  async downloadChecksum(release: TraefikRelease): Promise<string> {
    const response = await this.fetchImpl(release.checksumUrl, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Cannot download the official Traefik checksum file: HTTP ${response.status}.`);
    return response.text();
  }

  async downloadArchive(
    release: TraefikRelease,
    onProgress?: (completedBytes: number, totalBytes?: number) => void,
  ): Promise<Buffer> {
    const response = await this.fetchImpl(release.archiveUrl, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`Cannot download the official Traefik ZIP: HTTP ${response.status}.`);

    const length = response.headers.get('content-length');
    const parsedLength = length && /^\d+$/.test(length) ? Number(length) : undefined;
    const totalBytes = !response.headers.get('content-encoding') && parsedLength !== undefined
      && Number.isSafeInteger(parsedLength) && parsedLength > 0 ? parsedLength : undefined;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let completedBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        completedBytes += value.byteLength;
        onProgress?.(completedBytes, totalBytes);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, completedBytes);
  }


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
