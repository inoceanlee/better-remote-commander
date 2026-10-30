import type { BrcPaths } from '../config/paths.js';
import { showLogs, type LogComponent } from '../maintenance/logs.js';
import { confirmBrcUninstall, removeGlobalBrcPackage, uninstallBrc } from '../maintenance/uninstall.js';

export function createMaintenanceCommands(
  paths: BrcPaths,
  write: (message: string) => void,
  writeError: (message: string) => void,
  dependencies: { stopServices: () => Promise<void> },
) {
  return {
    logs: (component?: LogComponent) => showLogs(paths, component, write, writeError),
    uninstall: ({ yes }: { yes: boolean }, clean: () => Promise<void>) => uninstallBrc({
      yes,
      paths,
      confirm: confirmBrcUninstall,
      stopServices: dependencies.stopServices,
      clean,
      removePackage: removeGlobalBrcPackage,
      write,
    }),
  };
}
