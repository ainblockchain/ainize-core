import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pythonJson, canonicalJson, sha256Hex } from '../src/canonical.js';
import { createIdentity, signMessage, verifyMessage, hashPassword, verifyPassword } from '../src/identity.js';
import { LocalLedger } from '../src/local-ledger.js';
import { deriveCatalog, royaltyPlan, royaltySplit, sanitizeContributors, validateContributors, validatePrice, ValidationError, verificationCount } from '../src/catalog.js';
import { toAin, fromAin, withEmptyArrays, recordsFromMarketState } from '../src/ain-ledger.js';
import { DEFAULT_TEACH_CONFIG, defaultConfig, loadConfig, saveConfig, teachConfig } from '../src/config.js';
import { addressSet, intersectionCount, addressSketch, sketchJaccard } from '../src/npz.js';
import { PATCH_STATUSES, parseStatus } from '../src/types.js';
import { delegateHeader, delegateMessage, parseDelegation, verifyDelegation } from '../src/teach-auth.js';
import type { PatchAnchor, Attestation, Challenge, Contributor, LedgerRecord } from '../src/types.js';
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
  const n = await ledger.importPrototypeLedger(join(here, 'fixtures', 'prototype-ledger.jsonl'));
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
  assert.equal(m.get('a')!.status, 'VERIFIED');
  assert.equal(m.get('b')!.status, 'VERIFYING');
  assert.equal(m.get('c')!.status, 'REJECTED');
  assert.deepEqual(m.get('a')!.children, ['b']);
  const split = royaltySplit(m.get('c')!, m, 10, 0.3);
  assert.equal(split['C'], '7');
  assert.equal(split['B'], '1.5');
  assert.equal(split['A'], '1.5');

  // The sold anchor is read from the ENTRY handed in, never from the map. The teach publish sheet and every settle of
  // a draft, a fork, or an anchor a peer has not gossiped yet pass an entry the catalogue snapshot does not carry;
  // the walk used to start at `all.get(id)`, find nothing, and pay the whole lineage pool to the seller.
  const notInMap = new Map(m);
  notInMap.delete('c');
  const offMap = royaltySplit(m.get('c')!, notInMap, 10, 0.3);
  assert.equal(offMap['B'], '1.5', 'the ancestors are still paid when the sold anchor is not in the map');
  assert.equal(offMap['A'], '1.5');
  assert.equal(offMap['C'], '7');
  // …and a stale copy in the map does not override what the caller handed us
  const stale = { ...m.get('c')!, anchor: { ...m.get('c')!.anchor, parents: [] } };
  assert.equal(royaltySplit(m.get('c')!, new Map(m).set('c', stale), 10, 0.3)['A'], '1.5');
});

// ---------------------------------------------------------------- trust rules (critique 2, items 146 / 153)
const anchorRec = (id: string, author: string, samples = true): LedgerRecord<PatchAnchor> => ({
  hash: id, kind: 'anchor', author, ts: 1, parents: [], sig: '',
  body: { id, name: id, description: '', author, model: { id_M: 'M' }, patch_sha256: id, size_bytes: 1, rows: 1,
    benchmark: { schema: 's', queries: 1, format: [], samples: samples ? [{ prompt: 'q', expect: 'a' }] : undefined },
    benchmark_hash: 'h', price: '10', currency: 'CREDIT', billing: 'per_download', parents: [], parent_authors: [], topic_path: 't', created_at: 1 },
});
const attRec = (pid: string, v: string, at: number, opts: { passed?: boolean; on?: string } = {}): LedgerRecord<Attestation> => ({
  hash: `${pid}:${v}:${at}`, kind: 'attest', author: v, ts: at, parents: [], sig: '',
  body: { patch_id: pid, verifier: v, patch_sha256: pid, benchmark_hash: 'h', score: {}, passed: opts.passed ?? true, verified_on: opts.on ?? 'vllm:M', sig: '', created_at: at },
});
const chRec = (pid: string, by: string, at: number, reason = 'answers are wrong'): LedgerRecord<Challenge> => ({
  hash: `${pid}:ch:${at}`, kind: 'challenge', author: by, ts: at, parents: [], sig: '',
  body: { patch_id: pid, challenger: by, reason, created_at: at },
});

