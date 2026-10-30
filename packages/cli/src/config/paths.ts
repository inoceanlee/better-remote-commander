import os from 'node:os';
import path from 'node:path';

export interface BrcPaths {
  root: string;
  traefik: string;
  config: string;
  data: string;
  runtime: string;
  logs: string;
  tmp: string;
}

export function resolveBrcPaths(env: NodeJS.ProcessEnv): BrcPaths {
  const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const root = path.resolve(env.BRC_DATA_ROOT || path.join(localAppData, 'BRC'));
  return {
    root,
    traefik: path.join(root, 'traefik'),
    config: path.join(root, 'config'),
    data: path.join(root, 'data'),
    runtime: path.join(root, 'runtime'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
  };
}
