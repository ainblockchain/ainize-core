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
  Attestation, BranchInfo, Challenge, LedgerRecord, PatchAnchor, PeerInfo, RecordKind, Settlement,
} from './types.js';

export interface SupersedeRecord {
  old_patch_id: string;
  new_patch_id: string;
  overlap_rows: number;
  reason: string;
}

export interface SubscriptionRecord {
  node: string;
  branch: string;
  action: 'subscribe' | 'unsubscribe';
  patch_ids: string[];
}

export type RecordBody =
  | PatchAnchor | Attestation | Settlement | Challenge | BranchInfo | PeerInfo | SupersedeRecord | SubscriptionRecord;

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
