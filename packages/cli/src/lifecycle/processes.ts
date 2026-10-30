import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrcPaths } from '../config/paths.js';
import { DEFAULT_SETTINGS } from '../config/settings.js';

export type ManagedServiceName = 'relay' | 'traefik' | 'agent';
export type ServiceState = 'stopped' | 'starting' | 'running' | 'degraded';

export interface ServiceStatus {
  name: ManagedServiceName;
  state: ServiceState;
  pid: number | null;
  detail: string;
}

export interface ManagedServiceSpec {
  name: ManagedServiceName;
  entrypoint: string;
  workspaceRoot: string;
  cwd: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export interface ProcessIdentity {
  pid: number;
  createdAt: string;
  executablePath: string;
  commandLine: string;
}

export interface ManagedProcessRecord extends ProcessIdentity {
  version: 1;
  id: string;
  service: ManagedServiceName;
  workspaceRoot: string;
  entrypoint: string;
  controlPort: number;
  controlToken: string;
}

export type ProcessInspector = (pid: number) => ProcessIdentity | null | Promise<ProcessIdentity | null>;

export interface ProcessManagerOptions {
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  pollIntervalMs?: number;
  inspectProcess?: ProcessInspector;
}

interface ReadyInfo {
  id: string;
  service: ManagedServiceName;
  pid: number;
  port: number;
}

interface HealthInfo {
  ok: boolean;
  state: 'running' | 'degraded';
  detail: string;
}

const DEFAULT_POLL_INTERVAL_MS = 100;
const CONTROL_REQUEST_TIMEOUT_MS = 1_000;

function recordPath(paths: BrcPaths, name: ManagedServiceName): string {
  return path.join(paths.runtime, `${name}.json`);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isWithin(root: string, filename: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function normalizeCommandLine(value: string): string {
  const normalized = process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
  return normalized;
}

function isValidSpec(spec: ManagedServiceSpec): void {
  if (!/^[a-z][a-z0-9-]*$/.test(spec.name)) throw new Error(`Invalid managed service name: ${spec.name}`);
  if (!path.isAbsolute(spec.entrypoint) || !path.isAbsolute(spec.workspaceRoot) || !path.isAbsolute(spec.cwd)) {
    throw new Error(`${spec.name} service paths must be absolute.`);
  }
  if (!isWithin(spec.workspaceRoot, spec.entrypoint) || (!samePath(spec.workspaceRoot, spec.cwd) && !isWithin(spec.workspaceRoot, spec.cwd))) {
    throw new Error(`${spec.name} entrypoint and working directory must belong to its workspace.`);
  }
}

function sameIdentity(record: ManagedProcessRecord, current: ProcessIdentity, spec: ManagedServiceSpec): boolean {
  const commandLine = normalizeCommandLine(current.commandLine);
  const expectedEntry = normalizeCommandLine(path.resolve(spec.entrypoint));
  const managedId = `--brc-managed-id=${record.id}`;
  const normalizedId = process.platform === 'win32' ? managedId.toLowerCase() : managedId;
  return current.pid === record.pid
    && current.createdAt === record.createdAt
    && samePath(current.executablePath, record.executablePath)
    && samePath(current.executablePath, process.execPath)
    && samePath(record.workspaceRoot, spec.workspaceRoot)
    && samePath(record.entrypoint, spec.entrypoint)
    && isWithin(record.workspaceRoot, record.entrypoint)
    && commandLine.includes(expectedEntry)
    && commandLine.includes(normalizedId);
}

function parseProcessRecord(value: unknown, spec: ManagedServiceSpec): ManagedProcessRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${spec.name} process record is malformed; refusing process control.`);
  }
  if (!('version' in value) || !('service' in value) || !('id' in value) || !('pid' in value)
      || !('createdAt' in value) || !('executablePath' in value) || !('commandLine' in value)
      || !('workspaceRoot' in value) || !('entrypoint' in value) || !('controlPort' in value)
      || !('controlToken' in value)) {
    throw new Error(`${spec.name} process record is incomplete; refusing process control.`);
  }
  if (value.version !== 1 || (value.service !== 'relay' && value.service !== 'traefik' && value.service !== 'agent')
      || value.service !== spec.name || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !value.createdAt
      || typeof value.executablePath !== 'string' || !path.isAbsolute(value.executablePath)
      || typeof value.commandLine !== 'string'
      || typeof value.workspaceRoot !== 'string' || !path.isAbsolute(value.workspaceRoot)
      || typeof value.entrypoint !== 'string' || !path.isAbsolute(value.entrypoint)
      || typeof value.controlPort !== 'number' || !Number.isInteger(value.controlPort) || value.controlPort < 1 || value.controlPort > 65535
      || typeof value.controlToken !== 'string' || !/^[0-9a-f]{64}$/i.test(value.controlToken)) {
    throw new Error(`${spec.name} process record is malformed; refusing process control.`);
  }
  return {
    version: 1,
    id: value.id,
    service: value.service,
    pid: value.pid,
    createdAt: value.createdAt,
    executablePath: value.executablePath,
    commandLine: value.commandLine,
    workspaceRoot: value.workspaceRoot,
    entrypoint: value.entrypoint,
    controlPort: value.controlPort,
    controlToken: value.controlToken,
  };
}

function parseReady(value: unknown, spec: ManagedServiceSpec, id: string, pid: number): ReadyInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('id' in value) || !('service' in value) || !('pid' in value) || !('port' in value)) return null;
  if (typeof value.id !== 'string' || value.id !== id
      || (value.service !== 'relay' && value.service !== 'traefik' && value.service !== 'agent')
      || value.service !== spec.name || value.pid !== pid
      || typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  return { id: value.id, service: value.service, pid: value.pid, port: value.port };
}

function processErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function exitStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') return error.status;
  return undefined;
}

function parseProcessIdentity(value: unknown): ProcessIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!('pid' in value) || !('createdAt' in value) || !('executablePath' in value) || !('commandLine' in value)) return null;
  if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || typeof value.executablePath !== 'string'
      || typeof value.commandLine !== 'string') return null;
  return { pid: value.pid, createdAt: value.createdAt, executablePath: value.executablePath, commandLine: value.commandLine };
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process ID: ${pid}`);

  if (process.platform === 'win32') {
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = `Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='createdAt';Expression={$_.CreationDate.ToUniversalTime().ToString('o')}},@{Name='executablePath';Expression={$_.ExecutablePath}},@{Name='commandLine';Expression={$_.CommandLine}} | ConvertTo-Json -Compress`;
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    }).trim();
    if (!output) return null;
    const identity = parseProcessIdentity(JSON.parse(output));
    if (!identity) throw new Error(`Windows returned incomplete identity for process ${pid}.`);
    return identity;
  }

  if (process.platform === 'linux') {
    let stat: string;
    let executablePath: string;
    let rawCommand: Buffer;
    try {
      [stat, executablePath, rawCommand] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        realpath(`/proc/${pid}/exe`),
        readFile(`/proc/${pid}/cmdline`),
      ]);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) throw new Error(`Linux returned malformed process identity for ${pid}.`);
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) throw new Error(`Linux returned incomplete start time for process ${pid}.`);
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const commandLine = rawCommand.toString('utf8').split('\0').filter(Boolean).join(' ');
    if (!commandLine) return null;
    return { pid, createdAt: `${bootId}:${startTicks}`, executablePath, commandLine };
  }

  if (process.platform === 'darwin') {
    try {
      const createdAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', windowsHide: true }).trim();
      const executablePath = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true }).trim();
      const commandLine = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', windowsHide: true }).trim();
      if (!createdAt || !executablePath || !commandLine) return null;
      return { pid, createdAt, executablePath, commandLine };
    } catch (error) {
      if (exitStatus(error) === 1) return null;
      throw error;
    }
  }

  throw new Error(`Managed process inspection is unsupported on ${process.platform}.`);
}

