import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const crate = path.join(root, 'native', 'brc-process');
const target = 'x86_64-pc-windows-msvc';
const source = path.join(crate, 'target', target, 'release', 'brc-process.exe');
const destination = path.join(root, 'packages', 'cli', 'dist', 'native', 'win32-x64', 'brc-process.exe');

function validatePe(bytes) {
  if (bytes.length < 256 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Native process inspector is not a Windows executable.');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 6 > bytes.length || bytes.toString('ascii', offset, offset + 4) !== 'PE\0\0'
      || bytes.readUInt16LE(offset + 4) !== 0x8664) throw new Error('Native process inspector must target Windows x64.');
}

export async function buildNative() {
  if (process.platform !== 'win32' || process.arch !== 'x64') return;
  let current = false;
  try {
    const binary = await stat(source);
    const inputs = [
      'Cargo.toml', 'Cargo.lock', 'src/main.rs', 'src/identity.rs', 'src/windows.rs',
    ];
    const times = await Promise.all(inputs.map((file) => stat(path.join(crate, file))));
    current = binary.size > 0 && times.every((info) => info.mtimeMs <= binary.mtimeMs);
  } catch { /* Missing output requires a build. */ }
  if (!current) {
    const result = spawnSync('cargo', ['build', '--release', '--locked', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')], {
      cwd: root, stdio: 'inherit', windowsHide: true, shell: false, timeout: 240_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Native process inspector build failed.');
  }
  const sourceBinary = await readFile(source);
  validatePe(sourceBinary);
  await mkdir(path.dirname(destination), { recursive: true });
  let existing;
  try { existing = await readFile(destination); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!existing?.equals(sourceBinary)) {
    await copyFile(source, destination);
  }
  validatePe(await readFile(destination));
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()) {
  await buildNative();
}
