import { lstat, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrcPaths } from '../config/paths.js';
import type { BrcSettings } from '../config/settings.js';
import { ensureRegularFile, ensureSafeDirectory, errorCode, quoteYaml, renderTemplate, sha256File, writeAtomic, type VersionManifest } from './core.js';

export interface TraefikTemplates {
  staticConfig: string;
  dynamicConfig: string;
}

export function renderConfig(
  templates: TraefikTemplates,
  settings: Readonly<BrcSettings>,
  dynamicPath: string,
  configGeneration: string,
  dynamicSettings: Readonly<BrcSettings> = settings,
  staticSettings: Readonly<BrcSettings> = settings,
): TraefikTemplates {
  return {
    dynamicConfig: renderTemplate(templates.dynamicConfig, {
      '@@BRC_RELAY_URL@@': quoteYaml(`http://127.0.0.1:${dynamicSettings.services.relayPort}`),
      '@@BRC_RATE_AVERAGE@@': String(dynamicSettings.proxy.rate.average),
      '@@BRC_RATE_PERIOD@@': quoteYaml(dynamicSettings.proxy.rate.period),
      '@@BRC_RATE_BURST@@': String(dynamicSettings.proxy.rate.burst),
      '@@BRC_CONCURRENT@@': String(dynamicSettings.proxy.concurrent),
      '@@BRC_CONFIG_GENERATION@@': quoteYaml(configGeneration),
    }),
    staticConfig: renderTemplate(templates.staticConfig, {
      '@@BRC_WEB_ADDRESS@@': quoteYaml(`127.0.0.1:${staticSettings.services.proxyPort}`),
      '@@BRC_HEALTH_ADDRESS@@': quoteYaml(`127.0.0.1:${staticSettings.services.healthPort}`),
      '@@BRC_DYNAMIC_FILE@@': quoteYaml(dynamicPath),
    }),
  };
}

export class TraefikOutput {
  constructor(
    private readonly paths: BrcPaths,
    private readonly settings: Readonly<BrcSettings>,
  ) { }

  async writeConfig(
    settings: Readonly<BrcSettings>,
    configGeneration: string,
    dynamicSettings: Readonly<BrcSettings> = settings,
    staticSettings: Readonly<BrcSettings> = settings,
  ): Promise<void> {
    const templates = await this.readTemplates();
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    const configDirectory = path.join(this.paths.traefik, 'config');
    await ensureSafeDirectory(this.paths.root, configDirectory);
    const dynamicPath = path.join(configDirectory, 'dynamic.yml');
    const config = renderConfig(templates, settings, dynamicPath, configGeneration, dynamicSettings, staticSettings);
    await writeAtomic(dynamicPath, config.dynamicConfig);
    await writeAtomic(path.join(configDirectory, 'traefik.yml'), config.staticConfig);
  }

  async writeManifest(manifest: VersionManifest): Promise<void> {
    await ensureSafeDirectory(this.paths.root, this.paths.traefik);
    await writeAtomic(path.join(this.paths.traefik, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }

  async promoteVersion(stage: string, version: string, previous: string | null): Promise<void> {
    const versionsDirectory = path.join(this.paths.traefik, 'versions');
    const targetDirectory = path.join(versionsDirectory, version);
    let promoted = false;
    try {
      await lstat(targetDirectory);
      await ensureSafeDirectory(this.paths.root, targetDirectory);
      const existingExecutable = path.join(targetDirectory, 'traefik.exe');
      await ensureRegularFile(existingExecutable);
      const stagedExecutable = path.join(stage, 'traefik.exe');
      if (await sha256File(existingExecutable) !== await sha256File(stagedExecutable)) {
        throw new Error(`Traefik version directory already contains different files: ${version}`);
      }
      await rm(stage, { recursive: true, force: true });
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      await rename(stage, targetDirectory);
      promoted = true;
    }

    try {
      await this.writeManifest({ version: 1, current: version, previous: previous === version ? null : previous });
    } catch (error) {
      if (promoted) await rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  async executableFor(version: string): Promise<string> {
    const versionDirectory = path.join(this.paths.traefik, 'versions', version);
    await ensureSafeDirectory(this.paths.root, versionDirectory);
    const executable = path.join(versionDirectory, 'traefik.exe');
    await ensureRegularFile(executable);
    return executable;
  }

  async readTemplates(): Promise<TraefikTemplates> {
    const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDirectory, '../../deploy/traefik'),
      path.resolve(moduleDirectory, '../../../../deploy/traefik'),
    ];
    for (const directory of candidates) {
      try {
        return {
          staticConfig: await readFile(path.join(directory, 'traefik.yml'), 'utf8'),
          dynamicConfig: await readFile(path.join(directory, 'dynamic.yml'), 'utf8'),
        };
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
    throw new Error('Traefik deployment templates are missing from the BRC package.');
  }
}
