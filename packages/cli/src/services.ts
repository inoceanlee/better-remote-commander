import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { open, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrcPaths } from './paths.js';
import {
  inspectProcess,
  ProcessManager,
  type ManagedServiceSpec,
  type ProcessIdentity,
  type ServiceStatus,
} from './processes.js';

export interface ProcessController {
  start(spec: ManagedServiceSpec): Promise<void>;
  stop(spec: ManagedServiceSpec): Promise<void>;
  status(spec: ManagedServiceSpec): Promise<ServiceStatus>;
}

function envErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of [
    'BRC_DATA_ROOT', 'BRC_HOME', 'BRC_DB', 'BRC_RELAY', 'BRC_NAME', 'BRC_TOKEN', 'BRC_DEVICE_ID', 'BRC_LOG_FILE',
    'BRC_ADMIN_USER', 'BRC_ADMIN_PASSWORD', 'BRC_SESSION_SECRET', 'PORT', 'HOST', 'PUBLIC_URL', 'TRUST_PROXY',
  ]) delete env[name];
  return env;
}

function relayPort(env: NodeJS.ProcessEnv): number {
  const port = Number(env.BRC_RELAY_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BRC_RELAY_PORT must be an integer from 1 to 65535.');
  return port;
}

export function createDefaultServices(paths: BrcPaths, parentEnv: NodeJS.ProcessEnv = process.env): ManagedServiceSpec[] {
  const cliDist = path.dirname(fileURLToPath(import.meta.url));
  const workspaceRoot = path.resolve(cliDist, '../../..');
  const relayEntry = path.resolve(cliDist, '../../relay/dist/cli.js');
  const agentEntry = path.resolve(cliDist, '../../agent/dist/cli.js');
  const port = relayPort(parentEnv);
  const relayUrl = `http://127.0.0.1:${port}`;
  const baseEnv = childEnvironment(parentEnv);
  const relayEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_URL: relayUrl,
    TRUST_PROXY: 'false',
    BRC_DB: path.join(paths.data, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(paths.logs, 'relay.log'),
    BRC_ADMIN_USER: parentEnv.BRC_ADMIN_USER ?? 'admin',
    ...(parentEnv.BRC_ADMIN_PASSWORD ? { BRC_ADMIN_PASSWORD: parentEnv.BRC_ADMIN_PASSWORD } : {}),
    ...(parentEnv.BRC_SESSION_SECRET ? { BRC_SESSION_SECRET: parentEnv.BRC_SESSION_SECRET } : {}),
  };
  const agentEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    BRC_HOME: paths.config,
    BRC_LOG_FILE: path.join(paths.logs, 'agent.log'),
    BRC_RELAY: relayUrl,
    BRC_NAME: parentEnv.BRC_NAME ?? os.hostname(),
    BRC_DEBUG: parentEnv.BRC_DEBUG,
  };

  return [
    { name: 'relay', entrypoint: relayEntry, workspaceRoot, cwd: workspaceRoot, env: relayEnv },
    { name: 'agent', entrypoint: agentEntry, workspaceRoot, cwd: workspaceRoot, env: agentEnv },
  ];
}

export class ServiceManager {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: BrcPaths,
    private readonly services: ManagedServiceSpec[],
    private readonly processes: ProcessController = new ProcessManager(paths),
  ) {
    const names = new Set<ManagedServiceSpec['name']>();
    for (const service of services) {
      if (names.has(service.name)) throw new Error(`Duplicate managed service: ${service.name}`);
      names.add(service.name);
    }
  }

  start(): Promise<void> {
    return this.exclusive(() => this.startUnlocked());
  }

  stop(): Promise<void> {
    return this.exclusive(() => this.stopUnlocked());
  }

  restart(): Promise<void> {
    return this.exclusive(async () => {
      await this.stopUnlocked();
      await this.startUnlocked();
    });
  }

  status(): Promise<ServiceStatus[]> {
    return Promise.all(this.services.map((service) => this.processes.status(service)));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(() => this.withLifecycleLock(operation));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async withLifecycleLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.paths.runtime, { recursive: true });
    const filename = path.join(this.paths.runtime, 'lifecycle.lock');
    let handle;
    try {
      handle = await open(filename, 'wx', 0o600);
    } catch (error) {
      if (envErrorCode(error) === 'EEXIST') throw new Error('Another BRC lifecycle operation is in progress.');
      throw error;
    }

    try {
      const identity: ProcessIdentity | null = await inspectProcess(process.pid);
      if (!identity) throw new Error('Cannot verify the CLI process identity for lifecycle locking.');
      const workspaceRoot = this.services[0]?.workspaceRoot ?? this.paths.root;
      await handle.writeFile(`${JSON.stringify({ version: 1, ...identity, workspaceRoot, id: randomUUID() })}\n`, 'utf8');
      return await operation();
    } finally {
      await handle.close();
      try {
        await unlink(filename);
      } catch (error) {
        if (envErrorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  private async startUnlocked(): Promise<void> {
    const started: ManagedServiceSpec[] = [];
    try {
      for (const service of this.services) {
        const current = await this.processes.status(service);
        if (current.state === 'running') continue;
        if (current.state !== 'stopped') {
          throw new Error(`Cannot start ${service.name}: ${current.detail}`);
        }
        await this.processes.start(service);
        started.push(service);
        const status = await this.processes.status(service);
        if (status.state !== 'running') throw new Error(`${service.name} did not become healthy: ${status.detail}`);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const service of started.reverse()) {
        try {
          await this.processes.stop(service);
        } catch (failure) {
          rollbackErrors.push(failure);
        }
      }
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'Service startup failed and rollback was incomplete.');
      throw error;
    }
  }

  private async stopUnlocked(): Promise<void> {
    const failures: Error[] = [];
    for (const service of [...this.services].reverse()) {
      try {
        const current = await this.processes.status(service);
        if (current.state !== 'stopped') await this.processes.stop(service);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'One or more managed services could not be stopped safely.');
  }
}
