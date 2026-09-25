/**
 * Who has deposited what, in one unit, across chains.
 *
 * A deposit buys a permanent share of a node's throughput. It is not spent per request and it is not withdrawn,
 * so this record only ever grows — which makes it the simplest thing in the design and the one with the least
 * room to be wrong. There is no settlement, no refund path and no balance to go negative.
 *
 * Two decisions carry the weight:
 *
 *   • **Identity is the log, not the transfer.** Log events arrive more than once — a watcher restarts, a range
 *     is re-scanned, a reorg replays a block — and crediting twice would mint share out of nothing. Since share
 *     is a claim on finite throughput, minted share is taken from everyone who paid for theirs. So the key is
 *     (chain, txHash, logIndex) and `credit` is idempotent on it, returning false rather than throwing: a
 *     watcher re-scanning a range is doing its job, not making a mistake.
 *
 *   • **Amounts are bigint.** sAIN has 18 decimals, so ten tokens is 10^19 — well past where a double still
 *     counts in ones. The resulting error would be silent, and would always favour somebody.
 *
 * This file does no I/O. Core describes the protocol; watching a chain belongs to the node.
 */

/** One credited transfer, identified by the log that reported it. */
export interface DepositEvent {
  /** Chain name as the watcher configured it ("ethereum", "base"). Part of the identity: tx hashes repeat across chains. */
  chain: string;
  txHash: string;
  logIndex: number;
  /** The depositing address — whoever sent the transfer. */
  from: string;
  /** Amount in sAIN share units. Already converted; this file does no conversion. */
  shares: bigint;
  blockNumber: number;
}

const keyOf = (chain: string, txHash: string, logIndex: number): string =>
  `${chain.toLowerCase()}:${txHash.toLowerCase()}:${logIndex}`;

export class DepositLedger {
  private readonly credited = new Map<string, DepositEvent>();
  private readonly byAddress = new Map<string, bigint>();
  private total = 0n;

  /** Rebuild from a snapshot — the node persists `snapshot()` and hands it back at start-up. */
  static from(events: DepositEvent[]): DepositLedger {
    const ledger = new DepositLedger();
    for (const event of events) ledger.credit(event);
    return ledger;
  }

  /**
   * Credit one transfer. Returns false when this exact log was already credited, or when it moved nothing.
   *
   * A zero-value transfer is legal ERC-20 and means nothing here, so it is not recorded: keeping it would put
   * addresses in the ledger who never deposited, and they would then appear in `snapshot()` and in any list built
   * from it.
   */
  credit(event: DepositEvent): boolean {
    if (event.shares < 0n) throw new Error(`a deposit cannot be negative (${event.chain}:${event.txHash})`);
    if (event.shares === 0n) return false;
    const key = keyOf(event.chain, event.txHash, event.logIndex);
    if (this.credited.has(key)) return false;

    const from = event.from.toLowerCase();
    this.credited.set(key, { ...event, from, txHash: event.txHash.toLowerCase() });
    this.byAddress.set(from, (this.byAddress.get(from) ?? 0n) + event.shares);
    this.total += event.shares;
    return true;
  }

  depositedShareOf(address: string): bigint {
    return this.byAddress.get(address.toLowerCase()) ?? 0n;
  }

  totalDepositedShares(): bigint {
    return this.total;
  }

  /**
   * This address's fraction of everything deposited, as a plain number.
   *
   * Lossy by construction and that is fine: it is a ratio of two like-scaled quantities used to weight a queue,
   * never an amount anybody is owed. Amounts stay bigint everywhere they matter.
   */
  shareFractionOf(address: string): number {
    if (this.total === 0n) return 0;
    const mine = this.depositedShareOf(address);
    if (mine === 0n) return 0;
    // Divide in bigint first to keep the ratio meaningful when both sides are far beyond Number's integer range.
    const SCALE = 1_000_000_000n;
    return Number((mine * SCALE) / this.total) / Number(SCALE);
  }

  /** The event a particular log produced, or null if that log was never credited. */
  creditedAt(chain: string, txHash: string, logIndex: number): DepositEvent | null {
    return this.credited.get(keyOf(chain, txHash, logIndex)) ?? null;
  }

  /** Every credited event, in the order it was credited — what the node persists. */
  snapshot(): DepositEvent[] {
    return [...this.credited.values()];
  }
}
