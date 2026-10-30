import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PACKAGE_NAME = '@inoceanlee/brc';
const SHIM_SETTLE_DELAY_MS = 750;
const PARENT_EXIT_TIMEOUT_MS = 30_000;

interface RemovalReport {
  package: string;
  status: 'pending' | 'completed' | 'failed';
  scheduledAt: string;
  completedAt?: string;
  exitCode?: number | null;
  error?: string;
  output?: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForParentExit(pid: number): Promise<void> {
  const deadline = Date.now() + PARENT_EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (errorCode(error) === 'ESRCH' || errorCode(error) === 'EINVAL') return;
      throw error;
    }
    await sleep(50);
  }
  throw new Error(`Parent process ${pid} did not exit before timeout.`);
}

function runPnpmRemove(): { exitCode: number | null; output: string } {
  const lookup = spawnSync('where.exe', ['pnpm'], { encoding: 'utf8', windowsHide: true });
  if (lookup.error) throw lookup.error;
  if (lookup.status !== 0) throw new Error(`where.exe pnpm failed: ${lookup.stderr.trim()}`);
  const commands = lookup.stdout.split(/\r?\n/).filter(Boolean);
  const command = commands.find((candidate) => /\.exe$/i.test(candidate))
    ?? commands.find((candidate) => /\.(?:cmd|bat)$/i.test(candidate));
  if (!command) throw new Error('where.exe pnpm found no executable command.');

  const args = ['remove', '--global', PACKAGE_NAME];
  const isShim = /\.(?:cmd|bat)$/i.test(command);
  const cmdLine = [`"${command.replaceAll('"', '""')}"`, ...args.map((arg) => `"${arg.replaceAll('"', '""')}"`)].join(' ');
  const result = spawnSync(
    isShim ? process.env.ComSpec || 'cmd.exe' : command,
    isShim ? ['/d', '/s', '/c', `"${cmdLine}"`] : args,
    {
      cwd: os.tmpdir(),
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: isShim,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  return { exitCode: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.slice(-8192) };
}

async function updateReport(reportPath: string, update: Partial<RemovalReport>): Promise<void> {
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as RemovalReport;
  await writeFile(reportPath, JSON.stringify({ ...report, ...update }, null, 2));
}

async function main(): Promise<void> {
  const parentPid = Number(process.argv[2]);
  const reportPath = path.resolve(process.argv[3] ?? '');
  const packageName = process.argv[4];
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0 || packageName !== PACKAGE_NAME
      || path.dirname(reportPath) !== path.resolve(os.tmpdir())
      || !path.basename(reportPath).startsWith('brc-uninstall-')) {
    throw new Error('Invalid uninstall worker arguments.');
  }

  try {
    await waitForParentExit(parentPid);
    await sleep(SHIM_SETTLE_DELAY_MS);
    const result = runPnpmRemove();
    if (result.exitCode !== 0) throw Object.assign(new Error(result.output || `pnpm exited with ${result.exitCode}.`), { exitCode: result.exitCode });
    await updateReport(reportPath, { status: 'completed', completedAt: new Date().toISOString(), exitCode: 0, output: result.output });
  } catch (error) {
    await updateReport(reportPath, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      exitCode: error && typeof error === 'object' && 'exitCode' in error ? Number(error.exitCode) : null,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await main();
