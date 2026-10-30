import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { copyFile, link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net, { createConnection } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { ProcessManager } from '../packages/cli/dist/lifecycle/processes.js';
import { createDefaultServices, ServiceManager } from '../packages/cli/dist/lifecycle/services.js';
import { TraefikManager } from '../packages/cli/dist/traefik.js';

const API_URL = 'https://api.github.com/repos/traefik/traefik/releases/latest';
const TEST_BINARY = process.env.BRC_TRAEFIK_TEST_BINARY;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function paths(root) {
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

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'brc-traefik-'));
  const brcPaths = paths(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, paths: brcPaths };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.from(entry.contents);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function makeRelease(version, options = {}) {
  const filename = `traefik_v${version}_windows_amd64.zip`;
  const checksumFilename = `traefik_v${version}_checksums.txt`;
  const archive = options.archive ?? makeZip([{ name: 'traefik.exe', contents: Buffer.from(`binary-${version}`) }]);
  const digest = options.checksum ?? createHash('sha256').update(archive).digest('hex');
  const release = {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: checksumFilename, browser_download_url: `https://github.com/traefik/traefik/releases/download/v${version}/${checksumFilename}` },
      { name: filename, browser_download_url: `https://github.com/traefik/traefik/releases/download/v${version}/${filename}` },
    ],
  };
  const state = { release, archive, checksumText: `${digest}  ${filename}\n`, interrupted: false, requests: [] };
  state.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    state.requests.push(url.href);
    if (url.href === API_URL) {
      return new Response(JSON.stringify(state.release), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname.endsWith(checksumFilename)) return new Response(state.checksumText, { status: 200 });
    if (url.pathname.endsWith(filename)) {
      if (state.interrupted) {
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(state.archive.subarray(0, Math.max(1, Math.floor(state.archive.length / 2))));
            controller.error(new Error('synthetic interrupted download'));
          },
        }), { status: 200 });
      }
      return new Response(state.archive, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
  state.setVersion = (nextVersion, nextOptions = {}) => {
    const next = makeRelease(nextVersion, nextOptions);
    state.release = next.release;
    state.archive = next.archive;
    state.checksumText = next.checksumText;
    state.interrupted = false;
  };
  return state;
}

function makeManager(paths, release, options = {}) {
  return new TraefikManager(paths, {
    releaseApiUrl: API_URL,
    fetch: release.fetch,
    env: { BRC_RELAY_PORT: '13000', BRC_TRAEFIK_PORT: '13001', BRC_TRAEFIK_HEALTH_PORT: '13002' },
    verifyExecutable: async (filename, expectedVersion) => {
      assert.equal(await readFile(filename, 'utf8'), `binary-${expectedVersion}`);
    },
    healthCheck: async () => {},
    ...options,
  });
}

async function manifest(paths) {
  return JSON.parse(await readFile(path.join(paths.traefik, 'versions.json'), 'utf8'));
}

async function installedExecutable(paths, version) {
  return readFile(path.join(paths.traefik, 'versions', version, 'traefik.exe'), 'utf8');
}

test('setup installs verified stable release once and retains its executable', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);

  await manager.setup();
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  const downloadCount = release.requests.filter((url) => url.endsWith('windows_amd64.zip')).length;

  release.setVersion('3.7.17');
  await manager.setup();
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(release.requests.filter((url) => url.endsWith('windows_amd64.zip')).length, downloadCount);
});

test('an interrupted update leaves the current executable and version metadata unchanged', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();

  release.setVersion('3.7.17');
  release.interrupted = true;
  await assert.rejects(manager.update());
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.17', 'traefik.exe')));
});

test('a checksum mismatch cannot replace an installed release', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);
  await manager.setup();

  release.setVersion('3.7.17', { checksum: '0'.repeat(64) });
  await assert.rejects(manager.update(), /checksum/i);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
});

test('a ZIP entry that escapes staging is rejected before it can write outside the version directory', async (t) => {
  const { root, paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16', {
    archive: makeZip([
      { name: 'traefik.exe', contents: Buffer.from('binary-3.7.16') },
      { name: '../../outside.exe', contents: Buffer.from('escape') },
    ]),
  });
  const manager = makeManager(brcPaths, release);

  await assert.rejects(manager.setup(), /zip|archive|path|entry/i);
  await assert.rejects(stat(path.join(root, 'outside.exe')));
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.16', 'traefik.exe')));
});

