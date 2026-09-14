import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { AinLedger, LOCAL_GENESIS } from '../src/ain-ledger.js';
import { identityFromPrivateKey } from '../src/identity.js';

const provider = process.env.AIN_INFERENCE_TEST_URL!;
assert.match(new URL(provider).hostname, /^(127\.0\.0\.1|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)$/);
const identity = identityFromPrivateKey(LOCAL_GENESIS.privateKey);
const ledger = new AinLedger({ providerUrl: provider, chainId: 0 }, identity);
async function rpc(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${provider}/json-rpc`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { protoVer: '1.0.0', ...params } }), signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined);
  assert.ok(body.result?.code === undefined || body.result.code === 0);
  return body.result && 'result' in body.result ? body.result.result : body.result;
}
try {
  const transactions = [];
  for (let index = 0; index < 3; index++) {
    const value = { status: index === 2 ? 'READY' : 'TRAINING', dataset_id: `fixture-dataset-${index % 2}`,
      model_id: `fixture/model-${index % 2}`, rows: 1, submitted_at: Date.now() };
    const submitted = await ledger.noteLesson(`fixture-job-${index}`, value);
    assert.ok(submitted);
    let info;
    const deadline = Date.now() + 60000;
    do {
      info = await rpc('ain_getTransactionByHash', { hash: submitted.tx_hash });
      if (info?.is_finalized === true && info?.is_executed === true) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    assert.equal(info?.is_finalized, true);
    assert.equal(info?.receipt?.code, 0);
    const block = await rpc('ain_getBlockByNumber', { number: info.number, getFullTransactions: true });
    const transaction = block.transactions.find((entry: { hash: string }) => entry.hash === submitted.tx_hash);
    assert.equal(transaction?.tx_body.operation.ref, submitted.path);
    for (const [key, expected] of Object.entries(value)) assert.equal(transaction.tx_body.operation.value[key], expected);
    transactions.push({ ...submitted, info, block });
  }
  const root = '/apps/knowledge/market/lessons';
  const publishers = await rpc('ain_get', { type: 'GET_VALUE', ref: root, is_shallow: true });
  assert.equal(typeof publishers?.[identity.address]?.['#state_ph'], 'string');
  const state = await rpc('ain_get', { type: 'GET_VALUE', ref: `${root}/${identity.address}` });
  assert.equal(Object.keys(state).length, 3);
  writeFileSync(process.argv[2], JSON.stringify({ scope: 'Real isolated chain with synthetic lessons; not training or concurrency proof',
    publisher: identity.address, publishers, state, transactions }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ lessons: 3, publisher: identity.address, finalized: transactions.length }));
} finally { await ledger.close(); }
