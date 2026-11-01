import iconv from 'iconv-lite';

export interface ShellEncodingInfo {
  consoleInput: string;
  consoleOutput: string;
  nativePipe: string;
  codePage: number;
}

export interface ShellProbeResult {
  state: 'pending' | 'complete';
  info?: ShellEncodingInfo;
  stdout?: Buffer;
  trailing?: Buffer;
}

export const SHELL_PROBE_TIMEOUT_MS = 5000;
export const SHELL_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_CODE_PAGES: Record<number, string> = {
  932: 'shift_jis', 936: 'gbk', 949: 'cp949', 950: 'big5', 65001: 'utf-8',
  1200: 'utf-16le', 1201: 'utf-16be',
};

function normalizeEncoding(value: string): string {
  const encoding = value.trim().toLowerCase().replaceAll('_', '-');
  const normalized = encoding === 'gb2312' || encoding === 'gb-2312' ? 'gbk' : encoding;
  if (!iconv.encodingExists(normalized)) throw new Error(`unsupported shell encoding: ${value}`);
  return normalized;
}

export function parseShellEncodingInfo(shell: 'powershell' | 'cmd', report: string): ShellEncodingInfo {
  let consoleInput: string;
  let consoleOutput: string;
  let nativePipe: string;
  let codePage: number;
  if (shell === 'cmd') {
    const match = /(?:^|[;\s])cp=\s*(\d+)(?:$|[;\s])/i.exec(report);
    if (!match) throw new Error('invalid CMD code page probe');
    codePage = Number(match[1]);
    const encoding = WINDOWS_CODE_PAGES[codePage] ?? `cp${codePage}`;
    if (!iconv.encodingExists(encoding)) throw new Error(`unsupported code page: ${codePage}`);
    consoleInput = encoding;
    consoleOutput = encoding;
    nativePipe = encoding;
  } else {
    const match = /^in=([^;]+);out=([^;]+);pipe=([^;]+);cp=(\d+)$/i.exec(report.trim());
    if (!match) throw new Error('invalid PowerShell encoding probe');
    consoleInput = normalizeEncoding(match[1]);
    consoleOutput = normalizeEncoding(match[2]);
    nativePipe = normalizeEncoding(match[3]);
    codePage = Number(match[4]);
    if (!Number.isSafeInteger(codePage) || codePage < 1) throw new Error(`unsupported code page: ${match[4]}`);
  }
  return { consoleInput, consoleOutput, nativePipe, codePage };
}

export class ShellEncodingProbe {
  private buffered = Buffer.alloc(0);
  private complete = false;

  constructor(
    private readonly marker: string,
    private readonly maxBytes = SHELL_PROBE_OUTPUT_LIMIT_BYTES,
    private readonly shell: 'powershell' | 'cmd' = 'powershell',
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(marker)) throw new Error('probe marker must contain ASCII letters, digits, or underscores');
  }

  get bufferedByteLength(): number {
    return this.buffered.length;
  }

  push(chunk: Buffer): ShellProbeResult {
    if (this.complete) throw new Error('encoding probe already completed');
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > this.maxBytes) throw new Error('shell encoding probe output exceeded limit');
    const token = Buffer.from(`${this.marker}|`, 'ascii');
    const index = this.buffered.indexOf(token);
    if (index < 0) return { state: 'pending' };
    const lineEnd = this.buffered.indexOf(0x0a, index + token.length);
    if (lineEnd < 0) return { state: 'pending' };
    const report = this.buffered.subarray(index + token.length, lineEnd).toString('ascii').replace(/\r$/, '');
    const info = parseShellEncodingInfo(this.shell, report);
    this.complete = true;
    return {
      state: 'complete',
      info,
      stdout: this.buffered.subarray(0, index),
      trailing: this.buffered.subarray(lineEnd + 1),
    };
  }
}

export function createShellEncodingDecoder(encoding: string): { write(chunk: Buffer): string; end(chunk?: Buffer): string } {
  const decoder = iconv.getDecoder(normalizeEncoding(encoding));
  return {
    write: (chunk) => decoder.write(chunk),
    end: (chunk) => `${chunk ? decoder.write(chunk) : ''}${decoder.end() ?? ''}`,
  };
}

export function encodeShellInput(text: string, encoding: string): Buffer {
  return iconv.encode(text, normalizeEncoding(encoding));
}