test('a candidate that fails health validation leaves the old release available for rollback', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  let rejectNewRelease = false;
  const manager = makeManager(brcPaths, release, {
    healthCheck: async (_filename, candidateVersion) => {
      if (rejectNewRelease && candidateVersion === '3.7.17') throw new Error('candidate health check failed');
    },
  });
  await manager.setup();

  release.setVersion('3.7.17');
  rejectNewRelease = true;
  await assert.rejects(manager.update(), /health check failed/i);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(await installedExecutable(brcPaths, '3.7.16'), 'binary-3.7.16');
  await assert.rejects(stat(path.join(brcPaths.traefik, 'versions', '3.7.17')));
});

test('concurrent setup calls share one validated installation', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const release = makeRelease('3.7.16');
  const manager = makeManager(brcPaths, release);

  await Promise.all([manager.setup(), manager.setup(), manager.setup()]);
  assert.deepEqual(await manifest(brcPaths), { version: 1, current: '3.7.16', previous: null });
  assert.equal(release.requests.filter((url) => url === API_URL).length, 1);
  assert.equal(release.requests.filter((url) => url.endsWith('windows_amd64.zip')).length, 1);
});

test('service order keeps Relay behind Traefik and routes Agent traffic through the proxy', async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const env = {
    BRC_RELAY_PORT: '13000',
    BRC_TRAEFIK_PORT: '13001',
    BRC_TRAEFIK_HEALTH_PORT: '13002',
    PUBLIC_URL: 'https://brc.example.test',
  };
  const services = createDefaultServices(brcPaths, env);

  assert.deepEqual(services.map((service) => service.name), ['relay', 'traefik', 'agent']);
  assert.equal(services[0].env.PORT, '13000');
  assert.equal(services[0].env.PUBLIC_URL, 'https://brc.example.test');
  assert.equal(services[1].env.BRC_TRAEFIK_ROOT, brcPaths.traefik);
  assert.equal(services[1].env.BRC_TRAEFIK_PORT, '13001');
  assert.deepEqual(services[1].args, ['--run-traefik']);
  assert.equal(services[2].env.BRC_RELAY, 'http://127.0.0.1:13001');
});

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

async function reservePorts(count) {
  const servers = Array.from({ length: count }, () => createServer());
  const ports = await Promise.all(servers.map((server) => listen(server)));
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  return ports;
}

function httpStatus(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: pathname,
      localAddress: options.localAddress,
      headers: options.headers,
      agent: false,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject);
    req.end();
  });
}

async function websocketStatus(port, pathname = '/ws', headers = {}) {
  const socket = createConnection({ host: '127.0.0.1', port });
  const key = randomBytes(16).toString('base64');
  const status = await new Promise((resolve, reject) => {
    let response = '';
    const timeout = setTimeout(() => reject(new Error('WebSocket handshake timed out.')), 5000);
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.on('data', (chunk) => {
      response += chunk.toString('latin1');
      if (!response.includes('\r\n\r\n')) return;
      clearTimeout(timeout);
      resolve(Number(response.match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0));
    });
    socket.write([
      `GET ${pathname} HTTP/1.1`,
      'Host: test.invalid',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      '',
    ].join('\r\n'));
  });
  if (status !== 101) socket.destroy();
  return { status, socket };
}

