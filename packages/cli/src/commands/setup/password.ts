/** Validate credentials before creating a persistent Relay identity. */
export function validateAdministratorPassword(password: string, confirmation?: string): void {
  if (confirmation !== undefined && password !== confirmation) {
    throw new Error('Administrator passwords do not match. Run brc setup again.');
  }
  if (password.length < 8) {
    throw new Error('Administrator password must contain at least 8 characters.');
  }
}
