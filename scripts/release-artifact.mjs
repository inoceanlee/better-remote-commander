import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RELEASE_CONFIG } from './release-config.mjs';

const completeValidations = (validations) => RELEASE_CONFIG.validationNames.every((name) => validations?.[name] === true);

async function sha512File(filename) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return 'sha512-' + hash.digest('base64');
}

async function writeAtomic(filename, data) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + '.' + randomUUID() + '.tmp';
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class ReleaseArtifactStore {
  constructor(directory = RELEASE_CONFIG.artifactDirectory) {
    this.directory = path.resolve(directory);
  }

  versionDirectory(version) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version.');
    return path.join(this.directory, version);
  }

  async save({ archive, revision, name, version, tag, buildFingerprint, validations }) {
    if (!completeValidations(validations)) throw new Error('Release validations are incomplete.');
    const directory = this.versionDirectory(version);
    const integrity = await sha512File(archive);
    const archivePath = path.join(directory, name.replaceAll('/', '-') + '-' + version + '.tgz');
    await mkdir(directory, { recursive: true });
    const temporaryArchive = archivePath + '.' + randomUUID() + '.tmp';
    await writeFile(temporaryArchive, await readFile(archive), { flag: 'wx', mode: 0o600 });
    await rename(temporaryArchive, archivePath);
    const metadata = {
      revision, name, version, tag: tag ?? RELEASE_CONFIG.tagPrefix + version, buildFingerprint,
      archive: path.basename(archivePath), size: (await stat(archivePath)).size,
      integrity, validations, publishAttempted: false,
    };
    await writeAtomic(path.join(directory, 'receipt.json'), JSON.stringify(metadata) + '\n');
    return { ...metadata, archivePath };
  }

  async load(version) {
    let metadata;
    const directory = this.versionDirectory(version);
    try {
      metadata = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
    if (metadata.version !== version || !completeValidations(metadata.validations)) return null;
    const archivePath = path.join(directory, metadata.archive);
    try {
      if ((await stat(archivePath)).size !== metadata.size || await sha512File(archivePath) !== metadata.integrity) return null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return { ...metadata, archivePath };
  }

  async find({ revision, name, version, buildFingerprint }) {
    const metadata = await this.load(version);
    if (!metadata || metadata.revision !== revision || metadata.name !== name
      || metadata.buildFingerprint !== buildFingerprint) return null;
    return metadata;
  }

  async markAttempted(artifact) {
    const directory = this.versionDirectory(artifact.version);
    const filename = path.join(directory, 'receipt.json');
    const current = await this.find(artifact);
    if (!current || current.integrity !== artifact.integrity) throw new Error('Release artifact receipt does not match.');
    current.publishAttempted = true;
    current.attemptedAt = new Date().toISOString();
    const { archivePath, ...metadata } = current;
    await writeAtomic(filename, JSON.stringify(metadata) + '\n');
    return current;
  }

  async markRegistryVerified(artifact) {
    const current = await this.load(artifact.version);
    if (!current || current.revision !== artifact.revision || current.integrity !== artifact.integrity) {
      throw new Error('Release artifact receipt does not match.');
    }
    current.registryVerifiedAt = new Date().toISOString();
    const { archivePath, ...metadata } = current;
    await writeAtomic(path.join(this.versionDirectory(artifact.version), 'receipt.json'), JSON.stringify(metadata) + '\n');
    return current;
  }
}

export class ReleaseLock {
  constructor(directory) {
    this.directory = path.resolve(directory);
  }

  async withExclusive(operation, metadata = {}) {
    const token = randomUUID();
    const record = { pid: process.pid, token, startedAt: Date.now(), ...metadata };
    await mkdir(path.dirname(this.directory), { recursive: true });
    try {
      await mkdir(this.directory);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const ownerFile = path.join(this.directory, 'owner.json');
      let owner;
      try {
        owner = JSON.parse(await readFile(ownerFile, 'utf8'));
      } catch {
        throw new Error('Release lock is active or its owner cannot be verified.');
      }
      if (Number.isInteger(owner.pid) && owner.pid > 0 && processIsAlive(owner.pid)) {
        throw new Error('Release lock is already held by process ' + owner.pid + '.');
      }
      const stale = this.directory + '.stale-' + randomUUID();
      try {
        await rename(this.directory, stale);
      } catch {
        throw new Error('Release lock changed while checking its owner.');
      }
      await rm(stale, { recursive: true, force: true });
      try {
        await mkdir(this.directory);
      } catch (retryError) {
        if (retryError.code === 'EEXIST') throw new Error('Release lock is already held.');
        throw retryError;
      }
    }
    await writeFile(path.join(this.directory, 'owner.json'), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    try {
      return await operation();
    } finally {
      try {
        const owner = JSON.parse(await readFile(path.join(this.directory, 'owner.json'), 'utf8'));
        if (owner.token === token) await rm(this.directory, { recursive: true, force: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'EPERM') return true;
    return false;
  }
}
