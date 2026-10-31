import { spawn, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const formatSeconds = (elapsed) => (elapsed / 1000).toFixed(1) + 's';

export class ReleaseProgress {
  constructor({ output = process.stdout, errorOutput = process.stderr, verbose = false } = {}) {
    this.output = output;
    this.errorOutput = errorOutput;
    this.verbose = verbose;
    this.current = null;
    this.frame = 0;
    this.timer = null;
    this.child = null;
    this.interrupted = false;
    this.interactive = false;
    this.onInterrupt = () => {
      this.interrupted = true;
      if (this.child?.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          this.child.kill('SIGINT');
        }
      }
    };
  }

  print(message) {
    this.clear();
    this.output.write(message + '\n');
  }

  clear() {
    if (this.output.isTTY && this.current && !this.interactive) this.output.write('\r\x1b[2K');
  }

  render() {
    if (!this.current || this.interactive) return;
    const elapsed = formatSeconds(performance.now() - this.current.started);
    const details = this.current.details ? ' · ' + this.current.details : '';
    if (this.output.isTTY) {
      const frame = frames[this.frame++ % frames.length];
      this.output.write('\r\x1b[2K' + frame + ' ' + this.current.name + details + ' · ' + elapsed);
    } else if (performance.now() - this.current.lastHeartbeat >= 15000) {
      this.current.lastHeartbeat = performance.now();
      this.output.write('  … ' + this.current.name + details + ' · ' + elapsed + '\n');
    }
  }

  async step(number, total, title, task) {
    const name = '[' + number + '/' + total + '] ' + title;
    this.output.write('  ' + name + '\n');
    this.current = { name, started: performance.now(), lastHeartbeat: performance.now(), details: '' };
    this.timer = setInterval(() => this.render(), 120);
    this.timer.unref?.();
    process.on('SIGINT', this.onInterrupt);
    try {
      const result = await task();
      const elapsed = formatSeconds(performance.now() - this.current.started);
      this.clear();
      this.output.write('  ✓ ' + name + ' · ' + elapsed + '\n');
      return result;
    } catch (error) {
      const elapsed = formatSeconds(performance.now() - this.current.started);
      this.clear();
      this.errorOutput.write('  ✗ ' + name + ' · ' + elapsed + '\n');
      throw error;
    } finally {
      clearInterval(this.timer);
      this.timer = null;
      this.current = null;
      process.removeListener('SIGINT', this.onInterrupt);
    }
  }

  async command(file, args, { cwd, env = process.env, interactive = false } = {}) {
    if (interactive) {
      this.clear();
      this.interactive = true;
      this.output.write('\n');
    }
    const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file);
    const child = spawn(file, args, {
      cwd, env, shell, windowsHide: true, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    let tail = '';
    const chunks = { stdout: '', stderr: '' };
    function capture(which, data, that) {
      const text = data.toString('utf8');
      chunks[which] += text;
      if (chunks[which].length > 4 * 1024 * 1024) chunks[which] = chunks[which].slice(-2 * 1024 * 1024);
      tail = (tail + text).slice(-12000);
      if (that.verbose) {
        that.clear();
        that.output.write(text);
      }
      const steps = text.match(/BRC_DETAIL:([^\r\n]+)/g);
      if (steps?.length && that.current) that.current.details = steps.at(-1).slice('BRC_DETAIL:'.length);
      const matches = text.match(/BRC_PROGRESS:(\d{1,3})/g);
      if (matches?.length && that.current) that.current.details = matches.at(-1).slice('BRC_PROGRESS:'.length) + '% gzip';
    }
    if (!interactive) {
      child.stdout.on('data', (data) => capture('stdout', data, this));
      child.stderr.on('data', (data) => capture('stderr', data, this));
    }
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error('Command failed (' + (code ?? 'terminated') + '): ' + file + ' ' + args[0] + '\n' + tail.slice(-2400))));
      });
      return chunks;
    } finally {
      this.child = null;
      this.interactive = false;
    }
  }
}
