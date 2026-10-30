import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrcPaths } from '../config/paths.js';
import type { BrcSettings } from '../config/settings.js';
import { LifecycleLock } from './lock.js';
import {
  ProcessManager,
  type ManagedServiceSpec,
  type ServiceStatus,
} from './processes.js';

export interface ProcessController {
  start(spec: ManagedServiceSpec): Promise<void>;
  stop(spec: ManagedServiceSpec): Promise<void>;
  status(spec: ManagedServiceSpec): Promise<ServiceStatus>;
}
function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parent };
  for (const name of [
    'BRC_DATA_ROOT', 'BRC_HOME', 'BRC_DB', 'BRC_RELAY', 'BRC_NAME', 'BRC_TOKEN', 'BRC_DEVICE_ID', 'BRC_LOG_FILE',
    'BRC_TRAEFIK_ROOT', 'BRC_TRAEFIK_CONFIG_DIR', 'BRC_TRAEFIK_PORT', 'BRC_TRAEFIK_HEALTH_PORT', 'BRC_RELAY_PORT',
    'BRC_ADMIN_USER', 'BRC_ADMIN_PASSWORD', 'BRC_SESSION_SECRET', 'PORT', 'HOST', 'PUBLIC_URL', 'TRUST_PROXY',
  ]) delete env[name];
  return env;
}


export function createDefaultServices(
  paths: BrcPaths,
  settings: Readonly<BrcSettings>,
  parentEnv: NodeJS.ProcessEnv = process.env,
): ManagedServiceSpec[] {
  const cliDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packedRelayEntry = path.resolve(cliDist, 'services/relay/cli.js');
  const packedAgentEntry = path.resolve(cliDist, 'services/agent/cli.js');
  const isStandalonePackage = existsSync(packedRelayEntry) && existsSync(packedAgentEntry);
  const workspaceRoot = isStandalonePackage ? path.resolve(cliDist, '..') : path.resolve(cliDist, '../../..');
  const cliEntry = path.resolve(cliDist, 'cli.js');
  const relayEntry = isStandalonePackage ? packedRelayEntry : path.resolve(cliDist, '../../relay/dist/cli.js');
  const agentEntry = isStandalonePackage ? packedAgentEntry : path.resolve(cliDist, '../../agent/dist/cli.js');
  const { relayPort: relay, proxyPort: proxy, healthPort: health } = settings.services;
  const proxyUrl = `http://127.0.0.1:${proxy}`;
  const baseEnv = childEnvironment(parentEnv);
  const relayEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOST: '127.0.0.1',
    PORT: String(relay),
    PUBLIC_URL: parentEnv.PUBLIC_URL || proxyUrl,
    TRUST_PROXY: 'false',
    BRC_DB: path.join(paths.data, 'relay.sqlite'),
    BRC_LOG_FILE: path.join(paths.logs, 'relay.log'),
    BRC_ADMIN_USER: parentEnv.BRC_ADMIN_USER ?? 'admin',
    ...(parentEnv.BRC_ADMIN_PASSWORD ? { BRC_ADMIN_PASSWORD: parentEnv.BRC_ADMIN_PASSWORD } : {}),
    ...(parentEnv.BRC_SESSION_SECRET ? { BRC_SESSION_SECRET: parentEnv.BRC_SESSION_SECRET } : {}),
  };
  const traefikEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    BRC_TRAEFIK_ROOT: paths.traefik,
    BRC_TRAEFIK_CONFIG_DIR: path.join(paths.traefik, 'config'),
    BRC_TRAEFIK_PORT: String(proxy),
    BRC_TRAEFIK_HEALTH_PORT: String(health),
    BRC_RELAY_PORT: String(relay),
    BRC_LOG_FILE: path.join(paths.logs, 'traefik.log'),
  };
  const agentEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    BRC_HOME: paths.config,
    BRC_LOG_FILE: path.join(paths.logs, 'agent.log'),
    BRC_RELAY: proxyUrl,
    BRC_NAME: parentEnv.BRC_NAME ?? os.hostname(),
    BRC_DEBUG: parentEnv.BRC_DEBUG,
  };

  return [
    { name: 'relay', entrypoint: relayEntry, workspaceRoot, cwd: workspaceRoot, env: relayEnv },
    { name: 'traefik', entrypoint: cliEntry, args: ['--run-traefik'], workspaceRoot, cwd: workspaceRoot, env: traefikEnv },
    { name: 'agent', entrypoint: agentEntry, workspaceRoot, cwd: workspaceRoot, env: agentEnv },
  ];
}

export interface LockedServiceOperations {
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export class ServiceManager {
  private readonly lockedOperations: LockedServiceOperations = {
    start: () => this.startUnlocked(),
    stop: () => this.stopUnlocked(),
    restart: async () => {
      await this.stopUnlocked();
      await this.startUnlocked();
    },
  };

  constructor(
    paths: BrcPaths,
    private readonly services: ManagedServiceSpec[],
    private readonly processes: ProcessController = new ProcessManager(paths),
    private readonly lifecycleLock: LifecycleLock = new LifecycleLock(paths),
  ) {
    const names = new Set<ManagedServiceSpec['name']>();
    for (const service of services) {
      if (names.has(service.name)) throw new Error(`Duplicate managed service: ${service.name}`);
      names.add(service.name);
    }
  }

  start(): Promise<void> {
    return this.withLock((services) => services.start());
  }

  stop(): Promise<void> {
    return this.withLock((services) => services.stop());
  }

  restart(): Promise<void> {
    return this.withLock((services) => services.restart());
  }

  withLock<T>(operation: (services: LockedServiceOperations) => Promise<T>): Promise<T> {
    return this.lifecycleLock.runExclusive(() => operation(this.lockedOperations));
  }

  status(): Promise<ServiceStatus[]> {
    return Promise.all(this.services.map((service) => this.processes.status(service)));
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
