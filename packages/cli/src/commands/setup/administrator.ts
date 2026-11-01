import { validateAdministratorPassword } from './password.js';

export interface AdministratorPrompt {
  askUsername(): Promise<string>;
  askHiddenPassword(label: string): Promise<string>;
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
