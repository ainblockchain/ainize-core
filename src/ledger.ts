/**
 * Ledger abstraction (원장 130).
 *
 * Two backends implement it:
 *  - LocalLedger  — signed, content-addressed record DAG in SQLite, replicated peer-to-peer by set
 *                   reconciliation (zero-config; the reference prototype's ledger.jsonl imports into it).
 *  - AinLedger    — AI Network blockchain via @ainblockchain/ain-js: anchors are `knowledge.explore()`
 *                   entries (graph edges = lineage), attestations/settlements/branches/nodes live under
 *                   /apps/knowledge/market/* guarded by write rules, payments are AIN transfers (x402).
 *
 * The node derives catalog state (status machine, quorum, lineage, supersede) from the records —
 * "카탈로그 = 원장의 anchor 블록 집합" (청구항 19).
 */
import type {
  Attestation, BranchInfo, Challenge, Dispute, LedgerRecord, PatchAnchor, PeerInfo, RecordKind, Settlement,
} from './types.js';

export interface SupersedeRecord {
  old_patch_id: string;
  new_patch_id: string;
  overlap_rows: number;
  reason: string;
  /** When the supersede was written (ms). Older on-chain records lack it — readers fall back to the new patch's attest/anchor time. */
  created_at?: number;
}

/**
 * Author's takedown of their own knowledge (`retire` record). The anchor is immutable and stays on the record —
 * this is the only way a publisher stops selling it: the catalogue drops it, the x402 gateway answers 410, and
 * buyers who already paid keep their download rights. Only a record signed by the anchor's own author counts.
 */
export interface RetireRecord {
  patch_id: string;
  /** Why it was taken down, in the publisher's words (shown to buyers; may be empty). */
  reason: string;
  created_at: number;
}

/**
 * A price change, signed by the anchor's own author (`price` record, finding 278).
 *
 * The anchor is immutable, so before this the only way to re-price a listing was to publish a new one that
 * superseded it — which restarts verification, splits the sales history and makes a discount indistinguishable
 * from a new version. A seller who took the 0.1 default on a first listing, or who wants to run a launch price,
 * or to make an obsolete knowledge free, had no path at all. The newest record by the anchor's author wins; every
 * one of them stays on the ledger, so a claimed discount can be checked against the price it was discounted from.
 */
export interface PriceRecord {
  patch_id: string;
  /** The new price in the anchor's currency, as a decimal string ('0' makes it free). */
  price: string;
  currency: string;
  /** Why, in the seller's words (shown to buyers on the price history; may be empty). */
  reason: string;
  created_at: number;
}

export interface SubscriptionRecord {
  node: string;
  branch: string;
  action: 'subscribe' | 'unsubscribe';
  patch_ids: string[];
  /** When the (un)subscribe was written (ms). Older on-chain records lack it — readers fall back to the branch's creation time. */
  created_at?: number;
}

/**
 * A royalty transfer the seller actually made (`payout` record, finding 314).
 *
 * The buyer pays the seller in full and the seller then sends one transfer per creator, with no memo and nothing
 * tying it to the sale — 34 reported royalties, 29 the seller claimed and 8 visible in chain state could be
 * reconciled by nobody. A payout record joins the two by settle hash, so an ancestor has evidence to dispute with
 * and an honest seller has evidence to show. It is written by the SELLER after the transfer returns.
 */
export interface PayoutRecord {
  settle_hash: string;
  patch_id: string;
  /** Who was paid, and how much, in the settlement's currency. */
  to: string;
  amount: string;
  currency: string;
  /** The chain transfer: its hash, and the deterministic key it was written under (`/transfer/$from/$to/$key`). */
  tx_hash: string;
  transfer_key: string;
  created_at: number;
}

export type RecordBody =
  | PatchAnchor | Attestation | Settlement | Challenge | BranchInfo | PeerInfo | SupersedeRecord | SubscriptionRecord | RetireRecord
  | PriceRecord | PayoutRecord;

export interface LedgerInfo {
  kind: 'local' | 'ain';
  network: string;
  head?: string;
  height?: number;
  valid?: boolean;
  records: number;
  app?: string;
  provider?: string;
}

export interface Ledger {
  readonly kind: 'local' | 'ain';
  init(): Promise<void>;
  close(): Promise<void>;
  info(): Promise<LedgerInfo>;

  /** Append a record authored by this node (signed) and return it. */
  append<T extends RecordBody>(kind: RecordKind, body: T): Promise<LedgerRecord<T>>;
  /** Ingest a record received from a peer (signature is verified). Returns true if new. */
  ingest(record: LedgerRecord): Promise<boolean>;

  /** All records, oldest first (optionally after a timestamp). */
  list(opts?: { since?: number; kind?: RecordKind; limit?: number }): Promise<LedgerRecord[]>;
  get(hash: string): Promise<LedgerRecord | null>;
  hashes(since?: number): Promise<string[]>;
  /** Local-ledger replication: records received after a peer-local cursor. */
  sync?(since?: number, limit?: number): Promise<{ records: LedgerRecord[]; cursor: number }>;

  /** Convenience typed views. */
  anchors(): Promise<LedgerRecord<PatchAnchor>[]>;
  attestations(patchId?: string): Promise<LedgerRecord<Attestation>[]>;
  settlements(patchId?: string): Promise<LedgerRecord<Settlement>[]>;
  challenges(patchId?: string): Promise<LedgerRecord<Challenge>[]>;
  /** Contested sales and the sellers' answers (item 347). Optional: a ledger written before the kind existed has none. */
  disputes?(patchId?: string): Promise<LedgerRecord<Dispute>[]>;
  branches(): Promise<LedgerRecord<BranchInfo>[]>;
  nodes(): Promise<LedgerRecord<PeerInfo>[]>;
  supersedes(): Promise<LedgerRecord<SupersedeRecord>[]>;
  subscriptions(): Promise<LedgerRecord<SubscriptionRecord>[]>;

  /** Integrity check (hash + signature of every record; chain linkage for imported linear chains). */
  verify(): Promise<{ valid: boolean; checked: number; errors: string[] }>;
}

export interface LedgerEvents {
  onRecord?: (record: LedgerRecord) => void;
}