export class ProcessManager {
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly inspect: ProcessInspector;
  private readonly starting = new Map<ManagedServiceName, number | null>();

  constructor(private readonly paths: BrcPaths, options: ProcessManagerOptions = {}) {
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SETTINGS.runtime.startupTimeoutMs;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SETTINGS.runtime.shutdownTimeoutMs;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.inspect = options.inspectProcess ?? inspectProcess;
  }

  async start(spec: ManagedServiceSpec): Promise<void> {
    isValidSpec(spec);
    if (this.starting.has(spec.name)) throw new Error(`${spec.name} is already starting.`);
    this.starting.set(spec.name, null);
    let child: ChildProcess | undefined;
    let record: ManagedProcessRecord | undefined;
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const readyFile = path.join(this.paths.runtime, `${spec.name}.${id}.ready.json`);

    try {
      await mkdir(this.paths.runtime, { recursive: true });
      const current = await this.readRecord(spec);
      if (current) {
        const identity = await this.inspect(current.pid);
        if (!identity) await this.removeRecord(spec.name);
        else if (!sameIdentity(current, identity, spec)) throw new Error(`${spec.name} process identity does not match its saved record; refusing to start or stop it.`);
        else {
          const health = await this.readHealth(current);
          if (health.state === 'running' && health.ok) return;
          throw new Error(`${spec.name} is already managed but unhealthy: ${health.detail}`);
        }
      }

      const environment = {
        ...process.env,
        ...spec.env,
        BRC_CONTROL_TOKEN: token,
        BRC_CONTROL_READY_FILE: readyFile,
        BRC_MANAGED_ID: id,
        BRC_MANAGED_SERVICE: spec.name,
      };
      child = spawn(process.execPath, [spec.entrypoint, ...(spec.args ?? []), `--brc-managed-id=${id}`], {
        cwd: spec.cwd,
        env: environment,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
      child.on('exit', (code, signal) => { exit = { code, signal }; });
      await once(child, 'spawn');
      if (!child.pid) throw new Error(`${spec.name} process did not receive a PID.`);
      child.unref();
      this.starting.set(spec.name, child.pid);

      const ready = await this.waitForReady(child, spec, readyFile, id, () => exit);
      const identity = await this.inspect(child.pid);
      if (!identity || !this.isCandidateIdentity(identity, spec, id)) {
        throw new Error(`${spec.name} process identity could not be verified after startup.`);
      }
      record = {
        version: 1,
        id,
        service: spec.name,
        pid: identity.pid,
        createdAt: identity.createdAt,
        executablePath: identity.executablePath,
        commandLine: identity.commandLine,
        workspaceRoot: path.resolve(spec.workspaceRoot),
        entrypoint: path.resolve(spec.entrypoint),
        controlPort: ready.port,
        controlToken: token,
      };
      await this.writeRecord(record);
      await this.waitForHealthy(record, spec);
    } catch (error) {
      let cleanupError: unknown;
      try {
        if (record) await this.stopRecord(spec, record, true);
        else if (child?.pid) await this.stopUnrecorded(spec, child.pid, id, token, readyFile);
      } catch (failure) {
        cleanupError = failure;
      }
      if (cleanupError) throw new AggregateError([error, cleanupError], `${spec.name} failed to start and could not be safely rolled back.`);
      throw error;
    } finally {
      this.starting.delete(spec.name);
      await this.removeReadyFile(readyFile);
    }
  }

  async stop(spec: ManagedServiceSpec): Promise<void> {
    isValidSpec(spec);
    const record = await this.readRecord(spec);
    if (!record) return;
    await this.stopRecord(spec, record, true);
  }

  async status(spec: ManagedServiceSpec): Promise<ServiceStatus> {
    if (this.starting.has(spec.name)) {
      return { name: spec.name, state: 'starting', pid: this.starting.get(spec.name) ?? null, detail: 'Service startup is in progress.' };
    }
    let record: ManagedProcessRecord | null;
    try {
      record = await this.readRecord(spec);
    } catch (error) {
      return { name: spec.name, state: 'degraded', pid: null, detail: processErrorMessage(error) };
    }
    if (!record) return { name: spec.name, state: 'stopped', pid: null, detail: 'No managed process record.' };

    let identity: ProcessIdentity | null;
    try {
      identity = await this.inspect(record.pid);
    } catch (error) {
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: `Cannot verify process identity: ${processErrorMessage(error)}` };
    }
    if (!identity) return { name: spec.name, state: 'stopped', pid: null, detail: 'Recorded process has exited.' };
    if (!sameIdentity(record, identity, spec)) {
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: 'Process identity changed; refusing process control.' };
    }

    try {
      const health = await this.readHealth(record);
      return {
        name: spec.name,
        state: health.ok && health.state === 'running' ? 'running' : 'degraded',
        pid: record.pid,
        detail: health.detail,
      };
    } catch (error) {
      return { name: spec.name, state: 'degraded', pid: record.pid, detail: `Health check failed: ${processErrorMessage(error)}` };
    }
  }

