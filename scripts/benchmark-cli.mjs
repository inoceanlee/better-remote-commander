// Run with: node scripts/benchmark-cli.mjs <official-traefik-executable>
// Prerequisites: install workspace dependencies and build all workspace packages first.
// This script uses the local built CLI, never a global installation. It retains its
// temporary directory, including on failure, for inspection and safe manual recovery.
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isolatedEnvironment, isAllowedPort, summarize } from './benchmark-cli-helpers.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'packages', 'cli', 'dist', 'cli.js');
const binary = process.argv[2];
if (process.platform !== 'win32' || !binary || process.argv.length !== 3 || !path.isAbsolute(binary)) {
  throw new Error('Windows only. Supply the absolute path to an official Traefik v3.7+ executable.');
}

async function reservePorts() {
  const servers = [];
  const ports = [];
  try {
    while (ports.length < 3) {
      const server = createServer();
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Failed to allocate loopback port.');
      if (!isAllowedPort(address.port, ports)) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        continue;
      }
      servers.push(server);
      ports.push(address.port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  }
}

function run(executable, args, env) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(executable, args, { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const ms = performance.now() - started;
      if (code !== 0) reject(new Error(`${path.basename(executable)} ${args.join(' ')} failed (code ${code}, signal ${signal}): ${stderr || stdout}`));
      else resolve({ ms, stdout, stderr });
    });
  });
}

const scratch = await mkdtemp(path.join(await realpath(tmpdir()), 'brc-benchmark-'));
const ports = await reservePorts();
const env = isolatedEnvironment(process.env, scratch, ports);
await mkdir(env.TEMP, { recursive: true });
console.log(`Isolated benchmark data: ${scratch}`);
console.log(`Loopback ports: ${ports.join(', ')}`);
const report = { root: scratch, ports, samples: {}, stages: { available: false, reason: 'The CLI does not expose internal stage timings. Command wall times are recorded separately.' } };
try {
  const official = await realpath(binary);
  const versionOutput = await run(official, ['version'], env);
  const version = versionOutput.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  if (!version) throw new Error('Cannot determine Traefik version.');
  const [major, minor] = version.split('.').map(Number);
  if (major < 3 || (major === 3 && minor < 7)) throw new Error('Traefik v3.7 or later is required.');
  report.traefikVersion = version;
  const versionDir = path.join(scratch, 'traefik', 'versions', version);
  await mkdir(versionDir, { recursive: true });
  await copyFile(official, path.join(versionDir, 'traefik.exe'));
  await writeFile(path.join(scratch, 'traefik', 'versions.json'), JSON.stringify({ version: 1, current: version, previous: null }));
  // This fresh root is staged before setup. The marker enables the CLI's supported
  // interrupted-setup recovery path without permitting a replacement identity.
  await mkdir(path.join(scratch, 'data'), { recursive: true });
  await writeFile(path.join(scratch, 'data', 'relay.sqlite.setup-pending'), '', { flag: 'wx' });
  const setupEnv = { ...env, BRC_ADMIN_USER: 'admin', BRC_ADMIN_PASSWORD: randomBytes(24).toString('hex') };
  await run(process.execPath, [cli, 'setup'], setupEnv);
  const samples = { coldStart: [], repeatedStart: [], status: [], help: [], stop: [] };
  for (let i = 0; i < 5; i++) {
    for (const [label, command] of [['coldStart', 'start'], ['repeatedStart', 'start'], ['status', 'status'], ['help', 'help'], ['stop', 'stop']]) {
      const result = await run(process.execPath, [cli, command], env);
      samples[label].push(result.ms);
      report.samples[label] = samples[label];
      await writeFile(path.join(scratch, 'benchmark.json'), JSON.stringify(report, null, 2));
    }
  }
  report.results = Object.fromEntries(Object.entries(samples).map(([label, values]) => [label, summarize(values)]));
  await writeFile(path.join(scratch, 'benchmark.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.results, null, 2));
  console.log(`Results: ${path.join(scratch, 'benchmark.json')}`);
} catch (error) {
  // Do not kill processes or delete files after an uncertain failure. The isolated
  // root and its process records remain available for identity-checked recovery.
  console.error(`Benchmark failed. No automatic stop or deletion was attempted. Inspect ${scratch}.`);
  throw error;
}
