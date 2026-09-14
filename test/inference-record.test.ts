import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInferenceBatch, type InferenceBatch } from '../src/inference-record.js';
import { AinLedger } from '../src/ain-ledger.js';

const batch: InferenceBatch = { version: 1, model_id: 'owner/model', request_count: 120, started_at: 1000, finished_at: 2000, receipt_root: 'a'.repeat(64) };

test('inference batches reject private fields, empty roots and invalid denominators', () => {
  assert.deepEqual(validateInferenceBatch(batch), batch);
  for (const changes of [{ prompt: 'private' }, { request_count: 0 }, { finished_at: 1000 }, { finished_at: 8640000000000001 }, { receipt_root: '' }, { model_id: '' }]) {
    assert.throws(() => validateInferenceBatch({ ...batch, ...changes }));
  }
});

test('batch paths are content-addressed and return only acknowledged chain writes', async () => {
  const writes: { path: string; value: unknown }[] = [];
  const ledger = { identity: { address: 'node' }, set: async (path: string, value: unknown) => { writes.push({ path, value }); return 'transaction'; } } as unknown as AinLedger;
  const first = await AinLedger.prototype.noteInferenceBatch.call(ledger, batch);
  const second = await AinLedger.prototype.noteInferenceBatch.call(ledger, { ...batch });
  assert.equal(first?.path, second?.path);
  assert.match(first!.path, /^\/apps\/knowledge\/market\/inference_batches\/node\/[a-f0-9]{64}$/);
  assert.deepEqual(writes[0].value, { ...batch, node: 'node' });
  const failed = { identity: { address: 'node' }, set: async () => { throw new Error('offline'); } } as unknown as AinLedger;
  assert.equal(await AinLedger.prototype.noteInferenceBatch.call(failed, batch), null);
});

test('batch authorization is node-bound and write-once', () => {
  const rule = AinLedger.marketRules().find(([path]) => path === '/apps/knowledge/market/inference_batches/$node/$batch');
  assert.ok(rule);
  const accepts = new Function('auth', 'data', 'newData', '$node', 'util', `return (${rule[1]});`);
  const util = { isDict: (value: unknown) => value !== null && typeof value === 'object' && !Array.isArray(value) };
  assert.equal(accepts({ addr: 'node' }, null, { ...batch, node: 'node' }, 'node', util), true);
  assert.equal(accepts({ addr: 'other' }, null, { ...batch, node: 'node' }, 'node', util), false);
  assert.equal(accepts({ addr: 'node' }, {}, { ...batch, node: 'node' }, 'node', util), false);
});
