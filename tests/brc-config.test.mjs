import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../packages/cli/dist/config/settings.js';

test('central settings defaults match the public configuration contract', () => {
  assert.deepEqual(DEFAULT_SETTINGS, {
    version: 1,
    proxy: {
      rate: { average: 10, period: '1s', burst: 30 },
      concurrent: 16,
    },
    services: {
      relayPort: 3000,
      proxyPort: 13001,
      healthPort: 13002,
    },
    logs: {
      retentionDays: 7,
      maxTotalMiB: 50,
      rotateMiB: 4,
    },
    runtime: {
      startupTimeoutMs: 15_000,
      shutdownTimeoutMs: 3_000,
    },
  });
});
