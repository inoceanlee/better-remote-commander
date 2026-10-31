/** Return the registry's republish deadline while a name is blocked. */
export function registryRepublishAt(output, now = Date.now()) {
  const match = String(output).match(/Unpublished on\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i);
  if (!match) return null;
  const unpublishedAt = Date.parse(match[1]);
  if (!Number.isFinite(unpublishedAt)) return null;
  const deadline = unpublishedAt + 24 * 60 * 60 * 1000;
  return now < deadline ? new Date(deadline).toISOString() : null;
}
