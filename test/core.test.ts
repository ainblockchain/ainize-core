import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pythonJson, canonicalJson, sha256Hex } from '../src/canonical.js';
import { createIdentity, signMessage, verifyMessage, hashPassword, verifyPassword } from '../src/identity.js';
import { LocalLedger } from '../src/local-ledger.js';
import { deriveCatalog, royaltySplit, sanitizeContributors, validateContributors, validatePrice, ValidationError } from '../src/catalog.js';
import { toAin, fromAin, withEmptyArrays, recordsFromMarketState } from '../src/ain-ledger.js';
import { DEFAULT_TEACH_CONFIG, defaultConfig, loadConfig, saveConfig, teachConfig } from '../src/config.js';
import { addressSet, intersectionCount, addressSketch, sketchJaccard } from '../src/npz.js';
import type { PatchAnchor, Attestation, Contributor, LedgerRecord } from '../src/types.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

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

// ---------------------------------------------------------------- teach mode: contributors + royalty (spec §7.1–7.4)
const TEACHER = '0x' + 'a'.repeat(40);
const TEACHER2 = '0x' + 'b'.repeat(40);
const mkEntry = (id: string, parents: string[], author: string, contributors?: Contributor[]) => ({
  anchor: { id, name: id, description: '', author, model: { id_M: 'M' }, patch_sha256: id, size_bytes: 1, rows: 1,
    benchmark: { schema: 's', queries: 1, format: [] }, benchmark_hash: 'h', price: '10', currency: 'CREDIT' as const, billing: 'per_download' as const,
    parents, parent_authors: [], topic_path: 't', created_at: 1, contributors } as PatchAnchor,
  status: 'LISTED' as const, attestations: [], passed: 2, integrity_checks: 0, quorum: 2, quorum_ok: true, settlements: [], downloads: 0, revenue: '0',
  challenges: [], superseded_by: [], supersedes: [], children: [], record_hash: '',
});
const teacher = (address: string, share: number): Contributor => ({ address, share, role: 'data_provider', proof: 'signed', sig: 'x' });

test('royaltySplit pass 2: no parents → {teacher: 7, node: 3} (price 10, contributor 0.7)', () => {
  const lesson = mkEntry('lesson', [], 'node', [teacher(TEACHER, 0.7)]);
  const m = new Map([['lesson', lesson]]);
  assert.deepEqual(royaltySplit(lesson, m, 10, 0.3), { [TEACHER]: '7', node: '3' });
});

test('royaltySplit pass 1 + 2: one foreign parent → {parent-node: 3, teacher: 4.9, node: 2.1}', () => {
  const parent = mkEntry('parent', [], 'parent-node');
  const lesson = mkEntry('lesson', ['parent'], 'node', [teacher(TEACHER, 0.7)]);
  const m = new Map([['parent', parent], ['lesson', lesson]]);
  assert.deepEqual(royaltySplit(lesson, m, 10, 0.3), { 'parent-node': '3', [TEACHER]: '4.9', node: '2.1' });
});

test('royaltySplit pass 1b: a taught ancestor shares its lineage slice with its data provider (claim 21)', () => {
  const taught = mkEntry('taught', [], 'parent-node', [teacher(TEACHER, 0.7)]);
  const child = mkEntry('child', ['taught'], 'node');
  const m = new Map([['taught', taught], ['child', child]]);
  // pool 3 → taught slice 3 → teacher 2.1, parent-node 0.9; seller keeps 7
  assert.deepEqual(royaltySplit(child, m, 10, 0.3), { [TEACHER]: '2.1', 'parent-node': '0.9', node: '7' });
});

