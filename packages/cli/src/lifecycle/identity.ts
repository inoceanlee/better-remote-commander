import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ProcessIdentity {
  pid: number;
  createdAt: string;
  executablePath: string;
  commandLine: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function exitStatus(error: unknown): number | undefined {
  return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? error.status : undefined;
}

function parseProcessIdentity(value: unknown): ProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !('pid' in value) || !('createdAt' in value) || !('executablePath' in value) || !('commandLine' in value)
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !value.createdAt
      || typeof value.executablePath !== 'string' || !value.executablePath
      || typeof value.commandLine !== 'string' || !value.commandLine) {
    throw new Error('Windows returned incomplete process identity.');
  }
  return { pid: value.pid, createdAt: value.createdAt, executablePath: value.executablePath, commandLine: value.commandLine };
}

export async function inspectProcesses(pids: readonly number[]): Promise<Map<number, ProcessIdentity | null>> {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid process ID: ${pid}`);
  }
  const unique = [...new Set(pids)];
  const result = new Map<number, ProcessIdentity | null>(unique.map((pid) => [pid, null]));
  if (!unique.length) return result;
  if (process.platform === 'win32') {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const filter = unique.map((pid) => `ProcessId = ${pid}`).join(' OR ');
    const script = `$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_Process -Filter '${filter}' | Select-Object @{Name='pid';Expression={$_.ProcessId}},@{Name='createdAt';Expression={if ($null -ne $_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {$null}}},@{Name='executablePath';Expression={$_.ExecutablePath}},@{Name='commandLine';Expression={$_.CommandLine}} | ConvertTo-Json -Compress`;
    const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024,
    }).trim();
    if (!output) return result;
    const parsed: unknown = JSON.parse(output);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const identity = parseProcessIdentity(entry);
      if (!result.has(identity.pid) || result.get(identity.pid) !== null) throw new Error('Windows returned unexpected process identity.');
      result.set(identity.pid, identity);
    }
    return result;
  }
  await Promise.all(unique.map(async (pid) => { result.set(pid, await inspectNonWindows(pid)); }));
  return result;
}

export async function inspectProcess(pid: number): Promise<ProcessIdentity | null> {
  return (await inspectProcesses([pid])).get(pid) ?? null;
}

async function inspectNonWindows(pid: number): Promise<ProcessIdentity | null> {
  if (process.platform === 'linux') {
    let stat: string;
    let executablePath: string;
    let rawCommand: Buffer;
    try {
      [stat, executablePath, rawCommand] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'), realpath(`/proc/${pid}/exe`), readFile(`/proc/${pid}/cmdline`),
      ]);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return null;
      throw error;
    }
    const closeParen = stat.lastIndexOf(')');
    if (closeParen < 0) throw new Error(`Linux returned malformed process identity for ${pid}.`);
    const startTicks = stat.slice(closeParen + 2).trim().split(/\s+/)[19];
    if (!startTicks) throw new Error(`Linux returned incomplete start time for process ${pid}.`);
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const commandLine = rawCommand.toString('utf8').split('\0').filter(Boolean).join(' ');
    if (!commandLine) return null;
    return { pid, createdAt: `${bootId}:${startTicks}`, executablePath, commandLine };
  }
  if (process.platform === 'darwin') {
    try {
      const createdAt = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', windowsHide: true }).trim();
      const executablePath = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true }).trim();
      const commandLine = execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', windowsHide: true }).trim();
      if (!createdAt || !executablePath || !commandLine) return null;
      return { pid, createdAt, executablePath, commandLine };
    } catch (error) {
      if (exitStatus(error) === 1) return null;
      throw error;
    }
  }
  throw new Error(`Managed process inspection is unsupported on ${process.platform}.`);
}
