/**
 * Lineage helpers (docs/lineage-teach-design.md §5.1, §5.4, §6.3, §6.4, §12.6) — pure functions, no node.
 *
 * These are the rules an anchor is held to before it is written and after it is read: which samples go on the ledger
 * and what commits to the rest, which licences may build on which, that every base named anywhere is a parent, and
 * that the state a delta was trained against hashes the same way on every machine.
 *
 * Scenarios AZ-246, AZ-247 (docs/ux-test-scenarios.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessRank, answersHash, bf16Bits, capBenchmarkSamples, deltaOnlyParent, fromAin, licenseCompatible, lineageIds,
  lineageProblems, merkleRoot, preStateSha256, sha256Hex, TEACH_SAMPLES_ON_CHAIN, toAin, withEmptyArrays,
  type BenchmarkSample, type PatchAnchor,
} from '../src/index.js';

const sample = (i: number): BenchmarkSample => ({ prompt: `Q: q${i}\nA: `, expect: `a${i}` });

// ---------------------------------------------------------------- the on-chain sample list (§5.1)
test('capBenchmarkSamples: the child first, one per base, capped at 32 — and answers_hash commits to the WHOLE list', () => {
  const own = Array.from({ length: 40 }, (_, i) => sample(i));
  const parents = [{ patch_id: 'krx-all-2761', sample: sample(100) }, { patch_id: 'pixelplus', sample: sample(101) }];
  const out = capBenchmarkSamples(own, parents);
  assert.equal(out.samples.length, TEACH_SAMPLES_ON_CHAIN, 'a taught anchor never carries more than 32 samples');
  assert.equal(out.full.length, 42, 'the full list is the child’s own plus one per base');
  assert.deepEqual(out.samples[0], { prompt: own[0].prompt, expect: own[0].expect });
  assert.deepEqual(out.full.slice(40), [{ ...sample(100), source: 'krx-all-2761' }, { ...sample(101), source: 'pixelplus' }]);
  assert.equal(out.answers_hash, answersHash(out.full));
  assert.notEqual(out.answers_hash, answersHash(out.samples), 'the hash is of the full list — that is what makes the slice honest');

  // a small lesson keeps everything, and the parent samples are reachable on the record itself
  const small = capBenchmarkSamples([sample(1), sample(2)], parents);
  assert.equal(small.samples.length, 4);
  assert.deepEqual(small.samples.map((s) => s.source ?? null), [null, null, 'krx-all-2761', 'pixelplus']);
  // de-duplication: the same question from two places is one sample, and a base with no samples adds nothing
  const dupes = capBenchmarkSamples([sample(1), sample(1)], [{ patch_id: 'x' }, { patch_id: 'y', sample: sample(1) }]);
  assert.equal(dupes.full.length, 2, 'the same prompt/expect from a base is a separate sample only because of `source`');
  assert.deepEqual(dupes.full[1].source, 'y');
  // order matters to the hash: it is a hash of a list, not of a set
  assert.notEqual(answersHash([sample(1), sample(2)]), answersHash([sample(2), sample(1)]));
  assert.equal(answersHash([]), sha256Hex('[]'));
});

// ---------------------------------------------------------------- licences (§6.4)
test('licenceCompatible: CC-BY-SA forces the child and its access floor; CC0/CC-BY/ODC-By and Proprietary bases do not', () => {
  const child = (license: string, access: 'public' | 'derivative' | 'private' = 'derivative') => ({ license, access });
  for (const parent of ['CC0-1.0', 'CC-BY-4.0', 'ODC-By-1.0', 'Proprietary', undefined]) {
    assert.equal(licenseCompatible({ license: parent, access: 'derivative' }, child('CC-BY-4.0')).ok, true, `${parent} parent accepts any child licence`);
    assert.equal(licenseCompatible({ license: parent, access: 'derivative' }, child('Proprietary')).ok, true);
  }
  const sa = { license: 'CC-BY-SA-4.0', access: 'public' as const };
  const no = licenseCompatible(sa, child('CC-BY-4.0'));
  assert.equal(no.ok, false);
  assert.match((no as { reason: string }).reason, /^license_incompatible/);
  assert.equal(licenseCompatible(sa, child('CC-BY-SA-4.0', 'public')).ok, true);
  const tooClosed = licenseCompatible(sa, child('CC-BY-SA-4.0', 'derivative'));
  assert.equal(tooClosed.ok, false, 'share-alike keeps the access level too: a public parent cannot yield a derivative-only child');
  assert.match((tooClosed as { reason: string }).reason, /at least as open/);
  const unknown = licenseCompatible({ license: 'CC-BY-4.0' }, child('WTFPL'));
  assert.equal(unknown.ok, false);
  assert.match((unknown as { reason: string }).reason, /^bad_license/);
  assert.equal(deltaOnlyParent('Proprietary'), true, 'a Proprietary base never has its rows copied into the child’s blob');
  assert.equal(deltaOnlyParent('CC-BY-4.0'), false);
  assert.deepEqual([accessRank('private'), accessRank('derivative'), accessRank('public'), accessRank(undefined)], [0, 1, 2, 0]);
});

// ---------------------------------------------------------------- the anchor invariant (§5.1, §12.6)
const anchorOf = (over: Partial<PatchAnchor>): PatchAnchor => ({
  id: 'child', author: '0xnode', patch_sha256: 'a'.repeat(64), parents: ['base'], parent_authors: ['0xother'],
  benchmark: { schema: 'taught/x', queries: 1, format: ['template'] }, price: '1', ...over,
} as PatchAnchor);

test('lineageProblems: every base named anywhere must be a parent, a delta needs a stack, and a taught anchor respects the cap', () => {
  const good = anchorOf({
    derivation: { kind: 'extend', bases: [{ patch_id: 'base', patch_sha256: 'b'.repeat(64), rows: 4 }], added_rows: 3, changed_rows: 0, removed_rows: 0 },
    base: { stack: [{ patch_id: 'base', patch_sha256: 'b'.repeat(64) }], export: 'delta', pre_state_sha256: 'c'.repeat(64) },
    dataset: { sha256: 'd'.repeat(64), rows: 7, source: 'upload', access: 'derivative', license: 'CC-BY-4.0', parents: [{ patch_id: 'base', sha256: 'e'.repeat(64), rows: 4 }] },
  });
  assert.deepEqual(lineageProblems(good), []);
  assert.deepEqual(lineageProblems(anchorOf({})), [], 'a pre-lineage anchor is valid exactly as it always was');

  const stranger = { patch_id: 'not-a-parent', patch_sha256: 'b'.repeat(64), rows: 1 };
  assert.match(lineageProblems(anchorOf({ derivation: { kind: 'extend', bases: [stranger], added_rows: 1, changed_rows: 0, removed_rows: 0 } }))[0], /derivation.bases names not-a-parent/);
  assert.match(lineageProblems(anchorOf({ base: { stack: [{ patch_id: 'not-a-parent', patch_sha256: 'b'.repeat(64) }], export: 'delta', pre_state_sha256: 'c'.repeat(64) } }))[0], /base.stack names not-a-parent/);
  assert.match(lineageProblems(anchorOf({ dataset: { sha256: 'd'.repeat(64), rows: 1, source: 'upload', parents: [{ patch_id: 'not-a-parent', sha256: 'e'.repeat(64), rows: 1 }] } }))[0], /dataset.parents names not-a-parent/);
  assert.match(lineageProblems(anchorOf({ base: { stack: [], export: 'delta', pre_state_sha256: 'c'.repeat(64) } }))[0], /a delta needs a non-empty base.stack/);
  assert.deepEqual(lineageProblems(anchorOf({ base: { stack: [], export: 'squash', pre_state_sha256: 'c'.repeat(64) } })), [], 'a squash carries the parent rows itself, so its stack is empty on purpose');
  assert.match(lineageProblems(anchorOf({ base: { stack: [{ patch_id: 'base', patch_sha256: 'b'.repeat(64) }], export: 'delta', pre_state_sha256: 'not-a-hash' } }))[0], /pre_state_sha256/);
  assert.match(lineageProblems(anchorOf({ parents: ['child'] }))[0], /^base_cycle/);
  assert.match(lineageProblems(anchorOf({ dataset: { sha256: 'd'.repeat(64), rows: 1, source: 'upload', license: 'WTFPL' } }))[0], /^bad_license/);
  assert.match(lineageProblems(anchorOf({ dataset: { sha256: 'd'.repeat(64), rows: 1, source: 'upload', access: 'everyone' as never } }))[0], /dataset.access/);
  assert.match(lineageProblems(anchorOf({ derivation: { kind: 'blend' as never, bases: [], added_rows: 0, changed_rows: 0, removed_rows: 0 } }))[0], /derivation.kind/);
  assert.match(lineageProblems(anchorOf({ derivation: { kind: 'extend', bases: [], added_rows: -1, changed_rows: 0, removed_rows: 0 } }))[0], /added_rows/);
  const many = anchorOf({ origin: 'teach', benchmark: { schema: 'taught/x', queries: 33, format: [], samples: Array.from({ length: 33 }, (_, i) => sample(i)) } });
  assert.match(lineageProblems(many)[0], /at most 32 benchmark samples/);
  assert.deepEqual(lineageProblems({ ...many, origin: 'operator' }), [], 'the cap is a teach-anchor rule (an operator anchor publishes its own benchmark)');

  assert.deepEqual(lineageIds(good), ['base'], 'the ids a child inherited from, de-duplicated across the three fields');
});

// ---------------------------------------------------------------- the state a delta was trained against (§5.4)
test('preStateSha256 hashes the base state by address, whatever order the rows are in; bf16 rounding is round-to-nearest-even', () => {
  const addrs = new BigInt64Array([5n, 1n, 9n]);
  const before = new Float32Array([1, 2, 3, 4, 5, 6]);   // dim 2, row-major
  const h = preStateSha256(addrs, before, 2);
  assert.match(h, /^[0-9a-f]{64}$/);
  // the same rows in another order are the same state
  const shuffled = preStateSha256(new BigInt64Array([1n, 9n, 5n]), new Float32Array([3, 4, 5, 6, 1, 2]), 2);
  assert.equal(shuffled, h);
  // one different value is a different state
  assert.notEqual(preStateSha256(addrs, new Float32Array([1, 2, 3, 4, 5, 7]), 2), h);
  // …but a difference below bf16 resolution is not, because bf16 is what the table holds
  assert.equal(preStateSha256(new BigInt64Array([1n]), new Float32Array([1 + 1e-9]), 1), preStateSha256(new BigInt64Array([1n]), new Float32Array([1]), 1));
  assert.equal(bf16Bits(1), 0x3f80);
  assert.equal(bf16Bits(-1), 0xbf80);
  assert.equal(bf16Bits(0), 0);
  assert.equal(bf16Bits(1 + 2 ** -8), 0x3f80, 'exactly halfway rounds to even');
  assert.equal(bf16Bits(1 + 2 ** -7), 0x3f81);
});

test('merkleRoot: an empty set, one leaf and an odd count all have a defined root (inclusion proofs for a private base)', () => {
  assert.equal(merkleRoot([]), sha256Hex(''));
  assert.equal(merkleRoot(['a']), sha256Hex('a'));
  assert.equal(merkleRoot(['a', 'b']), sha256Hex(sha256Hex('a') + sha256Hex('b')));
  assert.equal(merkleRoot(['a', 'b', 'c']), sha256Hex(sha256Hex(sha256Hex('a') + sha256Hex('b')) + sha256Hex('c')), 'an odd leaf is carried up, never duplicated');
  assert.notEqual(merkleRoot(['a', 'b']), merkleRoot(['b', 'a']));
});

// ---------------------------------------------------------------- the AIN round trip (§5.1, design §14)
test('AIN round-trip: derivation.bases, base.stack and dataset.parents survive toAin/fromAin/withEmptyArrays', () => {
  const anchor = anchorOf({
    derivation: { kind: 'merge', bases: [{ patch_id: 'base', patch_sha256: 'b'.repeat(64), dataset_sha256: 'f'.repeat(64), rows: 4 }], added_rows: 3, changed_rows: 1, removed_rows: 0, policy: 'keep_a', tier: 'retrain' },
    base: { stack: [{ patch_id: 'base', patch_sha256: 'b'.repeat(64) }], export: 'delta', pre_state_sha256: 'c'.repeat(64) },
    dataset: { sha256: 'd'.repeat(64), rows: 7, source: 'upload', access: 'derivative', license: 'CC-BY-SA-4.0', parents: [{ patch_id: 'base', sha256: 'e'.repeat(64), rows: 4 }], merkle_root: '1'.repeat(64) },
  });
  const back = withEmptyArrays(fromAin(JSON.parse(JSON.stringify(toAin(anchor)))) as PatchAnchor);
  assert.deepEqual(back.derivation, anchor.derivation);
  assert.deepEqual(back.base, anchor.base);
  assert.deepEqual(back.dataset, anchor.dataset);
  assert.deepEqual(lineageProblems(back), []);

  // AIN drops empty arrays: a merge whose bases were not written back reads as [] rather than undefined
  const emptied = JSON.parse(JSON.stringify(toAin(anchor))) as Record<string, unknown>;
  const dv = (emptied.derivation ?? {}) as Record<string, unknown>; delete dv.bases;
  const bs = (emptied.base ?? {}) as Record<string, unknown>; delete bs.stack;
  const ds = (emptied.dataset ?? {}) as Record<string, unknown>; delete ds.parents;
  const restored = withEmptyArrays(fromAin(emptied) as PatchAnchor);
  assert.deepEqual(restored.derivation!.bases, []);
  assert.deepEqual(restored.base!.stack, []);
  assert.deepEqual(restored.dataset!.parents, []);

  // an anchor written before lineage reads back without any of the three (never as empty objects)
  const legacy = withEmptyArrays(fromAin(JSON.parse(JSON.stringify(toAin(anchorOf({}))))) as PatchAnchor);
  assert.equal(legacy.derivation, undefined);
  assert.equal(legacy.base, undefined);
  assert.equal(legacy.dataset, undefined);
});
