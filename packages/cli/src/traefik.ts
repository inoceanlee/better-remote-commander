import { createHash, randomUUID } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { finished, pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import unzipper, { type ZipEntry } from 'unzipper';
import { appendRotatingLog, installManagedLog, startManagedControlServer, type ManagedControlServer } from 'brc-shared';
import type { BrcPaths } from './config/paths.js';

const RELEASE_API_URL = 'https://api.github.com/repos/traefik/traefik/releases/latest';
const MAX_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 15_000;
const CONTROLLED_STOP_TIMEOUT_MS = 3_000;
const execFile = promisify(execFileCallback);

interface VersionManifest {
  version: 1;
  current: string;
  previous: string | null;
}

interface TraefikRelease {
  version: string;
  archiveUrl: string;
  checksumUrl: string;
  archiveName: string;
}


export interface TraefikManagerOptions {
  releaseApiUrl?: string;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  verifyExecutable?: (filename: string, version: string) => Promise<void>;
  healthCheck?: (filename: string, version: string) => Promise<void>;
}


function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value);
}

function parseManifest(value: unknown): VersionManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Traefik version manifest is malformed.');
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 1 || !isVersion(manifest.current)
    || !(manifest.previous === null || isVersion(manifest.previous))
    || manifest.previous === manifest.current) {
    throw new Error('Traefik version manifest is malformed.');
  }
  return { version: 1, current: manifest.current, previous: manifest.previous };
}

async function ensureSafeDirectory(root: string, directory: string): Promise<void> {
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

async function ensureRegularFile(filename: string): Promise<void> {
  const info = await lstat(filename);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Traefik path is not a regular file: ${filename}`);
}

async function readManifest(root: string): Promise<VersionManifest | null> {
  const filename = path.join(root, 'versions.json');
  try {
    await ensureRegularFile(filename);
    return parseManifest(JSON.parse(await readFile(filename, 'utf8')) as unknown);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function parsePort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${name} must be an integer from 1 to 65535.`);
  return port;
}

function portsFromEnvironment(env: NodeJS.ProcessEnv) {
  const relay = parsePort(env.BRC_RELAY_PORT, 3000, 'BRC_RELAY_PORT');
  const proxy = parsePort(env.BRC_TRAEFIK_PORT, 13001, 'BRC_TRAEFIK_PORT');
  const health = parsePort(env.BRC_TRAEFIK_HEALTH_PORT, 13002, 'BRC_TRAEFIK_HEALTH_PORT');
  if (new Set([relay, proxy, health]).size !== 3) throw new Error('BRC_RELAY_PORT, BRC_TRAEFIK_PORT, and BRC_TRAEFIK_HEALTH_PORT must be different ports.');
  return { relay, proxy, health };
}

function quoteYaml(value: string): string {
  return JSON.stringify(value.replaceAll('\\', '/'));
}

function renderTemplate(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) result = result.replaceAll(placeholder, value);
  if (/@@BRC_[A-Z_]+@@/.test(result)) throw new Error('Traefik configuration has an unresolved template value.');
  return result;
}

function safeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.includes('\0') || value.startsWith('/') || /^[a-z]:/i.test(value)) return false;
  const segments = value.endsWith('/') ? value.slice(0, -1).split('/') : value.split('/');
  return segments.length > 0 && segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeAtomic(filename: string, contents: string): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('Local test server did not receive a TCP port.'));
      resolve(address.port);
    });
  });
}

async function reservePorts(count: number): Promise<number[]> {
  const servers = Array.from({ length: count }, () => createServer());
  try {
    const ports = await Promise.all(servers.map((server) => listen(server)));
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
    return ports;
  } catch (error) {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    throw error;
  }
}

function requestStatus(port: number, pathname: string): Promise<number> {
  return new Promise((resolve) => {
    const requestHandle = request({ host: '127.0.0.1', port, method: 'GET', path: pathname, agent: false }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    requestHandle.setTimeout(1_000, () => requestHandle.destroy());
    requestHandle.once('error', () => resolve(0));
    requestHandle.end();
  });
}

async function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
  return exited;
}

async function verifyExecutable(filename: string, expectedVersion: string): Promise<void> {
  const info = await stat(filename);
  if (!info.isFile() || info.size === 0) throw new Error('Traefik executable is empty or missing.');
  const { stdout, stderr } = await execFile(filename, ['version'], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 });
  const output = `${stdout}\n${stderr}`;
  const match = output.match(/\bVersion:\s*v?(\d+\.\d+\.\d+)\b/);
  if (match?.[1] !== expectedVersion) throw new Error(`Traefik executable version does not match ${expectedVersion}: ${output.trim()}`);
}