const realTraefikSkip = TEST_BINARY ? false : 'Set BRC_TRAEFIK_TEST_BINARY to an official Traefik v3.7+ executable.';
test('official Traefik routes all paths and shares global rate and in-flight limits', { skip: realTraefikSkip }, async (t) => {
  const { paths: brcPaths } = await makeRoot(t);
  const versionResult = spawnSync(TEST_BINARY, ['version'], { encoding: 'utf8', windowsHide: true });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const version = versionResult.stdout.match(/Version:\s*v?(\d+\.\d+\.\d+)/)?.[1];
  assert.ok(version, versionResult.stdout);
  const versionDir = path.join(brcPaths.traefik, 'versions', version);
  await mkdir(versionDir, { recursive: true });
  const binaryPath = path.join(versionDir, 'traefik.exe');
  try {
    await link(TEST_BINARY, binaryPath);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EXDEV'].includes(error.code)) throw error;
    await copyFile(TEST_BINARY, binaryPath);
  }
  await writeFile(path.join(brcPaths.traefik, 'versions.json'), `${JSON.stringify({ version: 1, current: version, previous: null })}\n`);

  const events = [];
  let active = 0;
  let peak = 0;
  let webSockets = 0;
  const backend = createServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    events.push({ path: req.url, host: req.headers.host, key: req.headers['x-brc-limit-key'], xff: req.headers['x-forwarded-for'] });
    res.once('close', () => { active--; });
    const delay = Number(new URL(req.url, 'http://localhost').searchParams.get('hold') ?? 0);
    setTimeout(() => { if (!res.destroyed) res.writeHead(204).end(); }, delay);
  });
  backend.on('upgrade', (req, socket) => {
    active++;
    webSockets++;
    peak = Math.max(peak, active);
    events.push({ path: req.url, host: req.headers.host, key: req.headers['x-brc-limit-key'], xff: req.headers['x-forwarded-for'] });
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const release = () => { active--; webSockets--; };
    socket.once('close', release);
    socket.on('data', (data) => {
      if ((data[0] & 0x0f) === 0x8) socket.end(Buffer.from([0x88, 0]));
    });
  });
  const relayPort = await listen(backend);
  const [proxyPort, healthPort] = await reservePorts(2);
  const env = {
    BRC_RELAY_PORT: String(relayPort),
    BRC_TRAEFIK_PORT: String(proxyPort),
    BRC_TRAEFIK_HEALTH_PORT: String(healthPort),
  };
  const manager = new TraefikManager(brcPaths, { env });
  await manager.writeConfig();

  const dynamicFile = path.join(brcPaths.traefik, 'config', 'dynamic.yml');
  const rateOnly = (await readFile(dynamicFile, 'utf8')).replace('amount: 16', 'amount: 100');
  await writeFile(dynamicFile, rateOnly);
  const services = createDefaultServices(brcPaths, env);
  const traefikSpec = services.find((service) => service.name === 'traefik');
  assert.ok(traefikSpec);
  const processManager = new ProcessManager(brcPaths, { startupTimeoutMs: 20_000, shutdownTimeoutMs: 3_000, pollIntervalMs: 50 });
  const serviceManager = new ServiceManager(brcPaths, [traefikSpec], processManager);
  t.after(async () => {
    try { await serviceManager.stop(); } catch { /* Preserve the assertion failure. */ }
    await new Promise((resolve) => backend.close(resolve));
  });

  await serviceManager.start();
  assert.equal(await httpStatus(healthPort, '/ping'), 200);
  await sleep(3200);
  const burst = await Promise.all(Array.from({ length: 50 }, (_, index) => httpStatus(proxyPort, ['/oauth/callback', '/mcp', '/health'][index % 3], {
    localAddress: index % 2 === 0 ? '127.0.0.1' : '127.0.0.2',
    headers: {
      Host: `host-${index}.invalid`,
      'X-Forwarded-For': `198.51.100.${index + 1}`,
      'X-BRC-Limit-Key': `spoof-${index}`,
    },
  })));
  assert.equal(burst.filter((code) => code === 204).length, 30);
  assert.equal(burst.filter((code) => code === 429).length, 20);
  assert.equal(events.filter((event) => event.key === 'global-v1').length, 30);
  assert.ok(events.every((event) => event.key === 'global-v1'));
  assert.ok(events.some((event) => event.xff?.includes('198.51.100.')));

  await serviceManager.stop();
  await manager.writeConfig();
  await serviceManager.start();
  await sleep(3200);
  const fourSockets = await Promise.all(Array.from({ length: 4 }, () => websocketStatus(proxyPort)));
  assert.ok(fourSockets.every((result) => result.status === 101));
  const mixed = await Promise.all(Array.from({ length: 13 }, () => httpStatus(proxyPort, '/mcp?hold=300')));
  assert.equal(mixed.filter((code) => code === 204).length, 12);
  assert.equal(mixed.filter((code) => code === 429).length, 1);
  assert.equal(peak, 16);
  for (const result of fourSockets) result.socket.destroy();
  await sleep(100);

  await sleep(3200);
  const seventeenSockets = await Promise.all(Array.from({ length: 17 }, () => websocketStatus(proxyPort)));
  assert.equal(seventeenSockets.filter((result) => result.status === 101).length, 16);
  assert.equal(seventeenSockets.filter((result) => result.status === 429).length, 1);
  for (const result of seventeenSockets) result.socket.destroy();
  await sleep(100);

  assert.equal(await httpStatus(proxyPort, '/oauth/callback?code=abc&state=xyz'), 204);
  assert.equal(await httpStatus(proxyPort, '/mcp'), 204);
  assert.equal(await websocketStatus(proxyPort, '/ws').then((result) => { result.socket.destroy(); return result.status; }), 101);
  assert.equal(await httpStatus(proxyPort, '/oauth%2Fcallback'), 400);
  assert.equal(await httpStatus(proxyPort, '/mcp', { headers: { 'X.Auth.User': 'spoofed' } }), 400);
  assert.equal(webSockets, 0);
});