  private async waitForReady(
    child: ChildProcess,
    spec: ManagedServiceSpec,
    readyFile: string,
    id: string,
    getExit: () => { code: number | null; signal: NodeJS.Signals | null } | null,
  ): Promise<ReadyInfo> {
    const deadline = Date.now() + (spec.startupTimeoutMs ?? this.startupTimeoutMs);
    while (Date.now() < deadline) {
      const exit = getExit();
      if (exit) throw new Error(`${spec.name} exited before readiness (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'}).`);
      if (!child.pid) throw new Error(`${spec.name} did not receive a PID.`);
      try {
        const value = JSON.parse(await readFile(readyFile, 'utf8')) as unknown;
        const ready = parseReady(value, spec, id, child.pid);
        if (ready) return ready;
      } catch (error) {
        if (errorCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`${spec.name} did not publish a ready control endpoint before timeout.`);
  }

  private async waitForHealthy(record: ManagedProcessRecord, spec: ManagedServiceSpec): Promise<void> {
    const deadline = Date.now() + (spec.startupTimeoutMs ?? this.startupTimeoutMs);
    let detail = 'Health endpoint did not report ready.';
    while (Date.now() < deadline) {
      const identity = await this.inspect(record.pid);
      if (!identity) throw new Error(`${spec.name} exited during startup.`);
      if (!sameIdentity(record, identity, spec)) throw new Error(`${spec.name} process identity changed during startup.`);
      try {
        const health = await this.readHealth(record);
        detail = health.detail;
        if (health.ok && health.state === 'running') return;
      } catch (error) {
        detail = processErrorMessage(error);
      }
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`${spec.name} did not become healthy: ${detail}`);
  }

  private async readHealth(record: ManagedProcessRecord): Promise<HealthInfo> {
    if (record.controlPort < 1) throw new Error('Missing managed control port.');
    const response = await fetch(`http://127.0.0.1:${record.controlPort}/health`, {
      headers: { authorization: `Bearer ${record.controlToken}` },
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
    });
    const health = await response.json() as Partial<HealthInfo>;
    return {
      ok: response.ok && health.ok === true,
      state: health.state === 'running' ? 'running' : 'degraded',
      detail: typeof health.detail === 'string' ? health.detail : `Control endpoint returned HTTP ${response.status}.`,
    };
  }

  private async stopRecord(spec: ManagedServiceSpec, record: ManagedProcessRecord, removeRecord: boolean): Promise<void> {
    const current = await this.inspect(record.pid);
    if (!current) {
      if (removeRecord) await this.removeRecord(spec.name);
      return;
    }
    if (!sameIdentity(record, current, spec)) throw new Error(`${spec.name} process identity changed; refusing to stop PID ${record.pid}.`);

    if (record.controlPort > 0) {
      try {
        await fetch(`http://127.0.0.1:${record.controlPort}/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${record.controlToken}` },
          signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        });
      } catch { /* Verify identity again before any forced stop. */ }
    }

    if (!await this.waitForExit(record, spec, this.shutdownTimeoutMs)) {
      const latest = await this.inspect(record.pid);
      if (!latest) {
        if (removeRecord) await this.removeRecord(spec.name);
        return;
      }
      if (!sameIdentity(record, latest, spec)) throw new Error(`${spec.name} process identity changed before forced stop; refusing PID ${record.pid}.`);
      try {
        if (process.platform === 'win32') process.kill(record.pid);
        else process.kill(record.pid, 'SIGKILL');
      } catch (error) {
        if (errorCode(error) !== 'ESRCH') throw error;
      }
      if (!await this.waitForExit(record, spec, this.shutdownTimeoutMs)) {
        throw new Error(`${spec.name} process ${record.pid} remained after a targeted forced stop.`);
      }
    }

    if (removeRecord) await this.removeRecord(spec.name);
  }