test('item 146: an author attesting its own anchor is a self-check — never counted, never listed by it', () => {
  const one = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'A', 10), attRec('p', 'v1', 11)], [], [], [], 2)[0];
  assert.equal(one.passed, 1);              // only v1 counts
  assert.equal(one.self_checks, 1);
  assert.equal(one.status, 'VERIFYING');
  assert.equal(one.quorum_ok, false);
  assert.equal(one.sellable, false);
  // the record is still shown (it is on the ledger for ever) — it just does not count
  assert.equal(one.attestations.length, 2);
  // address comparison is case-insensitive: 0xABC… by the author of 0xabc… is still a self-check
  const mixed = deriveCatalog([anchorRec('p', '0xabc')], [attRec('p', '0xABC', 10), attRec('p', 'v1', 11), attRec('p', 'v2', 12)], [], [], [], 2)[0];
  assert.equal(mixed.self_checks, 1);
  assert.equal(mixed.passed, 2);
  assert.equal(mixed.status, 'VERIFIED');
  // a node that deliberately turns the guard off (single-node dev config) counts them, and reports 0 excluded
  const dev = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'A', 10), attRec('p', 'v1', 11)], [], [], [], 2, [], true)[0];
  assert.equal(dev.passed, 2);
  assert.equal(dev.self_checks, 0);
  assert.equal(dev.status, 'VERIFIED');
});

test('item 146: the displayed fraction never exceeds the quorum, and the extra attestations are reported separately', () => {
  const three = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11), attRec('p', 'v3', 12)], [], [], [], 2)[0];
  assert.equal(three.passed, 3);
  assert.deepEqual(verificationCount(three), { shown: 2, fraction: '2/2', extra: 1 });
  assert.deepEqual(verificationCount({ passed: 1, quorum: 2 }), { shown: 1, fraction: '1/2', extra: 0 });
});

test('item 153: a challenge holds the sale (sellable false) and names itself; re-verification lifts it', () => {
  const anchors = [anchorRec('p', 'A')];
  const atts = [attRec('p', 'v1', 10), attRec('p', 'v2', 11)];
  const listed = deriveCatalog(anchors, atts, [], [], [], 2)[0];
  assert.equal(listed.status, 'VERIFIED');
  assert.equal(listed.sellable, true);

  const challenged = deriveCatalog(anchors, atts, [], [chRec('p', 'v3', 20)], [], 2)[0];
  assert.equal(challenged.status, 'CHALLENGED');
  // item 330: the two records that listed it were written BEFORE the challenge, so they answer nothing — the entry
  // reads CHALLENGED because it WAS on sale, and the count it shows is what has been measured since.
  assert.equal(challenged.quorum_ok, false);
  assert.equal(challenged.passed, 0);
  assert.equal(challenged.stale_attestations, 2);
  assert.equal(challenged.sellable, false);
  assert.equal(challenged.open_challenge?.challenger, 'v3');
  assert.equal(challenged.open_challenge?.reason, 'answers are wrong');

  // a verifier that had already attested re-runs it: the newer attestation replaces the older one and re-lists the patch
  const cleared = deriveCatalog(anchors, [...atts, attRec('p', 'v1', 30), attRec('p', 'v2', 31)], [], [chRec('p', 'v3', 20)], [], 2)[0];
  assert.equal(cleared.status, 'VERIFIED');
  assert.equal(cleared.sellable, true);
  assert.equal(cleared.passed, 2);
  assert.equal(cleared.attestations.length, 2);       // still one attestation per verifier
  assert.equal(cleared.open_challenge, undefined);

  // and a re-verification that FAILS takes the listing down instead of leaving the stale PASS in place
  const failed = deriveCatalog(anchors, [...atts, attRec('p', 'v1', 30, { passed: false }), attRec('p', 'v2', 31, { passed: false })], [], [chRec('p', 'v3', 20)], [], 2)[0];
  assert.equal(failed.status, 'REJECTED');
  assert.equal(failed.passed, 0);
  assert.equal(failed.sellable, false);
});

