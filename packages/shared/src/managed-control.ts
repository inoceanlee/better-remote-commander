import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ManagedHealth {
  state: 'running' | 'degraded';
  detail: string;
}

export interface ManagedControlServer {
  port: number;
  close(): Promise<void>;
}

export async function startManagedControlServer(options: {
  health: () => ManagedHealth | Promise<ManagedHealth>;
  stop: () => void | Promise<void>;
}): Promise<ManagedControlServer | undefined> {
  const token = process.env.BRC_CONTROL_TOKEN;
  const readyFile = process.env.BRC_CONTROL_READY_FILE;
  const id = process.env.BRC_MANAGED_ID;
  const service = process.env.BRC_MANAGED_SERVICE;
  if (!token && !readyFile && !id && !service) return undefined;
  if (!token || !readyFile || !id || !service) throw new Error('Incomplete BRC managed-control environment.');

  let stopping = false;
  const server: Server = createServer((request, response) => {
    const address = request.socket.remoteAddress ?? '';
    const loopback = address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
    const supplied = request.headers.authorization?.startsWith('Bearer ')
      ? Buffer.from(request.headers.authorization.slice(7))
      : Buffer.alloc(0);
    const expected = Buffer.from(token);
    const authorized = loopback && supplied.length === expected.length && timingSafeEqual(supplied, expected);
    if (!authorized) {
      response.writeHead(404).end();
      return;
    }

    if (request.method === 'GET' && request.url === '/health') {
      void Promise.resolve(options.health()).then((health) => {
        const ok = health.state === 'running';
        response.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok, state: health.state, detail: health.detail }));
      }).catch(() => {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, state: 'degraded', detail: 'Health check failed.' }));
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/shutdown') {
      response.writeHead(202).end();
      if (!stopping) {
        stopping = true;
        setImmediate(() => {
          void Promise.resolve(options.stop()).catch((error: unknown) => {
            console.error(`BRC managed shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exitCode = 1;
          });
        });
      }
      return;
    }

    response.writeHead(404).end();
  });
  const closeServer = () => new Promise<void>((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close((error) => error ? reject(error) : resolve());
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer();
    throw new Error('BRC managed-control listener did not receive a TCP port.');
  }

  const port = address.port;
  const temporaryFile = `${readyFile}.${process.pid}.tmp`;
  try {
    await mkdir(path.dirname(readyFile), { recursive: true });
    await writeFile(temporaryFile, JSON.stringify({ id, service, pid: process.pid, port }), { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryFile, readyFile);
  } catch (error) {
    await closeServer();
    throw error;
  }

  return {
    port,
    close: closeServer,
  };
}
