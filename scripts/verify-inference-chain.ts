import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { AinLedger, LOCAL_GENESIS, ainReachable } from '../src/ain-ledger.js';
import { identityFromPrivateKey } from '../src/identity.js';
import { canonicalJson, sha256Hex } from '../src/canonical.js';

const provider = process.env.AIN_INFERENCE_TEST_URL!;
assert.match(new URL(provider).hostname, /^(127\.0\.0\.1|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)$/);
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(`${provider}/json-rpc`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, protoVer: '1.0.0' } }),
    signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result?.result ?? body.result;
}

const deadline = Date.now() + 100000;
while (!(await ainReachable(provider))) {
  if (Date.now() > deadline) throw new Error('Isolated chain did not reach SERVING');
  await pause();
}
const identity = identityFromPrivateKey(LOCAL_GENESIS.privateKey);
const ledger = new AinLedger({ providerUrl: provider, chainId: 0 }, identity);
const writeResponses: Record<string, unknown>[] = [];
const setupConfirmations: Record<string, unknown>[] = [];
let settingUp = false;
const send = ledger.ain.provider.send.bind(ledger.ain.provider);
ledger.ain.provider.send = async (method: string, params: unknown) => {
  if (method !== 'ain_sendSignedTransaction') return send(method, params);
  try {
    const response = await send(method, params);
    writeResponses.push({ outcome: 'response', code: response?.result?.code ?? response?.code ?? null,
      operation_codes: Object.values(response?.result?.result_list ?? {}).slice(0, 1000)
        .map(entry => typeof (entry as { code?: unknown })?.code === 'number' ? (entry as { code: number }).code : null),
      tx_hash: response?.tx_hash ?? null });
    if (settingUp && /^0x[a-f0-9]{64}$/i.test(response?.tx_hash ?? '')) {
      const results = response?.result?.result_list ? Object.values(response.result.result_list) : [response?.result];
      if ((response?.result?.code === undefined || response.result.code === 0)
        && results.length && results.every(result => (result as { code?: unknown })?.code === 0)) {
        const setupDeadline = Date.now() + 45000;
        let confirmed = false;
        while (Date.now() < setupDeadline) {
          const transaction = await rpc('ain_getTransactionByHash', { hash: response.tx_hash });
          if (transaction?.is_finalized === true) {
            assert.equal(transaction.is_executed, true);
            const receipt = transaction.receipt;
            assert.ok(receipt && (receipt.code === undefined || receipt.code === 0));
            const operations = receipt.result_list ? Object.values(receipt.result_list) : [receipt];
            assert.ok(operations.length > 0 && operations.every(result => (result as { code?: unknown })?.code === 0));
            setupConfirmations.push({ tx_hash: response.tx_hash, block_number: transaction.number,
              is_executed: transaction.is_executed, is_finalized: transaction.is_finalized, receipt });
            confirmed = true;
            break;
          }
          await pause();
        }
        assert.ok(confirmed, 'Setup transaction must finalize before the next fixture write');
      }
    }
    return response;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    writeResponses.push({ outcome: 'error', code: typeof code === 'number' ? code : null });
    throw error;
  }
};
const Ain = createRequire(import.meta.url)('@ainblockchain/ain-js').default;
const sdk = new Ain(provider, null, 0);
sdk.wallet.addAndSetDefaultAccount(LOCAL_GENESIS.privateKey);
try {
  settingUp = true;
  try { await ledger.setupApp({ stake: 100 }); } finally { settingUp = false; }
  const rulePath = '/apps/knowledge/market/inference_batches/$node/$batch';
  const expectedRule = AinLedger.marketRules().find(([path]) => path === rulePath)![1];
  const rule = await rpc('ain_get', { type: 'GET_RULE', ref: rulePath });
  assert.equal(rule?.['.rule']?.write, expectedRule);
  const receipts = [{ id: 'synthetic-chain-integration-only', model_id: 'fixture/model', completed_at: Date.now() }];
  const batch = { version: 1 as const, model_id: 'fixture/model', request_count: 1,
    started_at: receipts[0].completed_at - 1000, finished_at: receipts[0].completed_at,
    receipt_root: sha256Hex(canonicalJson(receipts)) };
  const submitted = await ledger.noteInferenceBatch(batch);
  assert.ok(submitted, 'Batch submission must be acknowledged');
  let transaction;
  let block;
  const inclusionDeadline = Date.now() + 45000;
  while (Date.now() < inclusionDeadline) {
    transaction = await rpc('ain_getTransactionByHash', { hash: submitted.tx_hash });
    const number = transaction?.number ?? transaction?.block_number;
    if (Number.isSafeInteger(number) && number >= 0) {
      block = await rpc('ain_getBlockByNumber', { number, getFullTransactions: true });
      if (block?.transactions?.some((entry: { hash: string }) => entry.hash === submitted.tx_hash)) break;
    }
    await pause();
  }
  const included = block?.transactions?.find((entry: { hash: string }) => entry.hash === submitted.tx_hash);
  assert.ok(included, 'Transaction must be found in the actual containing block');
  const operation = included.tx_body.operation;
  assert.equal(operation.ref, submitted.path);
  assert.deepEqual(operation.value, { ...batch, node: identity.address });
  assert.deepEqual(await rpc('ain_get', { type: 'GET_VALUE', ref: submitted.path }), operation.value);
  const overwrite = await sdk.db.ref(submitted.path).setValue({ value: operation.value, nonce: -1, gas_price: 0 });
  assert.equal(overwrite.result?.code, 12103, 'Write-once rule must reject another write with a rule-evaluation failure');
  writeFileSync(process.argv[2], JSON.stringify({ scope: 'isolated real-chain integration; synthetic receipt, not inference performance',
    image: process.env.AIN_INFERENCE_TEST_IMAGE, resources: { cpus: 2, memoryBytes: 4294967296, network: 'internal' },
    rulePath, rule, submitted, transaction, block, receipts, overwrite, overwriteRejected: true }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ path: submitted.path, transaction: submitted.tx_hash, block: block.number, overwriteRejected: true }));
} finally {
  try {
    writeFileSync(`${process.argv[2]}.writes.json`, JSON.stringify({ writeResponses, setupConfirmations }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  } finally { await ledger.close(); }
}