test('item 153: outside a challenge the first attestation of a verifier still stands, upgraded from hash-only', () => {
  const anchors = [anchorRec('p', 'A')];
  // a second attestation by the same verifier with no challenge in between is ignored (history is not rewritten)
  const e = deriveCatalog(anchors, [attRec('p', 'v1', 10), attRec('p', 'v1', 40, { passed: false })], [], [], [], 1)[0];
  assert.equal(e.attestations.length, 1);
  assert.equal(e.attestations[0].created_at, 10);
  assert.equal(e.status, 'VERIFIED');
  // hash-only → executed by the same verifier is still an upgrade
  const up = deriveCatalog(anchors, [attRec('p', 'v1', 10, { on: 'hash-only' }), attRec('p', 'v1', 20)], [], [], [], 1)[0];
  assert.equal(up.attestations[0].verified_on, 'vllm:M');
  assert.equal(up.passed, 1);
  assert.equal(up.integrity_checks, 0);
});

test('item 127: nothing on a fresh attestation or challenge claims a deposit', () => {
  const e = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10)], [], [chRec('p', 'v2', 20)], [], 1)[0];
  assert.equal(e.attestations[0].stake, undefined);
  assert.equal(e.challenges[0].stake, undefined);
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
  status: 'VERIFIED' as const, attestations: [], passed: 2, integrity_checks: 0, self_checks: 0, quorum: 2, quorum_ok: true, sellable: true, settlements: [], downloads: 0, revenue: '0',
  challenges: [], challenge_log: [], verifiers: [] as string[], executors: [], executors_unknown: 0, no_baseline: 0, superseded_by: [], supersedes: [], children: [], record_hash: '',
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
  // lineage design §11 example 5 (pass-2 fix): both carve from the FIXED remainder 10 → teacher 5, teacher2 5, node 0
  // (the pre-fix arithmetic carved the second from a shrinking remainder: 5 / 2.5 / 2.5)
  assert.deepEqual(royaltySplit(two, new Map([['two', two]]), 10, 0.3), { [TEACHER]: '5', [TEACHER2]: '5', node: '0' });
  const three = mkEntry('three', [], 'node', [teacher(TEACHER, 0.3), teacher(TEACHER2, 0.2)]);
  assert.deepEqual(royaltySplit(three, new Map([['three', three]]), 10, 0.3), { [TEACHER]: '3', [TEACHER2]: '2', node: '5' });
});

