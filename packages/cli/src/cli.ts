#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolveBrcPaths, type BrcPaths } from './config/paths.js';
import { DEFAULT_SETTINGS } from './config/settings.js';
import { LifecycleLock } from './lifecycle/lock.js';
import { createDefaultServices, ServiceManager } from './lifecycle/services.js';
import { cleanRuntime } from './maintenance/cleanup.js';
import { runManagedTraefikService, TraefikManager } from './traefik.js';

export type CliLogComponent = 'relay' | 'agent' | 'traefik';
type CommandResult = number | void;

export interface CliDependencies {
  paths: BrcPaths;
  commands: {
    setup: () => Promise<CommandResult>;
    start: () => Promise<CommandResult>;
    stop: () => Promise<CommandResult>;
    restart: () => Promise<CommandResult>;
    status: () => Promise<CommandResult>;
    logs: (component?: CliLogComponent) => Promise<CommandResult>;
    updateTraefik: () => Promise<CommandResult>;
    uninstall: (clean: () => Promise<void>) => Promise<CommandResult>;
  };
  clean: (paths: BrcPaths) => Promise<void>;
  write: (message: string) => void;
  writeError: (message: string) => void;
}

const HELP_TEXT = [
  'BRC unified CLI',
  '',
  'Usage: brc <command>',
  '',
  'Commands:',
  '  brc or brc help             Show status summary and command help',
  '  brc setup                   Initialize local configuration and Traefik',
  '  brc start                   Start Relay, Traefik, and Agent',
  '  brc stop                    Stop managed services',
  '  brc restart                 Restart managed services',
  '  brc status                  Show managed service status',
  '  brc logs [component]        Show recent logs',
  '  brc update traefik          Update Traefik',
  '  brc clean                   Run safe cleanup',
  '  brc uninstall               Stop services and remove BRC data and package',
  '',
  'pnpm remove -g @inoceanlee/brc removes only the package and keeps BRC data.',
  'Run brc uninstall to remove BRC data and the global package.',
].join('\n');

class UsageError extends Error {
  readonly exitCode = 2;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorExitCode(error: unknown): number {
  if (error && typeof error === 'object' && 'exitCode' in error) {
    const exitCode = error.exitCode;
    if (typeof exitCode === 'number' && Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255) return exitCode;
  }
  return 1;
}

function isLogComponent(value: string): value is CliLogComponent {
  return value === 'relay' || value === 'agent' || value === 'traefik';
}

function requireNoExtraArgs(command: string, args: string[]): void {
  if (args.length !== 1) throw new UsageError(`The ${command} command does not accept extra arguments.`);
}

async function dispatch(args: string[], deps: CliDependencies, clean: () => Promise<void>): Promise<number> {
  const [command, ...commandArgs] = args;
  switch (command) {
    case 'help':
    case '-h':
    case '--help':
      requireNoExtraArgs(command, args);
      deps.write(HELP_TEXT);
      return 0;
    case 'setup':
      requireNoExtraArgs(command, args);
      return (await deps.commands.setup()) ?? 0;
    case 'start':
      requireNoExtraArgs(command, args);
      return (await deps.commands.start()) ?? 0;
    case 'stop':
      requireNoExtraArgs(command, args);
      return (await deps.commands.stop()) ?? 0;
    case 'restart':
      requireNoExtraArgs(command, args);
      return (await deps.commands.restart()) ?? 0;
    case 'status':
      requireNoExtraArgs(command, args);
      return (await deps.commands.status()) ?? 0;
    case 'logs':
      if (commandArgs.length > 1 || (commandArgs[0] && !isLogComponent(commandArgs[0]))) {
        throw new UsageError('logs component must be relay, agent, or traefik.');
      }
      return (await deps.commands.logs(commandArgs[0] as CliLogComponent | undefined)) ?? 0;
    case 'update':
      if (commandArgs.length !== 1 || commandArgs[0] !== 'traefik') {
        throw new UsageError('update accepts only the traefik target.');
      }
      return (await deps.commands.updateTraefik()) ?? 0;
    case 'clean':
      requireNoExtraArgs(command, args);
      await clean();
      return 0;
    case 'uninstall':
      requireNoExtraArgs(command, args);
      return (await deps.commands.uninstall(clean)) ?? 0;
    default:
      throw new UsageError(`Unknown command: ${command ?? ''}. Run brc help for usage.`);
  }
}

export async function runCli(args: string[], deps: CliDependencies): Promise<number> {
  let cleanupStarted = false;
  let exitCode = 0;
  const clean = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await deps.clean(deps.paths);
  };