async function waitForHealth(child: ReturnType<typeof spawn>, port: number, timeoutMs: number, detail: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Traefik exited before becoming healthy: ${detail()}`);
    if (await requestStatus(port, '/ping') === 200) return;
    await sleep(100);
  }
  throw new Error(`Traefik did not become healthy on /ping: ${detail()}`);
}

async function runHealthProbe(filename: string, paths: BrcPaths, templates: { staticConfig: string; dynamicConfig: string }): Promise<void> {
  await ensureSafeDirectory(paths.root, paths.tmp);
  const directory = path.join(paths.tmp, `traefik-probe-${randomUUID()}`);
  await mkdir(directory);
  const backend = createServer((_request, response) => response.writeHead(200).end('ok'));
  let child: ReturnType<typeof spawn> | undefined;
  let childError: Error | undefined;
  let logs = '';
  try {
    const backendPort = await listen(backend);
    const [proxyPort, healthPort] = await reservePorts(2);
    const dynamicPath = path.join(directory, 'dynamic.yml');
    const staticPath = path.join(directory, 'traefik.yml');
    await writeFile(dynamicPath, renderTemplate(templates.dynamicConfig, { '@@BRC_RELAY_URL@@': quoteYaml(`http://127.0.0.1:${backendPort}`) }), { flag: 'wx' });
    await writeFile(staticPath, renderTemplate(templates.staticConfig, {
      '@@BRC_WEB_ADDRESS@@': quoteYaml(`127.0.0.1:${proxyPort}`),
      '@@BRC_HEALTH_ADDRESS@@': quoteYaml(`127.0.0.1:${healthPort}`),
      '@@BRC_DYNAMIC_FILE@@': quoteYaml(dynamicPath),
    }), { flag: 'wx' });

    child = spawn(filename, [`--configFile=${staticPath}`], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.on('data', (chunk: Buffer) => { logs = `${logs}${chunk.toString('utf8')}`.slice(-8192); });
    child.stderr?.on('data', (chunk: Buffer) => { logs = `${logs}${chunk.toString('utf8')}`.slice(-8192); });
    child.once('error', (error) => { childError = error; });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve());
      child?.once('error', reject);
    });
    await waitForHealth(child, healthPort, STARTUP_TIMEOUT_MS, () => childError?.message ?? logs);

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (await requestStatus(proxyPort, '/__brc_probe') === 200) return;
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(100);
    }
    throw new Error(`Traefik dynamic route failed its local health probe: ${childError?.message ?? logs}`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, CONTROLLED_STOP_TIMEOUT_MS);
    }
    await new Promise<void>((resolve) => backend.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function readTemplates(): Promise<{ staticConfig: string; dynamicConfig: string }> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDirectory, 'deploy', 'traefik'),
    path.resolve(moduleDirectory, '../../../deploy/traefik'),
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

export class TraefikManager {
  private queue: Promise<void> = Promise.resolve();
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly releaseApiUrl: string;
  private readonly verify: (filename: string, version: string) => Promise<void>;
  private readonly healthCheck: (filename: string, version: string) => Promise<void>;

  constructor(private readonly paths: BrcPaths, options: TraefikManagerOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.env = options.env ?? process.env;
    this.releaseApiUrl = options.releaseApiUrl ?? RELEASE_API_URL;
    this.verify = options.verifyExecutable ?? verifyExecutable;
    this.healthCheck = options.healthCheck ?? (async (filename) => runHealthProbe(filename, this.paths, await readTemplates()));
  }

