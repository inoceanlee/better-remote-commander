/** Return the registry's republish deadline while a name is blocked. */
export function registryRepublishAt(output, now = Date.now()) {
  const match = String(output).match(/Unpublished on\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
  if (!match) return null;
  const unpublishedAt = Date.parse(match[1]);
  if (!Number.isFinite(unpublishedAt)) return null;
  const deadline = unpublishedAt + 24 * 60 * 60 * 1000;
  return now < deadline ? new Date(deadline).toISOString() : null;
}

export function assertRegistryIntegrity(artifact, metadata) {
  if (metadata?.name !== artifact.name || metadata?.version !== artifact.version) {
    throw new Error('Registry package identity does not match the release artifact.');
  }
  if (metadata?.dist?.integrity !== artifact.integrity) {
    throw new Error('Registry dist.integrity does not match the release archive SHA-512.');
  }
}
