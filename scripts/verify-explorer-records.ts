import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const directory = process.argv[2];
const endpoint = new URL(process.env.AINSCAN_TEST_URL!);
assert.equal(endpoint.hostname, '127.0.0.1');
const training = JSON.parse(readFileSync(join(directory, 'training-state.json'), 'utf8'));
const inference = JSON.parse(readFileSync(join(directory, 'evidence.json'), 'utf8'));
const writes = JSON.parse(readFileSync(join(directory, 'evidence.json.writes.json'), 'utf8'));
const multiOperationSetup = writes.setupConfirmations.filter((entry: { receipt?: { result_list?: unknown } }) => entry.receipt?.result_list);
assert.ok(multiOperationSetup.length >= 2, 'Fixture must retain actual multi-operation setup receipts');
for (const entry of multiOperationSetup) {
  assert.equal(entry.is_executed, true);
  assert.equal(entry.is_finalized, true);
  assert.ok(Object.values(entry.receipt.result_list).every(value => (value as { code: number }).code === 0));
}
const pause = () => new Promise(resolve => setTimeout(resolve, 1000));
const provider = new URL(process.env.AIN_INFERENCE_TEST_URL!);
assert.match(provider.hostname, /^(127\.0\.0\.1|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]+\.[0-9]+|10\.[0-9]+\.[0-9]+\.[0-9]+|192\.168\.[0-9]+\.[0-9]+)$/);
const directResponse = await fetch(new URL('/json-rpc', provider), { method: 'POST',
  headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ain_getBlockByNumber', params: { number: 0, getFullTransactions: true, protoVer: '1.0.0' } }) });
assert.equal(directResponse.status, 200);
const directBody = await directResponse.json();
const expectedGenesis = directBody.result?.result ?? directBody.result;
assert.match(expectedGenesis?.hash, /^0x[a-f0-9]{64}$/i);
let ready = false;
const deadline = Date.now() + 45000;
while (Date.now() < deadline) {
  try {
    const response = await fetch(new URL('/api/rpc', endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ method: 'ain_getBlockByNumber', params: { number: 0, getFullTransactions: true } }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const genesis = body.result?.result ?? body.result;
    assert.equal(genesis?.number, 0);
    assert.match(genesis?.hash, /^0x[a-f0-9]{64}$/i);
    assert.equal(genesis.hash, expectedGenesis.hash);
    ready = true;
    break;
  } catch { await pause(); }
}
assert.ok(ready, 'Production explorer must answer native RPC');
const lesson = training.transactions[0];
assert.equal(lesson.info.is_finalized, true);
assert.equal(lesson.info.receipt.code, 0);
const operation = lesson.block.transactions.find((entry: { hash: string }) => entry.hash === lesson.tx_hash).tx_body.operation;
const latency = lesson.block.timestamp - operation.value.submitted_at;
assert.ok(Number.isSafeInteger(latency) && latency >= 0);
const routes = [
  { name: 'knowledge', path: `/knowledge?publisher=${training.publisher}`,
    expected: ['Training Records', 'Inference', operation.value.dataset_id, operation.value.model_id, 'fixture/model', 'Auto-refresh (15s)'] },
  { name: 'transactions', path: '/transactions', expected: ['Native Records', lesson.tx_hash, inference.submitted.tx_hash, 'Training writes', 'Inference batches'] },
  { name: 'block', path: `/blocks/${lesson.block.number}`, expected: ['Native Records', lesson.tx_hash, operation.value.dataset_id, 'SET_VALUE'] },
  { name: 'transaction', path: `/transactions/${lesson.tx_hash}`, expected: ['Training Record Latency', `${latency.toLocaleString('en-US')} ms`, 'Succeeded', 'Finalized', operation.value.dataset_id, operation.value.model_id] },
  { name: 'inference-transaction', path: `/transactions/${inference.submitted.tx_hash}`, expected: ['Inference Model (reported)', 'fixture/model', 'Inference Requests / Second (reported)', 'Receipt Commitment (unverified)', 'Succeeded', 'Finalized'] },
  ...multiOperationSetup.map((entry: { tx_hash: string }, index: number) => ({
    name: `multi-operation-${index}`, path: `/transactions/${entry.tx_hash}`,
    expected: ['Execution Receipt', 'Succeeded', 'Finalized', 'result_list'],
  })),
];
const checked = [];
for (const route of routes) {
  const response = await fetch(new URL(route.path, endpoint), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, route.name);
  const html = await response.text();
  const rendered = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  for (const expected of route.expected) assert.ok(rendered.includes(expected), `${route.name}: missing ${expected}`);
  assert.ok(!html.includes('href="/experiments'), 'No experiments navigation');
  writeFileSync(join(directory, `explorer-${route.name}.html`), html, { flag: 'wx', mode: 0o600 });
  checked.push({ route: route.path, expected: route.expected, status: response.status });
}
const result = { scope: 'Actual production Next server and isolated chain with synthetic records; no workload performance or public deployment claim',
  buildId: process.env.AINSCAN_TEST_BUILD_ID, genesisHash: expectedGenesis.hash, publisher: training.publisher,
  trainingTransaction: lesson.tx_hash, inferenceTransaction: inference.submitted.tx_hash, latencyMs: latency, checked };
writeFileSync(join(directory, 'explorer-records.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(result));
