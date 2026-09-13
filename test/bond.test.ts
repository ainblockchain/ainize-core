/**
 * Bond rules (the sybil cost the quorum never had).
 *
 * The property under test throughout is that a bond is only ever counted when it is actually AT RISK: not while it
 * is being withdrawn, not after a lost challenge, and never below the floor the counting node set. The old `stake`
 * field failed precisely by being none of those things, so each of them gets a test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOND_BAR_MS, BOND_UNBONDING_MS, NETWORK_MIN_VERIFIER_BOND,
  bondStatus, canAttest, countsTowardQuorum, effectiveMinBond, quorumCount, unbondingReadyAt,
  type BondState,
} from '../src/index.js';

const NOW = 1_800_000_000_000;
const active = (amount: number): BondState => ({ amount });

test('effectiveMinBond: an operator may require more than the network floor and never less', () => {
  assert.equal(effectiveMinBond(undefined), NETWORK_MIN_VERIFIER_BOND);
  assert.equal(effectiveMinBond(null), NETWORK_MIN_VERIFIER_BOND);
  assert.equal(effectiveMinBond(0), NETWORK_MIN_VERIFIER_BOND, 'zero does not disable the floor');
  assert.equal(effectiveMinBond(1), NETWORK_MIN_VERIFIER_BOND);
  assert.equal(effectiveMinBond(NaN), NETWORK_MIN_VERIFIER_BOND);
  assert.equal(effectiveMinBond(250_000), 250_000);
});

test('bondStatus: barred beats everything, and withdrawal beats a balance that is still there', () => {
  assert.equal(bondStatus(null, NOW), 'none');
  assert.equal(bondStatus(active(0), NOW), 'none');
  assert.equal(bondStatus(active(100_000), NOW), 'active');
  // a bond on its way out is not active however much is still locked
  assert.equal(bondStatus({ amount: 1e9, unbonding_since: NOW - 1000 }, NOW), 'unbonding');
  // and a barred verifier is barred however healthy the bond looks
  assert.equal(bondStatus({ amount: 1e9, barred_until: NOW + 1000 }, NOW), 'barred');
  assert.equal(bondStatus({ amount: 1e9, barred_until: NOW + 1000, unbonding_since: NOW }, NOW), 'barred');
  // a bar that has expired stops mattering
  assert.equal(bondStatus({ amount: 200_000, barred_until: NOW - 1 }, NOW), 'active');
});

test('countsTowardQuorum: the floor is a floor, and the refusal names the shortfall', () => {
  const under = countsTowardQuorum(active(NETWORK_MIN_VERIFIER_BOND - 1), { now: NOW });
  assert.equal(under.ok, false);
  assert.equal(under.status, 'active');
  assert.equal(under.required, NETWORK_MIN_VERIFIER_BOND);
  assert.match(under.reason!, /short by 1\b/, 'says how much is missing, not just "not bonded"');

  assert.equal(countsTowardQuorum(active(NETWORK_MIN_VERIFIER_BOND), { now: NOW }).ok, true, 'exactly the floor counts');
  assert.equal(countsTowardQuorum(active(1e6), { now: NOW }).ok, true);

  // the counting node's own minimum applies, not the network's
  assert.equal(countsTowardQuorum(active(150_000), { minBond: 250_000, now: NOW }).ok, false);
  assert.equal(countsTowardQuorum(active(250_000), { minBond: 250_000, now: NOW }).ok, true);
});

test('countsTowardQuorum: a bond being withdrawn backs nothing, and the reason says when it is released', () => {
  const r = countsTowardQuorum({ amount: 5e6, unbonding_since: NOW }, { now: NOW });
  assert.equal(r.ok, false, 'five million AIN on its way out counts for nothing');
  assert.equal(r.status, 'unbonding');
  assert.match(r.reason!, /withdrawing its bond/);
  assert.match(r.reason!, new RegExp(new Date(NOW + BOND_UNBONDING_MS).toISOString()));
  assert.equal(unbondingReadyAt({ amount: 5e6, unbonding_since: NOW }), NOW + BOND_UNBONDING_MS);
  assert.equal(unbondingReadyAt(active(5e6)), null);
});

test('countsTowardQuorum: a lost challenge outlasts the unbonding period, so leaving is not a way to serve it out', () => {
  const barred: BondState = { amount: 1e6, barred_until: NOW + BOND_BAR_MS };
  const r = countsTowardQuorum(barred, { now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'barred');
  assert.match(r.reason!, /lost a challenge/);
  assert.ok(BOND_BAR_MS > BOND_UNBONDING_MS, 'a bar that is shorter than a withdrawal is no bar at all');
  // and it lapses on its own
  assert.equal(countsTowardQuorum(barred, { now: NOW + BOND_BAR_MS + 1 }).ok, true);
});

test('canAttest: a node with no bond is told the command that fixes it, before it spends a GPU minute', () => {
  const none = canAttest(null, { now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.reason!, /no bond on the knowledge app/);
  assert.match(none.reason!, /ainize bond stake 100000/);

  // an under-funded node gets the shortfall instead, which is a different mistake
  const short = canAttest(active(99_999), { now: NOW });
  assert.equal(short.ok, false);
  assert.match(short.reason!, /short by 1\b/);

  assert.deepEqual(canAttest(active(100_000), { now: NOW }), { ok: true });
});

test('quorumCount: unbonded and duplicate signatures do not reach the quorum — one address is one voice', () => {
  const bonds: Record<string, BondState> = {
    '0xaa': active(500_000),
    '0xbb': active(500_000),
    '0xcc': active(10),                                   // under the floor
    '0xdd': { amount: 1e6, unbonding_since: NOW },        // on the way out
    '0xee': { amount: 1e6, barred_until: NOW + 1000 },    // barred
  };
  const atts = [
    { verifier: '0xaa', id: 1 }, { verifier: '0xbb', id: 2 }, { verifier: '0xcc', id: 3 },
    { verifier: '0xdd', id: 4 }, { verifier: '0xee', id: 5 },
    { verifier: '0xAA', id: 6 },                          // same address, other case, signed twice
  ];
  const { counted, skipped } = quorumCount(atts, (a) => bonds[a.toLowerCase()], { now: NOW });

  assert.deepEqual(counted.map((a) => a.id), [1, 2], 'only the two bonded, distinct addresses');
  assert.deepEqual(skipped.map((s) => s.attestation.id), [3, 4, 5, 6]);
  assert.match(skipped.find((s) => s.attestation.id === 6)!.reason, /already attested/);

  // the sybil arithmetic this exists for: a quorum of 2 costs 2 x the floor in locked AIN, whatever it rents
  assert.ok(counted.length * NETWORK_MIN_VERIFIER_BOND >= 2 * NETWORK_MIN_VERIFIER_BOND);
});

test('quorumCount: an empty set and an all-unbonded set both count to nothing rather than throwing', () => {
  assert.deepEqual(quorumCount([], () => null, { now: NOW }).counted, []);
  const r = quorumCount([{ verifier: '0xaa' }, { verifier: '0xbb' }], () => null, { now: NOW });
  assert.equal(r.counted.length, 0);
  assert.equal(r.skipped.length, 2);
});
