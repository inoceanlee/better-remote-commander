/** Release versions are explicit in packages/cli/package.json. */
export function assertReleaseVersion(source, published) {
  if (!/^\d+\.\d+\.\d+$/.test(source)) throw new Error('Invalid release version: ' + source);
  if (!published || published === '0.0.0-stage') return;
  if (!/^\d+\.\d+\.\d+$/.test(published)) throw new Error('Unexpected published version: ' + published);
  const a = source.split('.').map(Number), b = published.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return;
    if (a[i] < b[i]) break;
  }
  throw new Error('Release version ' + source + ' must exceed published version ' + published + '. Update packages/cli/package.json.');
}
