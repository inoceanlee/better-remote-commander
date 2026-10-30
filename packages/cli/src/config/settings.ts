export interface BrcSettings {
  version: 1;
  proxy: {
    rate: {
      average: number;
      period: string;
      burst: number;
    };
    concurrent: number;
  };
  services: {
    relayPort: number;
    proxyPort: number;
    healthPort: number;
  };
  logs: {
    retentionDays: number;
    maxTotalMiB: number;
    rotateMiB: number;
  };
  runtime: {
    startupTimeoutMs: number;
    shutdownTimeoutMs: number;
  };
}

export interface BrcSettingValues {
  'proxy.rate.average': number;
  'proxy.rate.period': string;
  'proxy.rate.burst': number;
  'proxy.concurrent': number;
  'services.relayPort': number;
  'services.proxyPort': number;
  'services.healthPort': number;
  'logs.retentionDays': number;
  'logs.maxTotalMiB': number;
  'logs.rotateMiB': number;
  'runtime.startupTimeoutMs': number;
  'runtime.shutdownTimeoutMs': number;
}

export type BrcSettingKey = keyof BrcSettingValues;
export type BrcSettingSource = 'environment' | 'file' | 'default';
export type BrcSettingSources = Readonly<Record<BrcSettingKey, BrcSettingSource>>;

export const BRC_SETTING_KEYS = [
  'proxy.rate.average',
  'proxy.rate.period',
  'proxy.rate.burst',
  'proxy.concurrent',
  'services.relayPort',
  'services.proxyPort',
  'services.healthPort',
  'logs.retentionDays',
  'logs.maxTotalMiB',
  'logs.rotateMiB',
  'runtime.startupTimeoutMs',
  'runtime.shutdownTimeoutMs',
] as const satisfies readonly BrcSettingKey[];

export const SETTING_ENVIRONMENT_KEYS: Readonly<Record<BrcSettingKey, string>> = Object.freeze({
  'proxy.rate.average': 'BRC_PROXY_RATE_AVERAGE',
  'proxy.rate.period': 'BRC_PROXY_RATE_PERIOD',
  'proxy.rate.burst': 'BRC_PROXY_RATE_BURST',
  'proxy.concurrent': 'BRC_PROXY_CONCURRENT',
  'services.relayPort': 'BRC_RELAY_PORT',
  'services.proxyPort': 'BRC_TRAEFIK_PORT',
  'services.healthPort': 'BRC_TRAEFIK_HEALTH_PORT',
  'logs.retentionDays': 'BRC_LOG_RETENTION_DAYS',
  'logs.maxTotalMiB': 'BRC_LOG_MAX_TOTAL_MIB',
  'logs.rotateMiB': 'BRC_LOG_ROTATE_MIB',
  'runtime.startupTimeoutMs': 'BRC_RUNTIME_STARTUP_TIMEOUT_MS',
  'runtime.shutdownTimeoutMs': 'BRC_RUNTIME_SHUTDOWN_TIMEOUT_MS',
});

export const DEFAULT_SETTINGS: Readonly<BrcSettings> = Object.freeze({
  version: 1,
  proxy: Object.freeze({
    rate: Object.freeze({ average: 10, period: '1s', burst: 30 }),
    concurrent: 16,
  }),
  services: Object.freeze({ relayPort: 3000, proxyPort: 13001, healthPort: 13002 }),
  logs: Object.freeze({ retentionDays: 7, maxTotalMiB: 50, rotateMiB: 4 }),
  runtime: Object.freeze({ startupTimeoutMs: 15_000, shutdownTimeoutMs: 3_000 }),
});
