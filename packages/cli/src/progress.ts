import type { TraefikProgressEvent } from './traefik/manager.js';

interface ProgressOutput {
  readonly isTTY?: boolean;
  write(text: string): unknown;
}

export class TraefikProgress {
  private timer?: NodeJS.Timeout;
  private current?: TraefikProgressEvent;
  private percent?: number;
  private frame = 0;

  constructor(private readonly output: ProgressOutput = process.stderr) {}

  report(event: TraefikProgressEvent): void {
    const sameStage = this.current?.operation === event.operation && this.current.stage === event.stage;
    if (event.status === 'started') {
      if (!sameStage) {
        this.stop();
        this.current = event;
        this.percent = undefined;
        if (!this.output.isTTY) {
          this.output.write(`Traefik ${event.operation}: ${event.stage}\n`);
          return;
        }
        this.timer = setInterval(() => this.render(), 120);
        this.timer.unref();
      }
      if (this.output.isTTY && event.completedBytes !== undefined && event.totalBytes !== undefined
        && Number.isSafeInteger(event.totalBytes) && event.totalBytes > 0
        && Number.isSafeInteger(event.completedBytes) && event.completedBytes >= 0 && event.completedBytes <= event.totalBytes) {
        const percent = Math.floor(event.completedBytes * 100 / event.totalBytes);
        this.percent = Math.max(this.percent ?? 0, percent);
      }
      if (this.output.isTTY) this.render();
    } else if (sameStage) {
      if (this.output.isTTY && event.status === 'completed' && event.completedBytes !== undefined
        && event.totalBytes !== undefined && event.totalBytes > 0 && event.completedBytes === event.totalBytes) {
        this.percent = 100;
        this.render();
      }
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.output.write('\r\x1b[2K');
    }
    this.current = undefined;
    this.percent = undefined;
  }

  private render(): void {
    if (!this.current) return;
    const spinner = ['|', '/', '-', '\\'][this.frame++ % 4];
    const percent = this.percent === undefined ? '' : ` ${this.percent}%`;
    this.output.write(`\r\x1b[2K${spinner} Traefik ${this.current.operation}: ${this.current.stage}${percent}`);
  }
}