test('royaltySplit: contributor equal to the seller is skipped, share 0 yields no payout line, several contributors carve sequentially', () => {
  const selfTaught = mkEntry('self', [], 'node', [teacher('node', 0.7)]);
  assert.deepEqual(royaltySplit(selfTaught, new Map([['self', selfTaught]]), 10, 0.3), { node: '10' });
  const credited = mkEntry('credit', [], 'node', [teacher(TEACHER, 0)]);
  assert.deepEqual(royaltySplit(credited, new Map([['credit', credited]]), 10, 0.3), { node: '10' });
  const two = mkEntry('two', [], 'node', [teacher(TEACHER, 0.5), teacher(TEACHER2, 0.5)]);
  // 10 → teacher 5, remainder 5 → teacher2 2.5, node 2.5
  assert.deepEqual(royaltySplit(two, new Map([['two', two]]), 10, 0.3), { [TEACHER]: '5', [TEACHER2]: '2.5', node: '2.5' });
});

test('royaltySplit: the seller-as-contributor skip is case-insensitive in both passes (spec §7.3)', () => {
  const SELLER = '0xAbCdEf0000000000000000000000000000000001';
  const selfLower = mkEntry('self', [], SELLER, [teacher(SELLER.toLowerCase(), 0.7)]);
  assert.deepEqual(royaltySplit(selfLower, new Map([['self', selfLower]]), 10, 0.3), { [SELLER]: '10' }, 'pass 2: no split of the seller into two keys');
  const taught = mkEntry('taught', [], 'parent-node', [teacher('PARENT-NODE', 0.7)]);
  const child = mkEntry('child', ['taught'], 'node');
  assert.deepEqual(royaltySplit(child, new Map([['taught', taught], ['child', child]]), 10, 0.3), { 'parent-node': '3', node: '7' }, 'pass 1b: author-as-contributor folds back');
});

test('royaltySplit never pays out more than the sale: unvalidated peer anchors with share > 1 / junk entries are clamped (payout integrity)', () => {
  const EVIL = '0xEeEe000000000000000000000000000000000001';
  const foreign = mkEntry('foreign', [], 'other-node', [{ address: EVIL, share: 5, role: 'data_provider', proof: 'declared' }]);
  const mine = mkEntry('mine', ['foreign'], 'node');
  const m = new Map([['foreign', foreign], ['mine', mine]]);
  const split = royaltySplit(mine, m, 10, 0.3);
  const total = Object.values(split).reduce((a, b) => a + Number(b), 0);
  assert.equal(total, 10); assert.equal(split[EVIL], '3'); assert.equal(split.node, '7');
  // pass 2 with a hostile share on the sold anchor itself, plus a junk entry
  const sold = mkEntry('sold', [], 'node', [{ address: EVIL, share: 7, role: 'data_provider', proof: 'declared' }, { address: 12 as unknown as string, share: 0.5 } as unknown as Contributor]);
  const s2 = royaltySplit(sold, new Map([['sold', sold]]), 10, 0.3);
  assert.deepEqual(s2, { [EVIL]: '10', node: '0' });
  assert.deepEqual(sanitizeContributors([{ address: EVIL, share: 5 }]), undefined, 'malformed list → treated as no contributors');
  assert.deepEqual(sanitizeContributors(undefined), undefined);
  assert.equal(sanitizeContributors([{ address: EVIL, share: 0.2 }])!.length, 1);
  assert.throws(() => validateContributors([{ address: EVIL, share: 2 }]), ValidationError);
  assert.equal(validatePrice('0.1'), '0.1'); assert.equal(validatePrice('25'), '25');
  assert.throws(() => validatePrice('-5'), ValidationError); assert.throws(() => validatePrice('abc'), ValidationError); assert.throws(() => validatePrice(5), ValidationError);
});

test('royaltySplit: the pre-teach behaviour is unchanged for anchors without contributors', () => {
  const a = mkEntry('a', [], 'A'), b = mkEntry('b', ['a'], 'B'), c = mkEntry('c', ['b'], 'C');
  const m = new Map([['a', a], ['b', b], ['c', c]]);
  assert.deepEqual(royaltySplit(c, m, 10, 0.3), { A: '1.5', B: '1.5', C: '7' });
  assert.deepEqual(royaltySplit(a, m, 10, 0.3), { A: '10' });
});

