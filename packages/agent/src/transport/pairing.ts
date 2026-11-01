/**
 * BRC agent device pairing (OAuth device-authorization style) + credential persistence.
 * Credentials: $BRC_HOME/device.json (mode 0600) -> { relayUrl, deviceId, deviceToken, name, pairedAt }
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveAgentHome } from '../core/config.js';

export interface DeviceCredentials { relayUrl: string; deviceId: string; deviceToken: string; name: string; pairedAt: string }

/** Agent home. Resolved to a long path: Windows 8.3 short paths crash libuv's fs.watch (used by the config watcher). */
export const homeDir = () => resolveAgentHome(process.env);
const credFile = () => path.join(homeDir(), 'device.json');

export function loadCredentials(): DeviceCredentials | null {
  try { return JSON.parse(readFileSync(credFile(), 'utf8')) as DeviceCredentials; } catch { return null; }
}

export function saveCredentials(c: DeviceCredentials): void {
  mkdirSync(homeDir(), { recursive: true });
  writeFileSync(credFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  try { chmodSync(credFile(), 0o600); } catch { /* windows */ }
}

export function clearCredentials(): boolean {
  if (!existsSync(credFile())) return false;
  unlinkSync(credFile());
  return true;
}

export interface PairOptions {
  relayUrl: string;
  name: string;
  deviceId?: string;
  openBrowser?: boolean;
  log: (msg: string) => void;
}

interface StartResponse { device_code: string; user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number }
interface PollResponse { device_token?: string; device_id?: string; error?: string; interval?: number }

type PairingState =
  | { kind: 'polling'; interval: number }
  | { kind: 'approved'; deviceId: string; deviceToken: string }
  | { kind: 'failed'; message: string };

function advancePairing(state: Extract<PairingState, { kind: 'polling' }>, response: PollResponse): PairingState {
  if (response.device_token && response.device_id) {
    return { kind: 'approved', deviceId: response.device_id, deviceToken: response.device_token };
  }
  switch (response.error) {
    case 'authorization_pending': return state;
    case 'slow_down': return { kind: 'polling', interval: state.interval + 5000 };
    case 'access_denied': return { kind: 'failed', message: 'pairing denied by the relay owner' };
    case 'expired_token': return { kind: 'failed', message: 'pairing code expired; start the agent again' };
    default: return { kind: 'failed', message: `pairing failed: ${response.error ?? 'unknown error'}` };
  }
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; json: T }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs the pairing flow until approved, denied or expired. Returns saved credentials. */
export async function pairDevice(opts: PairOptions): Promise<DeviceCredentials> {
  const base = opts.relayUrl.replace(/\/$/, '');
  const deviceId = opts.deviceId ?? randomUUID();
  const { status, json: start } = await postJson<StartResponse>(`${base}/device/start`, { client_name: opts.name });
  if (status !== 200 || !start.device_code) throw new Error(`relay rejected pairing start (${status})`);

  opts.log('');
  opts.log('Pairing required. Open this URL and enter the code:');
  opts.log(`   ${start.verification_uri}`);
  opts.log(`   code: ${start.user_code}   (expires in ${Math.round(start.expires_in / 60)} min)`);
  opts.log('');
  if (opts.openBrowser !== false) {
    try { const { default: open } = await import('open'); await open(start.verification_uri_complete); } catch { /* headless */ }
  }

  let state: Extract<PairingState, { kind: 'polling' }> = { kind: 'polling', interval: Math.max(2, start.interval ?? 5) * 1000 };
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(state.interval);
    const { json } = await postJson<PollResponse>(`${base}/device/poll`, {
      device_code: start.device_code, device_id: deviceId, name: opts.name, platform: `${process.platform}/${process.arch}`,
    });
    const next = advancePairing(state, json);
    if (next.kind === 'approved') {
      const creds: DeviceCredentials = { relayUrl: base, deviceId: next.deviceId, deviceToken: next.deviceToken, name: opts.name, pairedAt: new Date().toISOString() };
      saveCredentials(creds);
      opts.log(`Paired as "${opts.name}" [${next.deviceId}]; credentials saved to ${credFile()}`);
      return creds;
    }
    if (next.kind === 'failed') throw new Error(next.message);
    state = next;
  }
  throw new Error('pairing code expired; start the agent again');
}
