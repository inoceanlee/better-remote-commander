import { PlatformEnvironment, type BrcPaths, type PlatformTarget } from './platform-environment.js';

export type { BrcPaths, PlatformTarget };
export { PlatformEnvironment };

export function resolveBrcPaths(env: NodeJS.ProcessEnv = process.env): BrcPaths {
  return new PlatformEnvironment({ env }).resolveBrcPaths();
}
