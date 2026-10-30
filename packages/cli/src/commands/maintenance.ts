import type { BrcPaths } from '../config/paths.js';
import { showLogs, type LogComponent } from '../maintenance/logs.js';

export function createMaintenanceCommands(
  paths: BrcPaths,
  write: (message: string) => void,
  writeError: (message: string) => void,
) {
  return {
    logs: (component?: LogComponent) => showLogs(paths, component, write, writeError),
  };
}
