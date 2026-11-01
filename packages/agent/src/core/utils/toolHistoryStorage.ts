import * as fs from 'fs';
import * as path from 'path';

export class ToolHistoryStorage {
  readonly file: string;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'tool-history.jsonl');
  }

  readText(): string | null {
    try {
      return fs.readFileSync(this.file, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  size(): number {
    try {
      return fs.statSync(this.file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  appendText(text: string): void {
    fs.appendFileSync(this.file, text, 'utf-8');
  }

  rewriteText(text: string): void {
    fs.writeFileSync(this.file, text, 'utf-8');
  }
}
