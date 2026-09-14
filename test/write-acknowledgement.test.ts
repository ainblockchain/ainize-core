import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AinLedger, LOCAL_GENESIS } from '../src/ain-ledger.js';
import { identityFromPrivateKey } from '../src/identity.js';

const hash = `0x${'a'.repeat(64)}`;
const batch = { version: 1 as const, model_id: 'fixture/model', request_count: 1,
  started_at: 1000, finished_at: 2000, receipt_root: 'b'.repeat(64) };

test('native lesson and inference records require a valid hash and successful write response', async () => {
  const ledger = new AinLedger({ providerUrl: 'http://127.0.0.1:1', chainId: 0 }, identityFromPrivateKey(LOCAL_GENESIS.privateKey));
  const rejected = [undefined, null, {}, { tx_hash: hash }, { result: { code: 0 } },
    { tx_hash: '', result: { code: 0 } }, { tx_hash: 'not-a-hash', result: { code: 0 } },
    { tx_hash: hash, result: { code: 12103 } }, { tx_hash: hash, result: { code: '0' } },
    { tx_hash: hash, result: { result_list: {} } },
    { tx_hash: hash, result: { result_list: [] } },
    { tx_hash: hash, result: { result_list: { '0': null } } },
    { tx_hash: hash, result: { result_list: { '0': {} } } },
    { tx_hash: hash, result: { result_list: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index, { code: 0 }])) } },
    { tx_hash: hash, result: { result_list: { '0': { code: 0 }, '1': { code: 10201 } } } },
    { tx_hash: hash, result: { result_list: { '0': { result_list: { '0': { code: 12103 } } } } } },
    { tx_hash: hash, result: { code: 0, result_list: { '0': { code: 12103 } } } }];
  try {
    for (const response of rejected) {
      ledger.ain.db.ref = () => ({ setValue: async () => response });
      assert.equal(await ledger.noteLesson('job', { status: 'TRAINING' }), null, JSON.stringify(response));
      assert.equal(await ledger.noteInferenceBatch(batch), null, JSON.stringify(response));
    }
    for (const result of [{ code: 0 }, { result_list: { '0': { code: 0 }, '1': { code: 0 } } },
      { result_list: { '0': { result_list: { '0': { code: 0 } } } } }]) {
      ledger.ain.db.ref = () => ({ setValue: async () => ({ tx_hash: hash, result }) });
      assert.equal((await ledger.noteLesson('job', { status: 'TRAINING' }))?.tx_hash, hash);
      assert.equal((await ledger.noteInferenceBatch(batch))?.tx_hash, hash);
    }
  } finally { await ledger.close(); }
});
