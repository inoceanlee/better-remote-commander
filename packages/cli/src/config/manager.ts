import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrcPaths } from './paths.js';
import {
  BRC_SETTING_KEYS,
  isBrcSettingKey,
  resolveSettings,
  withSettingValue,
  type BrcSettingKey,
  type BrcSettingSource,
  type BrcSettingValues,
  type BrcSettings,
} from './settings.js';
import {
  InvalidConfigurationFileError,
  readLastGoodSettings,
  readSettings,
  type LoadedSettings,
} from './reader.js';
import {
  removeConfigFile,
  removeLastGoodFile,
  writeConfigText,
  writeLastGoodText,
  writeSettings,
} from './writer.js';
import type { LifecycleLock } from '../lifecycle/lock.js';

export interface SettingsManagerDependencies {
  lock: Pick<LifecycleLock, 'runExclusive'>;
  /** Runs while the injected lock is held; do not acquire that lock again. */
  apply: (settings: Readonly<BrcSettings>, previous: Readonly<BrcSettings>) => Promise<void>;
}

export interface SettingEntry<K extends BrcSettingKey = BrcSettingKey> {
  key: K;
  value: BrcSettingValues[K];
  source: BrcSettingSource;
}

const STATIC_SETTINGS: readonly BrcSettingKey[] = [
  'services.relayPort',
  'services.proxyPort',
  'services.healthPort',
  'services.publicUrl',
];

function readValue<K extends BrcSettingKey>(settings: Readonly<BrcSettings>, key: K): BrcSettingValues[K] {
  let value: unknown = settings;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)[part];
  return value as BrcSettingValues[K];
}

function requiresRestart(previous: Readonly<BrcSettings>, next: Readonly<BrcSettings>): boolean {
  return STATIC_SETTINGS.some((key) => readValue(previous, key) !== readValue(next, key));
}

function defaultSettings(env: NodeJS.ProcessEnv): LoadedSettings {
  return { ...resolveSettings({ version: 1 }, env), rawContents: null };
}

interface ConfigGeneration {
  state: 'pending' | 'committed';
  id: string;
}