test('royaltySplit along a two-parent lineage (lineage design §11 worked examples 1–8): both lines are paid, Σ = price', () => {
  const sum = (o: Record<string, string>) => Math.round(Object.values(o).reduce((a, b) => a + Number(b), 0) * 1e6) / 1e6;
  // 3. merge: M (author m) = merge(B, C) where B ← A (a), C by c → ancestors {b, a, c} → 1 each; m 7
  const A = mkEntry('A', [], 'a'), B = mkEntry('B', ['A'], 'b'), C = mkEntry('C', [], 'c'), M = mkEntry('M', ['B', 'C'], 'm');
  const m = new Map([['A', A], ['B', B], ['C', C], ['M', M]]);
  assert.deepEqual(royaltySplit(M, m, 10, 0.3), { b: '1', a: '1', c: '1', m: '7' });
  assert.equal(sum(royaltySplit(M, m, 10, 0.3)), 10);
  // 4. same author twice: M2 = merge(A, C2) both by a → a takes the whole pool; pass 1b splits a's slice across the two anchors
  const C2 = mkEntry('C2', [], 'a', [teacher(TEACHER, 0.5)]);
  const M2 = mkEntry('M2', ['A', 'C2'], 'm');
  const m2 = new Map([['A', A], ['C2', C2], ['M2', M2]]);
  // pool 3 → a's slice 3 → 1.5 per anchor; C2's provider takes 0.5 of C2's 1.5 → 0.75
  assert.deepEqual(royaltySplit(M2, m2, 10, 0.3), { a: '2.25', [TEACHER]: '0.75', m: '7' });
  // 1. extend with a seller-side contributor d at 0.5: pool 3 → a; seller remainder 7 → d 3.5, b 3.5
  const Bd = mkEntry('Bd', ['A'], 'b', [teacher(TEACHER2, 0.5)]);
  assert.deepEqual(royaltySplit(Bd, new Map([['A', A], ['Bd', Bd]]), 10, 0.3), { a: '3', [TEACHER2]: '3.5', b: '3.5' });
  // 2. depth: A ← B ← C: pool split {a, b} 1.5 each; c 7
  const Cc = mkEntry('Cc', ['B'], 'c');
  assert.deepEqual(royaltySplit(Cc, new Map([['A', A], ['B', B], ['Cc', Cc]]), 10, 0.3), { b: '1.5', a: '1.5', c: '7' });
  // 6. the seller is an ancestor's author: B2 by b sold by b with parent A2 by b → the slice folds back → b 10
  const A2 = mkEntry('A2', [], 'b'), B2 = mkEntry('B2', ['A2'], 'b');
  assert.deepEqual(royaltySplit(B2, new Map([['A2', A2], ['B2', B2]]), 10, 0.3), { b: '10' });
  // 7. bundle: child C7 (price 5) built on X (author x): pool 1.5 → x; c 3.5 — each sale sums to its own price
  const X = mkEntry('X', [], 'x'), C7 = mkEntry('C7', ['X'], 'c');
  assert.deepEqual(royaltySplit(C7, new Map([['X', X], ['C7', C7]]), 5, 0.3), { x: '1.5', c: '3.5' });
  assert.deepEqual(royaltySplit(X, new Map([['X', X]]), 25, 0.3), { x: '25' });
  // a cycle in peer-written parents never loops or double-pays
  const P = mkEntry('P', ['Q'], 'p'), Q = mkEntry('Q', ['P'], 'q');
  const cyc = royaltySplit(Q, new Map([['P', P], ['Q', Q]]), 10, 0.3);
  assert.equal(sum(cyc), 10); assert.equal(cyc.p, '3'); assert.equal(cyc.q, '7');
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

// ---------------------------------------------------------------- the chain rule and the money it moves (critique 3 items 191/192, critique 4 items 309/310/325)
test('item 192: a 20-day version chain by one baker no longer halves the base creator, and no ancestor falls off a depth cut', () => {
  // alice publishes A; the baker bakes day 1..20, each on yesterday's version AND on A.
  const A = mkEntry('A', [], 'alice');
  const m = new Map([['A', A]]);
  let prev = 'A';
  for (let d = 1; d <= 20; d++) {
    const id = `day${d}`;
    m.set(id, mkEntry(id, d === 1 ? ['A'] : [prev], 'baker'));
    prev = id;
  }
  // day 2 (the old code paid alice 1.5 of 10 from here on) and day 20 (the old depth-16 cut paid her nothing)
  assert.deepEqual(royaltySplit(m.get('day2')!, m, 10, 0.3), { alice: '3', baker: '7' });
  assert.deepEqual(royaltySplit(m.get('day20')!, m, 10, 0.3), { alice: '3', baker: '7' });
  // an outside creator joining at day 10 halves the pool with alice — two outside authors, not "alice plus 9 bakes"
  m.set('outside', mkEntry('outside', [], 'carol'));
  m.set('day21', mkEntry('day21', ['day20', 'outside'], 'baker'));
  assert.deepEqual(royaltySplit(m.get('day21')!, m, 10, 0.3), { alice: '1.5', carol: '1.5', baker: '7' });
});

test('item 192: a data provider credited on the seller\'s own earlier version keeps her share of the seller side', () => {
  const v1 = mkEntry('v1', [], 'node', [teacher(TEACHER, 0.5)]);
  const v2 = mkEntry('v2', ['v1'], 'node');
  const m = new Map([['v1', v1], ['v2', v2]]);
  // no outside ancestor → no pool; the provider on the seller's own parent still takes 0.5 of the seller side
  assert.deepEqual(royaltySplit(v2, m, 10, 0.3), { [TEACHER]: '5', node: '5' });
  // and she is paid once, at her largest share, when she is credited on both anchors
  const v2b = mkEntry('v2b', ['v1'], 'node', [teacher(TEACHER, 0.7)]);
  assert.deepEqual(royaltySplit(v2b, new Map([['v1', v1], ['v2b', v2b]]), 10, 0.3), { [TEACHER]: '7', node: '3' });
});

test('item 309: one address in two spellings is one payee, summed under the first spelling', () => {
  const MIXED = '0x538b' + 'C'.repeat(32) + 'Ee43';
  const parent = mkEntry('parent', [], MIXED);
  const child = mkEntry('child', ['parent'], 'node', [teacher(MIXED.toLowerCase(), 0.5)]);
  const split = royaltySplit(child, new Map([['parent', parent], ['child', child]]), 10, 0.3);
  assert.deepEqual(Object.keys(split).sort(), [MIXED, 'node'].sort());
  assert.equal(split[MIXED], '6.5');   // 3 as the ancestor author + 3.5 as the data provider
  assert.equal(split.node, '3.5');
});

test('item 310: an unresolved ancestor is paid through parent_authors, or held back on the record — never folded into the seller', () => {
  const child = { ...mkEntry('child', ['gone'], 'node') };
  child.anchor = { ...child.anchor, parents: ['gone'], parent_authors: ['0xANCESTOR'] };
  const named = royaltyPlan(child, new Map([['child', child]]), 10, 0.3);
  assert.deepEqual(named.royalty, { '0xANCESTOR': '3', node: '7' });
  assert.deepEqual(named.unresolved, {});
  const anon = { ...mkEntry('anon', ['gone'], 'node') };
  const plan = royaltyPlan(anon, new Map([['anon', anon]]), 10, 0.3);
  assert.deepEqual(plan.royalty, { node: '7' }, 'the seller does NOT keep the unresolved ancestor\'s share');
  assert.deepEqual(plan.unresolved, { gone: '3' });
});

test('item 325: the attestations that count are paid the verification share out of the seller side', () => {
  const e = mkEntry('k', [], 'node');
  e.verifiers = ['v1', 'v2'];
  const plan = royaltyPlan(e, new Map([['k', e]]), 10, 0.3);
  assert.equal(plan.verifier_share, 0.05);
  assert.deepEqual(plan.verification, { v1: '0.25', v2: '0.25' });
  assert.deepEqual(plan.royalty, { v1: '0.25', v2: '0.25', node: '9.5' });
  // with a lineage pool the fee is a fraction of the seller side, and a data provider is paid out of what is left
  const parent = mkEntry('p', [], 'alice');
  const child = mkEntry('c', ['p'], 'node', [teacher(TEACHER, 0.5)]);
  child.verifiers = ['v1'];
  const p2 = royaltyPlan(child, new Map([['p', parent], ['c', child]]), 10, 0.3);
  assert.deepEqual(p2.royalty, { alice: '3', v1: '0.35', [TEACHER]: '3.325', node: '3.325' });
  assert.equal(Object.values(p2.royalty).reduce((a, b) => a + Number(b), 0), 10);
  // the seller can never pay itself the verification fee
  const self = mkEntry('s', [], 'node');
  self.verifiers = ['node'];
  assert.deepEqual(royaltyPlan(self, new Map([['s', self]]), 10, 0.3).verification, {});
});

test('item 191: the lineage share is the ANCHOR\'s promise, floored at the network minimum — not the seller\'s config', () => {
  const parent = mkEntry('p', [], 'alice');
  const child = mkEntry('c', ['p'], 'bob');
  const m = new Map([['p', parent], ['c', child]]);
  // bob sets market.royaltyShare 0 → alice still gets the network minimum
  assert.deepEqual(royaltySplit(child, m, 10, 0), { alice: '3', bob: '7' });
  // the anchor promised more than the floor → the promise on the record wins
  child.anchor = { ...child.anchor, royalty_share: 0.5 };
  assert.deepEqual(royaltySplit(child, m, 10, 0), { alice: '5', bob: '5' });
  // a hostile anchor promising less than the floor is raised to it
  child.anchor = { ...child.anchor, royalty_share: 0 };
  assert.deepEqual(royaltySplit(child, m, 10, 0.3), { alice: '3', bob: '7' });
});

test('item 242: a challenge on a VERIFYING entry is open (so verifiers re-run it), and every challenge records its outcome', () => {
  // one PASS, one FAIL → VERIFYING at quorum 2; the publisher challenges to get a re-run
  const cat = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11, { passed: false })], [], [chRec('p', 'A', 20, 'the second verifier ran on the wrong model')], [], 2);
  const e = cat[0];
  assert.equal(e.status, 'VERIFYING');
  assert.equal(e.open_challenge?.created_at, 20, 'a non-listed entry can carry an open challenge');
  assert.equal(e.challenge_log[0].state, 'open');
  // item 330 — ONE re-run does not answer a challenge on a quorum of 2: the second slot would be filled by a record
  // written before the challenge, which answers nothing. It stays open until the quorum is re-established afterwards.
  const oneRerun = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11, { passed: false }), attRec('p', 'v2', 30)], [], [chRec('p', 'A', 20, 'the second verifier ran on the wrong model')], [], 2)[0];
  assert.equal(oneRerun.challenge_log[0].state, 'open', 'one fresh PASS is not a quorum');
  assert.equal(oneRerun.open_challenge?.created_at, 20);
  assert.equal(oneRerun.passed, 1, 'v1\u2019s pre-challenge record does not count while the challenge is open');
  assert.equal(oneRerun.stale_attestations, 1);
  // a quorum of re-runs after the challenge answers it: dismissed when they pass, upheld the moment one fails
  const answered = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11, { passed: false }), attRec('p', 'v2', 30), attRec('p', 'v1', 31)], [], [chRec('p', 'A', 20, 'the second verifier ran on the wrong model')], [], 2)[0];
  assert.equal(answered.open_challenge, undefined);
  assert.equal(answered.challenge_log[0].state, 'dismissed');
  assert.equal(answered.status, 'VERIFIED');
  const upheld = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 30, { passed: false })], [], [chRec('p', 'A', 20, 'answers are wrong on 3 of the 8 questions')], [], 2)[0];
  assert.equal(upheld.challenge_log[0].state, 'upheld');
});

