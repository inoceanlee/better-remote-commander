import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

export const RELEASE_CONFIG = Object.freeze({
  packageName: '@inoceanlee/brc',
  tagPrefix: 'brc-v',
  registry: 'https://registry.npmjs.org/',
  artifactDirectory: path.join(workspaceRoot, 'artifacts', 'releases'),
  validationNames: Object.freeze(['unit', 'package', 'e2e', 'dryRun']),
  progressIntervalMs: 120,
  progressHeartbeatMs: 15000,
  registryAttempts: 6,
  registryPollMs: 2000,
  keepValidatedArtifacts: 3,
  stagePrunePatterns: Object.freeze([
    /\.ts\.buildinfo$/i,
    /(^|\/)(?:test|tests|__tests__|example|examples|benchmark|benchmarks)(?:\/|$)/i,
    /\.(?:map|ts|md)$/i,
  ]),
});
