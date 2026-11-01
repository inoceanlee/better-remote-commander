import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

export interface AdministratorPrompt {
  askUsername(): Promise<string>;
  askHiddenPassword(label: string): Promise<string>;
}

/** Validate credentials before creating a persistent Relay identity. */
export function validateAdministratorPassword(password: string, confirmation?: string): void {
  if (confirmation !== undefined && password !== confirmation) {
    throw new Error('Administrator passwords do not match. Run brc setup again.');
  }
  if (password.length < 8) {
    throw new Error('Administrator password must contain at least 8 characters.');
  }
}

export async function collectAdministratorCredentials(
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  prompt: AdministratorPrompt,
): Promise<{ username: string; password: string }> {
  const suppliedPassword = env.BRC_ADMIN_PASSWORD;
  if (suppliedPassword === undefined && !interactive) {
    throw new Error('First setup requires an interactive terminal to set the administrator password.');
  }
  let username = env.BRC_ADMIN_USER?.trim();
  if (!username && interactive) username = (await prompt.askUsername()).trim();
  username ||= 'admin';
  let password = suppliedPassword;
  if (password === undefined) {
    password = await prompt.askHiddenPassword('Administrator password (hidden): ');
    const confirmation = await prompt.askHiddenPassword('Confirm administrator password (hidden): ');
    validateAdministratorPassword(password, confirmation);
  } else {
    validateAdministratorPassword(password);
  }
  return { username, password };
}

export async function requestAdministrator(): Promise<{ username: string; password: string }> {
  return collectAdministratorCredentials(process.env, Boolean(process.stdin.isTTY && process.stdout.isTTY), {
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
  });
}
