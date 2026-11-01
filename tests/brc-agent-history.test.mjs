import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'brc-history-'));
process.env.BRC_HOME = path.join(root, 'home');
const { toolHistory } = await import('../packages/agent/dist/core/utils/toolHistory.js');
const { fuzzySearchLogger } = await import('../packages/agent/dist/core/utils/fuzzySearchLogger.js');
const { resolveAgentHome } = await import('../packages/agent/dist/core/config.js');
const { ToolHistoryStorage } = await import('../packages/agent/dist/core/utils/toolHistoryStorage.js');
const file = path.join(resolveAgentHome(process.env), 'tool-history.jsonl');
const output = { content: [{ type: 'text', text: 'ok' }] };

test('history retains failed writes and retries them in order without duplicates', async () => {
  await mkdir(file);
  toolHistory.addCall('first', {}, output);
  await toolHistory.cleanup();
  assert.equal(toolHistory.getStats().queuedWrites, 1);
  toolHistory.addCall('second', {}, output);
  await rm(file, { recursive: true });
  await toolHistory.cleanup();
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.toolName), ['first', 'second']);
  assert.equal(toolHistory.getStats().queuedWrites, 0);
});

test('history caps cache and oversized output while preserving insertion order', async () => {
  for (let i = 0; i < 1001; i++) toolHistory.addCall(`call-${i}`, {}, output);
  toolHistory.addCall('large', {}, { content: [{ type: 'text', text: 'x'.repeat(5000) }] });
  const records = toolHistory.getRecentCalls({ maxResults: 1000 });
  assert.equal(records.length, 1000);
  assert.equal(records[0].toolName, 'call-2');
  assert.match(records.at(-1).output.content[0].text, /output omitted from history/);
  await toolHistory.cleanup();
});

test('history compaction keeps newest complete lines within the target', async () => {
  const line = (n) => JSON.stringify({ n, value: 'x'.repeat(1024 * 1024) });
  await writeFile(file, Array.from({ length: 6 }, (_, i) => line(i)).join('\n') + '\n');
  toolHistory.addCall('after-trim', {}, output);
  await toolHistory.cleanup();
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.slice(0, -1).map(record => record.n), [3, 4, 5]);
  assert.equal(records.at(-1).toolName, 'after-trim');
});

test('history and fuzzy logger share the resolved agent home', async () => {
  assert.equal(toolHistory.getStats().historyFile, file);
  assert.equal(await fuzzySearchLogger.getLogPath(), path.join(resolveAgentHome(process.env), 'logs', 'fuzzy-search.log'));
});

test('storage reads, appends and rewrites JSONL without altering text', async () => {
  const storage = new ToolHistoryStorage(path.join(root, 'storage'));
  assert.equal(storage.readText(), null);
  storage.appendText('{"n":1}\n');
  storage.appendText('{"n":2}\n');
  assert.equal(storage.readText(), '{"n":1}\n{"n":2}\n');
  storage.rewriteText('{"n":2}\n');
  assert.equal(storage.readText(), '{"n":2}\n');
});

test('simultaneous additions retain their order in the persisted queue', async () => {
  await writeFile(file, '');
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => {
    toolHistory.addCall(`parallel-${i}`, {}, output);
  })));
  await toolHistory.cleanup();
  const records = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(record => record.toolName), Array.from({ length: 20 }, (_, i) => `parallel-${i}`));
});

test.after(async () => {
  await toolHistory.cleanup();
  await rm(root, { recursive: true, force: true });
});
