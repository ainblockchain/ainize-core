import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pythonJson, canonicalJson, sha256Hex } from '../src/canonical.js';
import { createIdentity, signMessage, verifyMessage, hashPassword, verifyPassword } from '../src/identity.js';
import { LocalLedger } from '../src/local-ledger.js';
import { recordsFromMarketState } from '../src/ain-ledger.js';
import { deriveCatalog, royaltySplit } from '../src/catalog.js';
import { addressSet, intersectionCount, addressSketch, sketchJaccard } from '../src/npz.js';
import type { PatchAnchor, Attestation, LedgerRecord } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));

test('pythonJson reproduces Python json.dumps(sort_keys=True) formatting', () => {
  const s = pythonJson({ b: [1, 2.5, 'x'], a: { z: true, y: null }, t: 1788136356.1929023 });
  assert.equal(s, '{"a": {"y": null, "z": true}, "b": [1, 2.5, "x"], "t": 1788136356.1929023}');
});

test('canonicalJson is key-order independent', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 1, c: 2 } }), canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
});

test('identity sign/verify round-trip with ain-util', () => {
  const id = createIdentity();
  const msg = sha256Hex('hello');
  const sig = signMessage(msg, id.privateKey);
  assert.ok(verifyMessage(msg, sig, id.address));
  assert.ok(!verifyMessage(msg + '0', sig, id.address));
  assert.ok(verifyPassword('pw', hashPassword('pw')));
  assert.ok(!verifyPassword('nope', hashPassword('pw')));
});

test('LocalLedger appends signed records and imports the prototype chain intact', async () => {
  const id = createIdentity();
  const ledger = new LocalLedger(':memory:', id);
  await ledger.init();
  const n = await ledger.importPrototypeLedger(join(here, '..', '..', 'node', 'fixtures', 'prototype-ledger.jsonl'));
  assert.equal(n, 7);
  const v = await ledger.verify();
  assert.deepEqual(v.errors, []);
  assert.ok(v.valid);
  const anchor: PatchAnchor = {
    id: 'p1', name: 'P1', description: 'd', author: id.address, model: { id_M: 'M' }, patch_sha256: 'ab', size_bytes: 1, rows: 1,
    benchmark: { schema: 's', queries: 1, format: ['t'] }, benchmark_hash: 'bh', price: '1', currency: 'CREDIT', billing: 'per_download',
    parents: [], parent_authors: [], topic_path: 'x', created_at: Date.now(),
  };
  const rec = await ledger.append('anchor', anchor);
  assert.ok(LocalLedger.validate(rec));
  // tamper
  const bad: LedgerRecord = { ...rec, body: { ...anchor, price: '0' } };
  assert.ok(!LocalLedger.validate(bad));
  const other = new LocalLedger(':memory:', createIdentity());
  await other.init();
  await assert.rejects(other.ingest(bad));
  assert.equal(await other.ingest(rec), true);
  assert.equal(await other.ingest(rec), false);
  assert.equal((await other.anchors()).length, 1);
});

test('catalog status machine and royalty split', () => {
  const mk = (id: string, parents: string[], author: string): LedgerRecord<PatchAnchor> => ({
    hash: id, kind: 'anchor', author, ts: 1, parents: [], sig: '',
    body: { id, name: id, description: '', author, model: { id_M: 'M' }, patch_sha256: id, size_bytes: 1, rows: 1,
      benchmark: { schema: 's', queries: 1, format: [] }, benchmark_hash: 'h', price: '10', currency: 'CREDIT', billing: 'per_download',
      parents, parent_authors: [], topic_path: 't', created_at: 1 },
  });
  const at = (pid: string, v: string, passed = true): LedgerRecord<Attestation> => ({
    hash: pid + v, kind: 'attest', author: v, ts: 2, parents: [], sig: '',
    body: { patch_id: pid, verifier: v, patch_sha256: pid, benchmark_hash: 'h', score: {}, passed, verified_on: 'test', stake: '1', sig: '', created_at: 2 },
  });
  const cat = deriveCatalog(
    [mk('a', [], 'A'), mk('b', ['a'], 'B'), mk('c', ['b'], 'C')],
    [at('a', 'v1'), at('a', 'v2'), at('b', 'v1'), at('c', 'v1', false), at('c', 'v2', false)],
    [], [], [], 2,
  );
  const m = new Map(cat.map((e) => [e.anchor.id, e]));
  assert.equal(m.get('a')!.status, 'LISTED');
  assert.equal(m.get('b')!.status, 'VERIFYING');
  assert.equal(m.get('c')!.status, 'REJECTED');
  assert.deepEqual(m.get('a')!.children, ['b']);
  const split = royaltySplit(m.get('c')!, m, 10, 0.3);
  assert.equal(split['C'], '7');
  assert.equal(split['B'], '1.5');
  assert.equal(split['A'], '1.5');
});

test('address set intersection and sketch', () => {
  const a = addressSet(BigInt64Array.from([5n, 1n, 3n, 3n, 9n]));
  const b = addressSet(BigInt64Array.from([3n, 9n, 11n]));
  assert.equal(intersectionCount(a, b), 2);
  const sa = addressSketch(a, 8), sb = addressSketch(b, 8);
  assert.ok(sketchJaccard(sa, sb) > 0);
});

test('AIN market state → records: supersede/subscribe values without created_at are dated after the related attest/branch (never ts=0)', () => {
  const market = {
    patches: { a: { id: 'a', patch_sha256: 'x', author: '0xA', created_at: 1000 }, b: { id: 'b', patch_sha256: 'y', author: '0xB', created_at: 2000 } },
    attestations: { b: { '0xV': { patch_id: 'b', verifier: '0xV', passed: true, created_at: 3000 } } },
    branches: { law_KR: { name: 'law/KR', owner: '0xA', context: { jurisdiction: 'KR' }, created_at: 1500 } },
    supersedes: { a: { b: { old_patch_id: 'a', new_patch_id: 'b', overlap_rows: 5, reason: 'r' } } },
    subscriptions: { '0xN': { law_KR: { node: '0xN', branch: 'law/KR', action: 'subscribe' } } },
  };
  const recs = recordsFromMarketState(market);
  assert.deepEqual(recs.map((r) => `${r.kind}@${r.ts}`), ['anchor@1000', 'branch@1500', 'subscribe@1501', 'anchor@2000', 'attest@3000', 'supersede@3001']);
  assert.equal(recs.find((r) => r.kind === 'supersede')!.author, '0xB', 'a supersede is attributed to the author of the newer patch');
  assert.equal(recs.find((r) => r.kind === 'subscribe')!.author, '0xN');
  // an explicit created_at (new records) wins over the fallback
  (market.supersedes.a.b as { created_at?: number }).created_at = 5000;
  (market.subscriptions['0xN'].law_KR as { created_at?: number }).created_at = 6000;
  const fresh = recordsFromMarketState(market);
  assert.equal(fresh.find((r) => r.kind === 'supersede')!.ts, 5000);
  assert.equal(fresh.find((r) => r.kind === 'subscribe')!.ts, 6000);
  // a supersede whose new patch is unknown still gets a record (ts 0 = unknown), and records rebuild identically (stable hashes)
  const orphan = recordsFromMarketState({ supersedes: { a: { zz: { old_patch_id: 'a', new_patch_id: 'zz', overlap_rows: 1, reason: 'r' } } } });
  assert.equal(orphan.length, 1); assert.equal(orphan[0].ts, 0);
  assert.deepEqual(recordsFromMarketState(market).map((r) => r.hash), fresh.map((r) => r.hash));
});
