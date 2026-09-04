/**
 * The row-level half of a merge (docs/lineage-teach-design.md §9 steps 2 and 3) — pure functions over .npz files, no
 * node, no model.
 *
 * `compareNpz` is the measurement SC-14 puts on the screen ("{shared} written by both ({dis} disagree)") and
 * `unionNpz` is T0 *Just combine*: the only merge that can be done without training, and only when the two files
 * cannot contradict each other on the model. Everything else must be refused here, loudly — a merged row neither
 * file measured is not knowledge (§9 Forbidden, F8).
 *
 * Scenario AZ-300 (docs/ux-test-scenarios.json).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareNpz, inspectNpz, readNpzAddrs, readNpzMember, unionNpz, valuesEqualCount, writeNpz } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'ngram-npz-merge-'));
const D = 4;

/** A knowledge file: one row per address, `before` = the disk base, `after` = what it teaches. */
function file(name: string, rows: { addr: number; before: number; after: number }[]): string {
  const path = join(dir, `${name}.npz`);
  const addrs = Buffer.alloc(8 * rows.length);
  const before = Buffer.alloc(4 * D * rows.length);
  const after = Buffer.alloc(4 * D * rows.length);
  for (const [i, r] of rows.entries()) {
    addrs.writeBigInt64LE(BigInt(r.addr), 8 * i);
    for (let d = 0; d < D; d++) { before.writeFloatLE(r.before + d, 4 * (D * i + d)); after.writeFloatLE(r.after + d, 4 * (D * i + d)); }
  }
  writeNpz(path, [{ name: 'addrs', descr: '<i8', shape: [rows.length], body: addrs },
    { name: 'before', descr: '<f4', shape: [rows.length, D], body: before },
    { name: 'after', descr: '<f4', shape: [rows.length, D], body: after }]);
  return path;
}

test('AZ-300 two knowledges that touch different rows are combined into one file, and every value comes from the file that measured it', () => {
  const a = file('a-disjoint', [{ addr: 10, before: 0, after: 1 }, { addr: 11, before: 0, after: 2 }]);
  const b = file('b-disjoint', [{ addr: 20, before: 0, after: 3 }]);
  const cmp = compareNpz(a, b);
  assert.deepEqual({ shared: cmp.shared, a_only: cmp.a_only, b_only: cmp.b_only, disagree: cmp.disagree }, { shared: 0, a_only: 2, b_only: 1, disagree: 0 });
  assert.equal(cmp.dim, D);
});

test('AZ-300 T0 union: the combined file holds every row of both, unchanged', () => {
  const a = file('a1', [{ addr: 10, before: 0, after: 1 }, { addr: 11, before: 0, after: 2 }]);
  const b = file('b1', [{ addr: 20, before: 0, after: 3 }]);
  const out = join(dir, 'u1.npz');
  const u = unionNpz(out, a, b);
  assert.deepEqual({ rows: u.rows, shared: u.shared, a_rows: u.a_rows, b_rows: u.b_rows }, { rows: 3, shared: 0, a_rows: 2, b_rows: 1 });
  assert.equal(inspectNpz(out).rows, 3);
  assert.deepEqual([...readNpzAddrs(out)].map(Number), [10, 11, 20]);
  // the values are the parents' own, to the bit: nothing was averaged, nothing was added
  const after = readNpzMember(out, 'after');
  assert.deepEqual([0, 1, 2].map((r) => after.body.readFloatLE(4 * D * r)), [1, 2, 3]);
  // and the union agrees with both parents on every row they own
  assert.equal(valuesEqualCount(out, a).differ, 0);
  assert.equal(valuesEqualCount(out, b).differ, 0);
});

test('AZ-300 a shared row both files write with the SAME value is combined; one they disagree about is refused, never averaged', () => {
  const a = file('a2', [{ addr: 10, before: 0, after: 1 }, { addr: 11, before: 0, after: 5 }]);
  const same = file('b2same', [{ addr: 11, before: 0, after: 5 }, { addr: 12, before: 0, after: 7 }]);
  const u = unionNpz(join(dir, 'u2.npz'), a, same);
  assert.deepEqual({ rows: u.rows, shared: u.shared }, { rows: 3, shared: 1 }, 'the shared row is written once');

  const differs = file('b2diff', [{ addr: 11, before: 0, after: 6 }]);
  const cmp = compareNpz(a, differs);
  assert.deepEqual({ shared: cmp.shared, disagree: cmp.disagree, opposing: cmp.opposing }, { shared: 1, disagree: 1, opposing: 1 },
    'both files moved that row away from the same base, to different values');
  assert.throws(() => unionNpz(join(dir, 'u3.npz'), a, differs), /union_refused: rows_disagree/);
});

test('AZ-300 two files that disagree about what was UNDER a row cannot be combined into a stand-alone build', () => {
  const a = file('a3', [{ addr: 10, before: 0, after: 4 }]);
  // a delta trained on top of `a`: its `before` on that address is a's `after`
  const child = file('b3', [{ addr: 10, before: 4, after: 4 }]);
  const cmp = compareNpz(a, child);
  assert.deepEqual({ disagree: cmp.disagree, before_differs: cmp.before_differs, opposing: cmp.opposing }, { disagree: 0, before_differs: 1, opposing: 0 },
    'they agree about the answer and disagree about the ground under it');
  assert.throws(() => unionNpz(join(dir, 'u4.npz'), a, child), /union_refused: before_differs/);
});

test('AZ-300 the combined file carries the members it is given (the job marker and `meta`), so it is one addressable knowledge', () => {
  const a = file('a4', [{ addr: 30, before: 0, after: 1 }]);
  const b = file('b4', [{ addr: 31, before: 0, after: 2 }]);
  const out = join(dir, 'u5.npz');
  const meta = Buffer.from(JSON.stringify({ export: 'squash', base_stack: [] }), 'utf8');
  const u = unionNpz(out, a, b, [{ name: 'meta', descr: '|u1', shape: [meta.length], body: meta }]);
  assert.equal(u.rows, 2);
  assert.deepEqual(inspectNpz(out).members.map((m) => m.name).sort(), ['addrs', 'after', 'before', 'meta']);
  assert.equal(readNpzMember(out, 'meta').body.toString('utf8'), meta.toString('utf8'));
  assert.match(u.pre_state_sha256, /^[0-9a-f]{64}$/, 'the state the union expects underneath is hashed like any other build');
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