  try {
    if (args.length === 0) {
      try {
        exitCode = (await deps.commands.status()) ?? 0;
      } catch (error) {
        deps.writeError(`brc: ${errorMessage(error)}`);
        exitCode = errorExitCode(error);
      }
      deps.write(HELP_TEXT);
    } else {
      exitCode = await dispatch(args, deps, clean);
    }
  } catch (error) {
    deps.writeError(`brc: ${errorMessage(error)}`);
    exitCode = errorExitCode(error);
  } finally {
    try {
      await clean();
    } catch (error) {
      deps.writeError(`brc: cleanup failed: ${errorMessage(error)}`);
    }
  }

  return exitCode;
}

const unavailable = async (): Promise<number> => {
  throw new Error('BRC service managers are not initialized.');
};

async function main(): Promise<void> {
  const paths = resolveBrcPaths(process.env);
  const services = createDefaultServices(paths, DEFAULT_SETTINGS);
  const traefikSpec = services.find((service) => service.name === 'traefik');
  if (!traefikSpec) throw new Error('The Traefik service is missing from the default service set.');
  const lifecycleLock = new LifecycleLock(paths);
  const serviceManager = new ServiceManager(paths, services, undefined, lifecycleLock);
  const traefikServiceManager = new ServiceManager(paths, [traefikSpec], undefined, lifecycleLock);
  const traefikManager = new TraefikManager(paths);
  const deps: CliDependencies = {
    paths,
    commands: {
      setup: async () => {
        await traefikManager.setup();
        console.log('BRC setup complete.');
        return 0;
      },
      start: async () => {
        await serviceManager.start();
        console.log('BRC services started.');
        return 0;
      },
      stop: async () => {
        await serviceManager.stop();
        console.log('BRC services stopped.');
        return 0;
      },
      restart: async () => {
        await serviceManager.restart();
        console.log('BRC services restarted.');
        return 0;
      },
      status: async () => {
        const statuses = await serviceManager.status();
        for (const status of statuses) {
          const pid = status.pid === null ? '' : ` PID ${status.pid}`;
          console.log(`${status.name}: ${status.state}${pid} — ${status.detail}`);
        }
        return statuses.some((status) => status.state === 'degraded') ? 1 : 0;
      },
      logs: unavailable,
      updateTraefik: async () => {
        const [status] = await traefikServiceManager.status();
        if (status.state !== 'running' && status.state !== 'stopped') {
          throw new Error(`Cannot update Traefik while it is ${status.state}: ${status.detail}`);
        }
        const wasRunning = status.state === 'running';
        const previous = await traefikManager.currentVersion();
        await traefikManager.update();
        const current = await traefikManager.currentVersion();
        if (wasRunning && current !== previous) {
          try {
            await traefikServiceManager.restart();
          } catch (restartError) {
            try {
              await traefikManager.rollbackUpdate();
              await traefikServiceManager.start();
            } catch (rollbackError) {
              throw new AggregateError([restartError, rollbackError], 'Traefik update failed and rollback could not restore the service.');
            }
            throw new Error(`Traefik update was rolled back because version ${current} did not start.`, { cause: restartError });
          }
        }
        if (!current) throw new Error('Traefik update completed without an installed version.');
        console.log(current === previous ? `Traefik ${current} is current.` : `Traefik updated: ${previous ?? 'not installed'} → ${current}.`);
        return 0;
      },
      uninstall: unavailable,
    },
    clean: async (cleanPaths) => {
      const report = await cleanRuntime(cleanPaths);
      if (report.removed || report.failures.length || report.preserved.length) {
        console.log(`BRC cleanup: removed ${report.removed} items, freed ${report.bytesRemoved} bytes.`);
        for (const failure of report.failures) console.error(`BRC cleanup failed: ${failure.path}: ${failure.reason}`);
        for (const preserved of report.preserved) console.error(`BRC cleanup preserved ${preserved.path}: ${preserved.reason}`);
      }
    },
    write: (message) => console.log(message),
    writeError: (message) => console.error(message),
  };
  process.exitCode = await runCli(process.argv.slice(2), deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.BRC_MANAGED_SERVICE === 'traefik' && process.argv.includes('--run-traefik')) {
    await runManagedTraefikService();
  } else {
    await main();
  }
}
