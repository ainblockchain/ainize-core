/**
 * Who has deposited how much, in one unit, across chains.
 *
 * Deposits arrive as log events, and log events arrive more than once: a watcher restarts, a range is re-scanned,
 * a reorg replays a block. Crediting twice would mint share out of nothing — and since share is a claim on a
 * node's throughput, minting it takes capacity from everyone who paid for theirs. So identity is
 * (chain, txHash, logIndex) and crediting is idempotent on it.
 *
 * Amounts are bigint. sAIN has 18 decimals, so a deposit of ten tokens is 10^19 — past the point where a double
 * still counts in ones, and the error would be silent and always in someone's favour.
 *
 *   node --test --import tsx test/deposit-ledger.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DepositLedger, type DepositEvent } from '../src/deposit-ledger.js';

const ONE = 10n ** 18n;
const event = (over: Partial<DepositEvent> = {}): DepositEvent => ({
  chain: 'base', txHash: '0xaa', logIndex: 0, from: '0xAbC0000000000000000000000000000000000001',
  shares: ONE, blockNumber: 100, ...over,
});

test('a credit shows up under the sender, lowercased', () => {
  const ledger = new DepositLedger();
  assert.equal(ledger.credit(event()), true);
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), ONE);
});

test('a checksummed address is the same account as its lowercase form', () => {
  const ledger = new DepositLedger();
  ledger.credit(event());
  assert.equal(ledger.depositedShareOf('0xAbC0000000000000000000000000000000000001'), ONE);
});

test('the same log credited twice counts once', () => {
  const ledger = new DepositLedger();
  ledger.credit(event());
  assert.equal(ledger.credit(event()), false);
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), ONE);
});

test('the same tx hash on two chains is two deposits', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ chain: 'base' }));
  ledger.credit(event({ chain: 'ethereum' }));
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 2n * ONE);
});

test('two logs in one transaction are two deposits', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ logIndex: 0 }));
  ledger.credit(event({ logIndex: 1 }));
  assert.equal(ledger.depositedShareOf('0xabc0000000000000000000000000000000000001'), 2n * ONE);
});

test('an address that never deposited holds zero, not undefined', () => {
  assert.equal(new DepositLedger().depositedShareOf('0x0000000000000000000000000000000000000009'), 0n);
});

test('the total is the sum over everyone', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ from: '0x01', shares: 3n }));
  ledger.credit(event({ from: '0x02', shares: 7n, logIndex: 1 }));
  assert.equal(ledger.totalDepositedShares(), 10n);
});

test('a zero-value transfer is not a deposit', () => {
  const ledger = new DepositLedger();
  assert.equal(ledger.credit(event({ shares: 0n })), false);
  assert.equal(ledger.totalDepositedShares(), 0n);
});

test('a negative amount is refused rather than quietly reducing a balance', () => {
  const ledger = new DepositLedger();
  assert.throws(() => ledger.credit(event({ shares: -1n })), /negative/);
});

test('a credited event can be looked up by the log that made it', () => {
  const ledger = new DepositLedger();
  ledger.credit(event());
  assert.equal(ledger.creditedAt('base', '0xaa', 0)?.shares, ONE);
  assert.equal(ledger.creditedAt('base', '0xaa', 1), null);
});

test('a tx hash is matched however it is cased', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ txHash: '0xAA' }));
  assert.ok(ledger.creditedAt('base', '0xaa', 0));
});

test('a ledger rebuilt from its snapshot holds the same balances', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ from: '0x01', shares: 3n }));
  ledger.credit(event({ from: '0x02', shares: 7n, logIndex: 1 }));
  const rebuilt = DepositLedger.from(ledger.snapshot());
  assert.equal(rebuilt.totalDepositedShares(), 10n);
  assert.equal(rebuilt.depositedShareOf('0x01'), 3n);
});

test('share of the whole is reported as an exact ratio, not a rounded balance', () => {
  const ledger = new DepositLedger();
  ledger.credit(event({ from: '0x01', shares: ONE }));
  ledger.credit(event({ from: '0x02', shares: 3n * ONE, logIndex: 1 }));
  assert.equal(ledger.shareFractionOf('0x01'), 0.25);
});

test('an empty ledger gives everyone a share of zero rather than dividing by nothing', () => {
  assert.equal(new DepositLedger().shareFractionOf('0x01'), 0);
});