test('item 339: a failing recheck withdraws the same verifier\u2019s earlier PASS without anyone challenging it', () => {
  const recheck = (pid: string, v: string, at: number, passed: boolean): LedgerRecord<Attestation> => {
    const r = attRec(pid, v, at, { passed });
    return { ...r, body: { ...r.body, recheck: true as const } };
  };
  const withdrawn = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11), recheck('p', 'v2', 30, false)], [], [], [], 2)[0];
  assert.equal(withdrawn.passed, 1, 'the recheck replaces v2\u2019s pass, so the quorum is no longer met');
  assert.equal(withdrawn.status, 'VERIFYING');
  // a PASSING recheck is a confirmation, not a withdrawal: the first record still counts
  const confirmed = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11), recheck('p', 'v2', 30, true)], [], [], [], 2)[0];
  assert.equal(confirmed.passed, 2);
  assert.equal(confirmed.status, 'VERIFIED');
});

test('item 329: two verifiers on one model server are one executor, and a run with no baseline is not counted', () => {
  const withExec = (pid: string, v: string, at: number, instance: string): LedgerRecord<Attestation> => {
    const r = attRec(pid, v, at);
    return { ...r, body: { ...r.body, executor: { api: 'http://localhost:8002', model: 'M', instance } } };
  };
  const shared = deriveCatalog([anchorRec('p', 'A')], [withExec('p', 'v1', 10, 'aaaa'), withExec('p', 'v2', 11, 'aaaa')], [], [], [], 2)[0];
  assert.equal(shared.passed, 2);
  assert.deepEqual(shared.executors, ['aaaa'], 'two attestations, one model server');
  assert.equal(shared.executors_unknown, 0);
  const apart = deriveCatalog([anchorRec('p', 'A')], [withExec('p', 'v1', 10, 'aaaa'), withExec('p', 'v2', 11, 'bbbb')], [], [], [], 2)[0];
  assert.deepEqual(apart.executors.sort(), ['aaaa', 'bbbb']);
  // pre-field attestations are 'unknown', never silently claimed as independent
  const legacy = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), attRec('p', 'v2', 11)], [], [], [], 2)[0];
  assert.deepEqual(legacy.executors, []);
  assert.equal(legacy.executors_unknown, 2);
  // a run on a table that already had the knowledge applied has no baseline of its own: kept, never counted
  const noBase = attRec('p', 'v2', 11);
  const stacked = deriveCatalog([anchorRec('p', 'A')], [attRec('p', 'v1', 10), { ...noBase, body: { ...noBase.body, baseline: false } }], [], [], [], 2)[0];
  assert.equal(stacked.passed, 1);
  assert.equal(stacked.no_baseline, 1);
  assert.equal(stacked.attestations.length, 2);
  assert.equal(stacked.status, 'VERIFYING');
});

