import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolatedEnvironment, summarize, isAllowedPort } from '../scripts/benchmark-cli-helpers.mjs';

test('benchmark environment excludes inherited service and runtime configuration', () => {
  const env = isolatedEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'tools', BRC_DB: 'production', PUBLIC_URL: 'https://production', NODE_OPTIONS: '--require bad', HOME: 'production' }, 'scratch', [41001, 41002, 41003]);
  assert.equal(env.BRC_DB, undefined);
  assert.equal(env.PUBLIC_URL, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.HOME, 'scratch');
  assert.equal(env.BRC_DATA_ROOT, 'scratch');
  assert.equal(env.BRC_RELAY_PORT, '41001');
});

test('benchmark excludes production ports and calculates nearest-rank p95', () => {
  assert.equal(isAllowedPort(3000, []), false);
  assert.equal(isAllowedPort(13001, []), false);
  assert.equal(isAllowedPort(13002, []), false);
  assert.equal(isAllowedPort(41001, [41001]), false);
  assert.deepEqual(summarize([5, 1, 3, 2, 4]), { samplesMs: [5, 1, 3, 2, 4], medianMs: 3, p95Ms: 5 });
});
