import { spawn, spawnSync } from 'node:child_process';

export class ReleaseRunner {
  constructor({ output = process.stdout, errorOutput = process.stderr } = {}) {
    this.output = output;
    this.errorOutput = errorOutput;
    this.child = null;
    this.interrupted = false;
    this.onInterrupt = () => {
      this.interrupted = true;
      if (!this.child?.pid) return;
      if (process.platform === 'win32') {
        spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
      } else {
        this.child.kill('SIGINT');
      }
    };
  }

  async run(file, args, { cwd, env = process.env, interactive = false, onOutput } = {}) {
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
    const child = spawn(file, args, {
      cwd, env, shell, windowsHide: true,
      stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.interrupted = false;
    process.on('SIGINT', this.onInterrupt);
    const chunks = { stdout: '', stderr: '' };
    let tail = '';
    const capture = (stream, data) => {
      const text = data.toString('utf8');
      chunks[stream] += text;
      if (chunks[stream].length > 4 * 1024 * 1024) chunks[stream] = chunks[stream].slice(-2 * 1024 * 1024);
      tail = (tail + text).slice(-12000);
      if (onOutput) onOutput(stream, text);
      if (interactive) (stream === 'stdout' ? this.output : this.errorOutput).write(text);
    };
    if (!interactive) {
      child.stdout.on('data', (data) => capture('stdout', data));
      child.stderr.on('data', (data) => capture('stderr', data));
    }
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0
          ? resolve()
          : reject(new Error('Command failed (' + (code ?? 'terminated') + '): ' + file + ' ' + args[0] + '\n' + tail.slice(-2400))));
      });
      return chunks;
    } finally {
      this.child = null;
      process.removeListener('SIGINT', this.onInterrupt);
    }
  }
}