test('parseStatus accepts the old LISTED spelling and reports the new one', () => {
  // The published CLI, its README and the runbooks all say LISTED. The rename must not turn
  // `ainize patch ls --status LISTED` into "unknown status" for everyone who has it installed.
  assert.equal(parseStatus('LISTED'), 'VERIFIED');
  assert.equal(parseStatus('listed'), 'VERIFIED');
  assert.equal(parseStatus('VERIFIED'), 'VERIFIED');
  assert.equal(parseStatus(' announced '), 'ANNOUNCED');
  // An alias is accepted on input only; nothing reports it back.
  assert.ok(!PATCH_STATUSES.includes('LISTED' as never));
  assert.equal(parseStatus('ON_SALE'), null);
});

test('a delegation names one node, one key and an expiry, and nothing else verifies', () => {
  const owner = createIdentity();
  const delegate = createIdentity();
  const node = createIdentity().address;
  const now = Date.now();
  const expires = now + 60 * 60_000;
  const sign = (o: typeof owner, m: string) => signMessage(m, o.privateKey);
  const header = delegateHeader({ owner: owner.address, expires, signature: sign(owner, delegateMessage({ node, delegate: delegate.address, expires })) });

  const ok = (ctx: Parameters<typeof verifyDelegation>[1]) => verifyDelegation(header, ctx, verifyMessage);
  assert.equal(ok({ node, delegate: delegate.address, now }), owner.address);

  // another node cannot be shown the same delegation
  assert.equal(ok({ node: createIdentity().address, delegate: delegate.address, now }), null);
  // nor another key: a stolen header is inert without the key it names
  assert.equal(ok({ node, delegate: createIdentity().address, now }), null);
  // expiry is enforced, and so is the node's own ceiling on how long one may run
  assert.equal(ok({ node, delegate: delegate.address, now: expires + 1 }), null);
  assert.equal(ok({ node, delegate: delegate.address, now, maxMs: 60_000 }), null);
  // a key delegating to itself proves nothing and is refused rather than quietly accepted
  const self = delegateHeader({ owner: delegate.address, expires, signature: sign(delegate, delegateMessage({ node, delegate: delegate.address, expires })) });
  assert.equal(verifyDelegation(self, { node, delegate: delegate.address, now }, verifyMessage), null);
  // and a signature by anyone but the owner does not make them the owner
  const forged = delegateHeader({ owner: owner.address, expires, signature: sign(delegate, delegateMessage({ node, delegate: delegate.address, expires })) });
  assert.equal(verifyDelegation(forged, { node, delegate: delegate.address, now }, verifyMessage), null);

  assert.equal(parseDelegation('nope'), null);
  assert.equal(parseDelegation(null), null);
});
