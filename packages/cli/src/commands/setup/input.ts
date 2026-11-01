import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { collectAdministratorCredentials } from './administrator.js';

export async function requestAdministrator(): Promise<{ username: string; password: string }> {
  return collectAdministratorCredentials(
    process.env,
    Boolean(process.stdin.isTTY && process.stdout.isTTY),
    {
      async askUsername(): Promise<string> {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try { return await rl.question('Administrator username [admin]: '); }
        finally { rl.close(); }
      },
      async askHiddenPassword(label: string): Promise<string> {
        const silentOutput = new Writable({ write(_chunk, _encoding, done) { done(); } });
        const rl = createInterface({ input: process.stdin, output: silentOutput, terminal: true });
        try {
          process.stdout.write(label);
          return await rl.question('');
        } finally {
          rl.close();
          process.stdout.write('\n');
        }
      },
    },
  );
}