async function readGeneration(paths: BrcPaths): Promise<ConfigGeneration | null> {
  let text: string;
  try {
    text = await readFile(path.join(paths.config, 'brc.yaml.generation'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Invalid configuration transaction marker.');
  }
  if (!value || typeof value !== 'object' || !('state' in value) || !('id' in value)
    || (value.state !== 'pending' && value.state !== 'committed')
    || typeof value.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.id)) {
    throw new Error('Invalid configuration transaction marker.');
  }
  return value as ConfigGeneration;
}

async function writeGeneration(paths: BrcPaths, state: ConfigGeneration['state']): Promise<void> {
  const filename = path.join(paths.config, 'brc.yaml.generation');
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await mkdir(paths.config, { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ state, id: randomUUID() }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function beginTransaction(paths: BrcPaths): Promise<void> {
  const current = await readGeneration(paths);
  if (current?.state === 'pending') throw new Error('An incomplete configuration transaction requires manual recovery.');
  await writeGeneration(paths, 'pending');
}

export class SettingsManager {
  private constructor(
    private readonly paths: BrcPaths,
    private readonly env: NodeJS.ProcessEnv,
    private readonly dependencies: SettingsManagerDependencies,
    private loaded: LoadedSettings,
    private lastGood: LoadedSettings | null,
  ) {}

  static async load(
    paths: BrcPaths,
    env: NodeJS.ProcessEnv,
    dependencies: SettingsManagerDependencies,
  ): Promise<SettingsManager> {
    if (!dependencies?.lock || typeof dependencies.apply !== 'function') {
      throw new Error('SettingsManager requires a lifecycle lock and an apply operation.');
    }
    const runtimeEnv = { ...env };
    const read = async () => {
      const lastGood = await readLastGoodSettings(paths, runtimeEnv);
      let loaded: LoadedSettings;
      try {
        loaded = await readSettings(paths, runtimeEnv);
      } catch (error) {
        if (!(error instanceof InvalidConfigurationFileError)) throw error;
        loaded = lastGood ?? defaultSettings(runtimeEnv);
      }
      return { loaded, lastGood };
    };
    const lockedRead = async () => dependencies.lock.runExclusive(async () => {
      const generation = await readGeneration(paths);
      if (generation?.state === 'pending') throw new Error('An incomplete configuration transaction requires manual recovery.');
      const current = await read();
      if (!current.lastGood && current.loaded.rawContents !== null) {
        await beginTransaction(paths);
        await writeLastGoodText(paths, current.loaded.rawContents);
        await writeGeneration(paths, 'committed');
        return { loaded: current.loaded, lastGood: current.loaded };
      }
      if (!generation) await writeGeneration(paths, 'committed');
      return current;
    });
    const before = await readGeneration(paths);
    let initial: { loaded: LoadedSettings; lastGood: LoadedSettings | null } | undefined;
    if (before?.state === 'committed') {
      let failure: unknown;
      try {
        initial = await read();
      } catch (error) {
        failure = error;
      }
      const after = await readGeneration(paths);
      if (!after || after.state !== 'committed' || after.id !== before.id) {
        initial = undefined;
      } else if (failure !== undefined) {
        throw failure;
      }
    }
    if (!initial || (!initial.lastGood && initial.loaded.rawContents !== null)) initial = await lockedRead();
    return new SettingsManager(paths, runtimeEnv, dependencies, initial.loaded, initial.lastGood);
  }

  get<K extends BrcSettingKey>(key: K): { value: BrcSettingValues[K]; source: BrcSettingSource } {
    return {
      value: readValue(this.loaded.settings, key),
      source: this.loaded.sources[key],
    };
  }

  entries(): SettingEntry[] {
    return BRC_SETTING_KEYS.map((key) => ({ ...this.get(key), key }));
  }
  snapshot(): Readonly<BrcSettings> {
    return structuredClone(this.loaded.settings);
  }

  async ensureConfigFile(): Promise<void> {
    await this.dependencies.lock.runExclusive(async () => {
      const generation = await readGeneration(this.paths);
      if (generation?.state === 'pending') throw new Error('An incomplete configuration transaction requires manual recovery.');
      const current = await readSettings(this.paths, this.env);
      const lastGood = await readLastGoodSettings(this.paths, this.env);
      if (current.rawContents !== null) {
        if (!lastGood) {
          await beginTransaction(this.paths);
          await writeLastGoodText(this.paths, current.rawContents);
          await writeGeneration(this.paths, 'committed');
        } else if (!generation) {
          await writeGeneration(this.paths, 'committed');
        }
        this.loaded = current;
        this.lastGood = lastGood ?? current;
        return;
      }

      await beginTransaction(this.paths);
      const contents = await writeSettings(this.paths, current.fileSettings);
      const initialized = { ...current, rawContents: contents };
      await writeLastGoodText(this.paths, contents);
      await writeGeneration(this.paths, 'committed');
      this.loaded = initialized;
      this.lastGood = initialized;
    });
  }



  async set<K extends BrcSettingKey>(key: K, value: BrcSettingValues[K]): Promise<{ restartRequired: boolean }> {
    if (!isBrcSettingKey(key)) throw new Error(`Unknown setting: ${String(key)}`);
    return this.dependencies.lock.runExclusive(async () => {
      const previous = await readLastGoodSettings(this.paths, this.env) ?? this.lastGood ?? this.loaded;
      let current: LoadedSettings;
      try {
        current = await readSettings(this.paths, this.env);
      } catch (error) {
        if (error instanceof InvalidConfigurationFileError) {
          await beginTransaction(this.paths);
          await this.rollback(previous, error);
        }
        throw error;
      }
      const fileSettings = withSettingValue(current.fileSettings, key, value);
      const next = resolveSettings(fileSettings, this.env);
      await beginTransaction(this.paths);
      const contents = await writeSettings(this.paths, next.fileSettings);
      const nextLoaded = { ...next, rawContents: contents };
      try {
        await this.dependencies.apply(next.settings, previous.settings);
        await writeLastGoodText(this.paths, contents);
      } catch (error) {
        await this.rollback(previous, error, true);
      }
      await writeGeneration(this.paths, 'committed');
      this.loaded = nextLoaded;
      this.lastGood = nextLoaded;
      return { restartRequired: requiresRestart(previous.settings, next.settings) };
    });
  }

  async apply(): Promise<{ restartRequired: boolean }> {
    return this.dependencies.lock.runExclusive(async () => {
      const previous = await readLastGoodSettings(this.paths, this.env) ?? this.lastGood ?? this.loaded;
      let next: LoadedSettings;
      try {
        next = await readSettings(this.paths, this.env);
      } catch (error) {
        if (error instanceof InvalidConfigurationFileError) {
          await beginTransaction(this.paths);
          await this.rollback(previous, error);
        }
        throw error;
      }
      await beginTransaction(this.paths);
      try {
        await this.dependencies.apply(next.settings, previous.settings);
        if (next.rawContents === null) await removeLastGoodFile(this.paths);
        else await writeLastGoodText(this.paths, next.rawContents);
      } catch (error) {
        await this.rollback(previous, error, true);
      }
      await writeGeneration(this.paths, 'committed');
      this.loaded = next;
      this.lastGood = next.rawContents === null ? null : next;
      return { restartRequired: requiresRestart(previous.settings, next.settings) };
    });
  }

  private async rollback(previous: LoadedSettings, cause: unknown, restoreRuntime = false): Promise<never> {
    const failures: unknown[] = [cause];
    if (restoreRuntime) {
      try {
        await this.dependencies.apply(previous.settings, previous.settings);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      if (previous.rawContents === null) {
        await removeConfigFile(this.paths);
        await removeLastGoodFile(this.paths);
      } else {
        await writeConfigText(this.paths, previous.rawContents);
        await writeLastGoodText(this.paths, previous.rawContents);
      }
    } catch (error) {
      failures.push(error);
    }
    this.loaded = previous;
    this.lastGood = previous.rawContents === null ? null : previous;
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Configuration failed and rollback was incomplete.');
    }
    await writeGeneration(this.paths, 'committed');
    throw cause;
  }
}