  setup(): Promise<void> {
    return this.exclusive(async () => {
      await this.prepareDirectories();
      const installed = await readManifest(this.paths.traefik);
      if (installed) {
        const executable = await this.executableFor(installed.current);
        await this.verify(executable, installed.current);
        await this.healthCheck(executable, installed.current);
        await this.writeConfig();
        return;
      }
      const release = await this.latestRelease();
      const stage = await this.downloadAndStage(release);
      try {
        await this.verify(path.join(stage, 'traefik.exe'), release.version);
        await this.healthCheck(path.join(stage, 'traefik.exe'), release.version);
        await this.writeConfig();
        await this.commitVersion(stage, release.version, null);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
  }

  update(): Promise<void> {
    return this.exclusive(async () => {
      await this.prepareDirectories();
      const installed = await readManifest(this.paths.traefik);
      if (!installed) throw new Error('Traefik is not installed. Run brc setup first.');
      const currentExecutable = await this.executableFor(installed.current);
      await this.verify(currentExecutable, installed.current);

      const release = await this.latestRelease();
      if (release.version === installed.current) {
        await this.healthCheck(currentExecutable, installed.current);
        await this.writeConfig();
        return;
      }

      const stage = await this.downloadAndStage(release);
      try {
        const executable = path.join(stage, 'traefik.exe');
        await this.verify(executable, release.version);
        await this.healthCheck(executable, release.version);
        await this.writeConfig();
        await this.commitVersion(stage, release.version, installed.current);
      } finally {
        await rm(stage, { recursive: true, force: true });
      }
    });
  }

  async currentVersion(): Promise<string | null> {
    return (await readManifest(this.paths.traefik))?.current ?? null;
  }

  rollbackUpdate(): Promise<void> {
    return this.exclusive(async () => {
      const installed = await readManifest(this.paths.traefik);
      if (!installed?.previous) throw new Error('No previous Traefik version is available for rollback.');
      const executable = await this.executableFor(installed.previous);
      await this.verify(executable, installed.previous);
      await this.healthCheck(executable, installed.previous);
      await this.writeConfig();
      await this.writeManifest({ version: 1, current: installed.previous, previous: installed.current });
    });
  }

  async writeConfig(): Promise<void> {
    const { relay, proxy, health } = portsFromEnvironment(this.env);
    const templates = await readTemplates();
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    const configDirectory = path.join(this.paths.traefik, 'config');
    await ensureSafeDirectory(this.paths.root, configDirectory);
    const dynamicPath = path.join(configDirectory, 'dynamic.yml');
    const dynamicConfig = renderTemplate(templates.dynamicConfig, {
      '@@BRC_RELAY_URL@@': quoteYaml(`http://127.0.0.1:${relay}`),
    });
    const staticConfig = renderTemplate(templates.staticConfig, {
      '@@BRC_WEB_ADDRESS@@': quoteYaml(`127.0.0.1:${proxy}`),
      '@@BRC_HEALTH_ADDRESS@@': quoteYaml(`127.0.0.1:${health}`),
      '@@BRC_DYNAMIC_FILE@@': quoteYaml(dynamicPath),
    });
    await writeAtomic(dynamicPath, dynamicConfig);
    await writeAtomic(path.join(configDirectory, 'traefik.yml'), staticConfig);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async prepareDirectories(): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await ensureSafeDirectory(this.paths.root, path.join(this.paths.traefik, 'versions'));
    await ensureSafeDirectory(this.paths.root, this.paths.tmp);
  }

  private async executableFor(version: string): Promise<string> {
    const versionsDirectory = path.join(this.paths.traefik, 'versions');
    const versionDirectory = path.join(versionsDirectory, version);
    await ensureSafeDirectory(this.paths.root, versionDirectory);
    const executable = path.join(versionDirectory, 'traefik.exe');
    await ensureRegularFile(executable);
    return executable;
  }

  private async latestRelease(): Promise<TraefikRelease> {
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

  private async downloadAndStage(release: TraefikRelease): Promise<string> {
    const checksumResponse = await this.fetchImpl(release.checksumUrl, { signal: AbortSignal.timeout(30_000) });
    if (!checksumResponse.ok) throw new Error(`Cannot download the official Traefik checksum file: HTTP ${checksumResponse.status}.`);
    const expectedChecksum = this.readChecksum(await checksumResponse.text(), release.archiveName);
    const archivePath = path.join(this.paths.tmp, `traefik-${randomUUID()}.zip.part`);
    let stage = path.join(this.paths.traefik, 'versions', `.staging-${release.version}-${randomUUID()}`);
    try {
      const archiveResponse = await this.fetchImpl(release.archiveUrl, { signal: AbortSignal.timeout(5 * 60_000) });
      if (!archiveResponse.ok || !archiveResponse.body) throw new Error(`Cannot download the official Traefik ZIP: HTTP ${archiveResponse.status}.`);
      const body = archiveResponse.body as unknown as WebReadableStream<Uint8Array>;
      await pipeline(Readable.fromWeb(body), createWriteStream(archivePath, { flags: 'wx' }));
      const actualChecksum = await sha256File(archivePath);
      if (actualChecksum !== expectedChecksum) throw new Error('Official Traefik ZIP SHA-256 checksum does not match.');
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
    const files = directory.files;
    const names = new Set<string>();
    let executable: ZipEntry | undefined;
    for (const entry of files) {
      if (!safeArchivePath(entry.path)) throw new Error(`Traefik ZIP contains an unsafe path: ${entry.path}`);
      if (names.has(entry.path)) throw new Error(`Traefik ZIP contains a duplicate path: ${entry.path}`);
      names.add(entry.path);
      if (entry.path === 'traefik.exe' && entry.type === 'File') executable = entry;
    }
    if (!executable || executable.vars.uncompressedSize < 1 || executable.vars.uncompressedSize > MAX_EXECUTABLE_BYTES) {
      throw new Error('Traefik ZIP does not contain a valid root-level traefik.exe.');
    }
    const target = path.join(stage, 'traefik.exe');
    await pipeline(executable.stream(), createWriteStream(target, { flags: 'wx' }));
    await ensureRegularFile(target);
    const info = await stat(target);
    if (info.size !== executable.vars.uncompressedSize) throw new Error('Extracted Traefik executable size does not match its ZIP entry.');
  }

  private async commitVersion(stage: string, version: string, previous: string | null): Promise<void> {
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

  private async writeManifest(manifest: VersionManifest): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await writeAtomic(path.join(this.paths.traefik, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

export async function runManagedTraefikService(): Promise<void> {
  const managedLog = installManagedLog();
  let control: ManagedControlServer | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let logFailure: Error | undefined;
  let stopping = false;
  let logSink: Writable | undefined;
  try {
    const traefikRoot = process.env.BRC_TRAEFIK_ROOT;
    const configDirectory = process.env.BRC_TRAEFIK_CONFIG_DIR;
    const logFile = process.env.BRC_LOG_FILE;
    if (process.env.BRC_MANAGED_SERVICE !== 'traefik' || !traefikRoot || !configDirectory || !logFile) {
      throw new Error('Traefik service is missing its managed runtime configuration.');
    }
    const manifest = await readManifest(traefikRoot);
    if (!manifest) throw new Error('Traefik is not installed. Run brc setup first.');
    await ensureSafeDirectory(traefikRoot, path.join(traefikRoot, 'versions', manifest.current));
    await ensureSafeDirectory(traefikRoot, configDirectory);
    const executable = path.join(traefikRoot, 'versions', manifest.current, 'traefik.exe');
    const configFile = path.join(configDirectory, 'traefik.yml');
    await ensureRegularFile(executable);
    await ensureRegularFile(configFile);
    await ensureRegularFile(path.join(configDirectory, 'dynamic.yml'));
    await verifyExecutable(executable, manifest.current);
    const healthPort = parsePort(process.env.BRC_TRAEFIK_HEALTH_PORT, 13002, 'BRC_TRAEFIK_HEALTH_PORT');

    await mkdir(path.dirname(logFile), { recursive: true });
    logSink = new Writable({
      write(chunk, _encoding, callback) {
        void appendRotatingLog(logFile, chunk).then(
          () => callback(),
          (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
        );
      },
    });
    logSink.on('error', (error: Error) => { logFailure = error; });
    child = spawn(executable, [`--configFile=${configFile}`], { cwd: traefikRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const childClosed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child?.once('close', (code, signal) => resolve([code, signal]));
    });
    child.stdout?.pipe(logSink, { end: false });
    child.stderr?.pipe(logSink, { end: false });
    await new Promise<void>((resolve, reject) => {
      child?.once('spawn', () => resolve());
      child?.once('error', reject);
    });
    await waitForHealth(child, healthPort, STARTUP_TIMEOUT_MS, () => logFailure?.message ?? 'Traefik did not answer on its local health endpoint.');

    control = await startManagedControlServer({
      health: async () => {
        if (logFailure) return { state: 'degraded', detail: `Traefik log output failed: ${logFailure.message}` };
        if (!child || child.exitCode !== null || child.signalCode !== null) return { state: 'degraded', detail: 'Traefik process exited.' };
        const status = await requestStatus(healthPort, '/ping');
        return status === 200
          ? { state: 'running', detail: `Traefik ${manifest.current} is healthy.` }
          : { state: 'degraded', detail: `Traefik /ping returned HTTP ${status}.` };
      },
      stop: async () => {
        stopping = true;
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill();
          if (!await waitForChildExit(child, CONTROLLED_STOP_TIMEOUT_MS)) throw new Error('Traefik did not stop after the managed shutdown request.');
        }
      },
    });
    if (!control) throw new Error('Traefik process did not receive a managed-control server.');
    const [exitCode, exitSignal] = await childClosed;
    if (!stopping) {
      process.exitCode = exitCode ?? 1;
      console.error(`Traefik exited unexpectedly${exitSignal ? ` after ${exitSignal}` : ''}.`);
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(`Traefik service failed: ${errorMessage(error)}`);
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForChildExit(child, CONTROLLED_STOP_TIMEOUT_MS);
    }
  } finally {
    await control?.close();
    if (logSink && !logSink.destroyed) {
      logSink.end();
      await finished(logSink).catch(() => undefined);
    }
    await managedLog?.close();
  }
}