test('validateContributors: Σ share > 1, more than 4 entries, duplicates and bad addresses are rejected', () => {
  assert.throws(() => validateContributors([teacher(TEACHER, 0.6), teacher(TEACHER2, 0.5)]), /more than 1/);
  assert.throws(() => validateContributors(Array.from({ length: 5 }, (_, i) => teacher('0x' + String(i).repeat(40), 0.1))), /at most 4/);
  assert.throws(() => validateContributors([teacher(TEACHER, 0.1), teacher(TEACHER.toUpperCase().replace('0X', '0x'), 0.1)]), /duplicate/);
  assert.throws(() => validateContributors([teacher('teacher', 0.1)]), /address/);
  assert.throws(() => validateContributors([{ ...teacher(TEACHER, 0.1), share: 1.5 }]), /share/);
  assert.throws(() => validateContributors([{ ...teacher(TEACHER, 0.1), name: 'x'.repeat(41) }]), /name/);
  assert.deepEqual(validateContributors(undefined), []);
  const ok = validateContributors([{ address: TEACHER, share: 0.7, name: ' Kim ', signer: TEACHER2 }]);
  assert.deepEqual(ok, [{ address: TEACHER, share: 0.7, role: 'data_provider', proof: 'declared', name: 'Kim', signer: TEACHER2 }]);
});

test('ain-ledger round-trip: contributors [] and a 1-entry array survive toAin/fromAin/withEmptyArrays', () => {
  const base = { id: 'p', author: 'node', patch_sha256: 'sha', parents: [] as string[], parent_authors: [] as string[], benchmark: { schema: 's', queries: 1, format: [] as string[] }, price: '1' };
  const empty = withEmptyArrays(fromAin(JSON.parse(JSON.stringify(toAin({ ...base, contributors: [] })))) as PatchAnchor);
  assert.deepEqual(empty.contributors, []);
  assert.deepEqual(empty.parents, []);
  const legacy = withEmptyArrays(fromAin(JSON.parse(JSON.stringify(toAin(base)))) as PatchAnchor);
  assert.deepEqual(legacy.contributors, [], 'anchors written before teach mode read as an empty list, never undefined');
  const one = withEmptyArrays(fromAin(JSON.parse(JSON.stringify(toAin({ ...base, contributors: [teacher(TEACHER, 0.7)] })))) as PatchAnchor);
  assert.deepEqual(one.contributors, [teacher(TEACHER, 0.7)]);
  assert.equal(typeof one.contributors![0].share, 'number');
  const five = withEmptyArrays({ ...base, contributors: Array.from({ length: 5 }, (_, i) => teacher('0x' + String(i).repeat(40), 0.1)) } as PatchAnchor);
  assert.equal(five.contributors!.length, 4, 'capped at 4 on read');
});

test('config: teach defaults (disabled, review, gradient) and loadConfig fills a pre-teach config.json', () => {
  const cfg = defaultConfig({ home: join(tmpdir(), 'x') });
  assert.equal(cfg.teach!.enabled, false);
  assert.equal(cfg.teach!.publish, 'review');
  assert.equal(cfg.teach!.backend, 'gradient');
  assert.equal(cfg.teach!.contributorShare, 0.7);
  assert.equal(cfg.market.royaltyShare, 0.3);
  assert.equal(cfg.teach!.locality.prompts.length, 12);
  const home = mkdtempSync(join(tmpdir(), 'ngram-cfg-'));
  try {
    const { teach: _t, ...old } = cfg;
    saveConfig({ ...old, dataDir: join(home, 'data') } as typeof cfg, home);
    const loaded = loadConfig(home)!;
    assert.deepEqual(loaded.teach, DEFAULT_TEACH_CONFIG);
    const partial = teachConfig({ teach: { enabled: true, backend: 'stub', trainer: { gpus: '0' } } as never });
    assert.equal(partial.enabled, true);
    assert.equal(partial.backend, 'stub');
    assert.equal(partial.trainer.gpus, '0');
    assert.equal(partial.trainer.container, 'flashtrain');
    assert.equal(partial.publish, 'review');
  } finally { rmSync(home, { recursive: true, force: true }); }
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