  private async waitForExit(record: ManagedProcessRecord, spec: ManagedServiceSpec, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = await this.inspect(record.pid);
      if (!current) return true;
      if (!sameIdentity(record, current, spec)) throw new Error(`${spec.name} PID ${record.pid} no longer matches its recorded identity.`);
      await sleep(this.pollIntervalMs);
    }
    return false;
  }

  private async stopUnrecorded(
    spec: ManagedServiceSpec,
    pid: number,
    id: string,
    token: string,
    readyFile: string,
  ): Promise<void> {
    const identity = await this.inspect(pid);
    if (!identity) return;
    if (!this.isCandidateIdentity(identity, spec, id)) {
      throw new Error(`${spec.name} startup process identity could not be verified; refusing to stop PID ${pid}.`);
    }
    let ready: ReadyInfo | null = null;
    try {
      ready = parseReady(JSON.parse(await readFile(readyFile, 'utf8')) as unknown, spec, id, pid);
    } catch { /* The service may have failed before publishing its control endpoint. */ }
    const record: ManagedProcessRecord = {
      version: 1,
      id,
      service: spec.name,
      pid: identity.pid,
      createdAt: identity.createdAt,
      executablePath: identity.executablePath,
      commandLine: identity.commandLine,
      workspaceRoot: path.resolve(spec.workspaceRoot),
      entrypoint: path.resolve(spec.entrypoint),
      controlPort: ready?.port ?? 0,
      controlToken: token,
    };
    await this.stopRecord(spec, record, false);
  }

  private isCandidateIdentity(identity: ProcessIdentity, spec: ManagedServiceSpec, id: string): boolean {
    const commandLine = normalizeCommandLine(identity.commandLine);
    const entrypoint = normalizeCommandLine(path.resolve(spec.entrypoint));
    const managedId = `--brc-managed-id=${id}`;
    const normalizedId = process.platform === 'win32' ? managedId.toLowerCase() : managedId;
    return samePath(identity.executablePath, process.execPath)
      && isWithin(spec.workspaceRoot, spec.entrypoint)
      && commandLine.includes(entrypoint)
      && commandLine.includes(normalizedId);
  }

  private async readRecord(spec: ManagedServiceSpec): Promise<ManagedProcessRecord | null> {
    try {
      const record = parseProcessRecord(JSON.parse(await readFile(recordPath(this.paths, spec.name), 'utf8')), spec);
      if (!samePath(record.workspaceRoot, spec.workspaceRoot) || !samePath(record.entrypoint, spec.entrypoint)) {
        throw new Error(`${spec.name} process record belongs to another workspace; refusing process control.`);
      }
      return record;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  private async writeRecord(record: ManagedProcessRecord): Promise<void> {
    const filename = recordPath(this.paths, record.service);
    const temporaryFile = `${filename}.${record.id}.tmp`;
    await writeFile(temporaryFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporaryFile, filename);
  }

  private async removeRecord(name: ManagedServiceName): Promise<void> {
    try {
      await unlink(recordPath(this.paths, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  private async removeReadyFile(filename: string): Promise<void> {
    try {
      await unlink(filename);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}
