/**
 * Shared domain types for the n-gram knowledge patch marketplace.
 *
 * Vocabulary follows the patent specification (10-출원명세서-전문.md):
 *  - Patch (지식 패치): rows (addr, before, after) of an n-gram conditional-memory table + model identity.
 *  - Benchmark (벤치마크): queries/answers + collateral bound used to machine-verify a patch.
 *  - Anchor / Attest / Settle: ledger record kinds (등록·증명·정산 블록).
 *  - Publish state machine: DRAFT → ANNOUNCED → VERIFYING → LISTED | REJECTED, LISTED → CHALLENGED → VERIFYING.
 */

export type PatchStatus =
  | 'DRAFT'
  | 'ANNOUNCED'
  | 'VERIFYING'
  | 'LISTED'
  | 'REJECTED'
  | 'CHALLENGED'
  | 'SUPERSEDED';

export const PATCH_STATUSES: PatchStatus[] = [
  'DRAFT', 'ANNOUNCED', 'VERIFYING', 'LISTED', 'REJECTED', 'CHALLENGED', 'SUPERSEDED',
];

/** Billing model for a patch (청구항 12). */
export type BillingModel = 'per_download' | 'per_apply_hour' | 'per_hit';

export interface BenchmarkSpec {
  /** Stable id of the benchmark schema (e.g. "krx-ticker-codes"). Patches sharing a schema are comparable/conflicting. */
  schema: string;
  /** Number of queries. */
  queries: number;
  /** Prompt formats included. */
  format: string[];
  /** Collateral (locality) bound in nats for unrelated-text logprob drift. */
  collateral_bound_nat?: number;
  /** Optional inline sample set: {prompt, expect} pairs used by verifiers. */
  samples?: { prompt: string; expect: string }[];
  /** sha256 of the sealed answer set (commit–reveal, 청구항 19-2). */
  answers_hash?: string;
}

export interface ModelIdentity {
  /** Human name, e.g. "Qwen3.8-Flash-Next-W4A16". */
  id_M: string;
  /** Checkpoint hash (optional in dev). */
  checkpoint_hash?: string;
  /** Tokenizer hash. */
  tokenizer_hash?: string;
  /** Hash constant / seed of the n-gram address function. */
  hash_const?: string;
  /** Row width (embedding dim) of the table. */
  row_dim?: number;
}

/** Public, on-ledger description of a patch (anchor body). */
export interface PatchAnchor {
  id: string;
  name: string;
  description: string;
  author: string;            // AIN address of the author node
  author_name?: string;      // display name
  model: ModelIdentity;
  patch_sha256: string;      // sha256 of the .npz body
  size_bytes: number;
  rows: number;
  benchmark: BenchmarkSpec;
  benchmark_hash: string;    // sha256(canonical(benchmark))
  price: string;             // decimal string in `currency`
  currency: 'AIN' | 'USDC' | 'CREDIT';
  billing: BillingModel;
  license?: string;
  parents: string[];         // lineage: parent patch ids (파생 패치)
  parent_authors: string[];  // convenience for royalty split
  branch?: string;           // knowledge branch this patch belongs to (e.g. "law/KR")
  topic_path: string;        // ain-js knowledge topic path (e.g. "finance/krx")
  recipe?: PatchRecipe;      // transfer recipe R (전이 계층)
  created_at: number;
  /** Address-set sketch (MinHash-like) for cheap conflict pre-checks across peers. */
  addr_sketch?: number[];
  /** Deposit / bond for verification (청구항 19). */
  bond?: string;
  /** 'test' anchors (e2e suites on a shared dev chain) are hidden from catalogs unless explicitly requested. */
  visibility?: 'public' | 'test';
}

/** Generation recipe R = (corpus template, benchmark, hyper-params) — what is portable across models. */
export interface PatchRecipe {
  corpus_template?: string;
  hyperparams?: Record<string, unknown>;
  teacher_student?: boolean;
}

export interface Attestation {
  patch_id: string;
  verifier: string;          // AIN address
  verifier_name?: string;
  patch_sha256: string;
  benchmark_hash: string;
  score: Record<string, string | number>;   // e.g. {free_generation: "2761/2761"}
  passed: boolean;
  collateral_nat?: number;
  /** "vllm" (independent engine), "hook", or "hash-only" when no runtime was available. */
  verified_on: string;
  /** Restart-aware verification: number of reversions detected & re-applied (청구항 2(d)). */
  restarts_detected?: number;
  stake: string;
  sig: string;
  created_at: number;
}

export interface Settlement {
  patch_id: string;
  seller: string;
  buyer: string;
  amount: string;
  currency: string;
  scheme: string;            // 'ain-transfer' | 'local-credit'
  tx_hash: string;           // AIN tx hash or local proof id
  royalty: Record<string, string>;   // address → amount
  billing: BillingModel;
  created_at: number;
}

export interface Challenge {
  patch_id: string;
  challenger: string;
  reason: string;
  stake: string;
  created_at: number;
}

export interface BranchInfo {
  name: string;               // e.g. "law/KR"
  description: string;
  /** Context attribute mapping used by the gateway router (청구항 17-2), e.g. {jurisdiction: "KR"}. */
  context: Record<string, string>;
  owner: string;
  patch_ids: string[];
  created_at: number;
}

export interface PeerInfo {
  address: string;            // AIN address = node identity
  public_key?: string;
  name: string;
  endpoint: string;           // http://host:port
  roles: NodeRole[];
  ledger: 'local' | 'ain';
  chain_id?: number;
  model?: string;             // id_M served by this node (if serving)
  branches: string[];         // subscribed branches
  blobs: string[];            // sha256 of patch bodies held
  version: string;
  last_seen: number;
}

export type NodeRole = 'seller' | 'verifier' | 'serving' | 'gateway';

/** Generic signed ledger record (local-ledger mode). Content-addressed by `hash`. */
export type RecordKind = 'anchor' | 'attest' | 'settle' | 'challenge' | 'branch' | 'node' | 'supersede' | 'subscribe';

export interface LedgerRecord<T = unknown> {
  hash: string;               // sha256(canonical({kind, body, author, ts, parents}))
  kind: RecordKind;
  body: T;
  author: string;             // AIN address
  ts: number;
  /** Hashes of records this one causally depends on (DAG). */
  parents: string[];
  sig: string;                // ain-util ecSignMessage(hash) by author
}

export interface X402Requirement {
  scheme: 'ain-transfer' | 'local-credit';
  network: string;            // 'ain:local' | 'ain:testnet' | 'local'
  asset: string;              // 'AIN' | 'CREDIT'
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  nonce: string;
  expires_at: number;
  /** For ain-transfer: the transfer key the payer must use so the seller can look up /transfer/$from/$to/$key. */
  transfer_key?: string;
}

export interface X402Payload {
  scheme: 'ain-transfer' | 'local-credit';
  network: string;
  txHash: string;
  from?: string;
  to?: string;
  amount?: string;
  transfer_key?: string;
  nonce?: string;
  /** local-credit: HMAC proof issued by the facilitator. */
  proof?: string;
}

/** Manifest returned as the gated x402 content (text) — verified via on-chain content_hash by ain-js. */
export interface PatchManifest {
  id: string;
  patch_sha256: string;
  size_bytes: number;
  rows: number;
  model: ModelIdentity;
  benchmark_hash: string;
  /** Peers that advertise the blob. */
  blob_urls: string[];
  issued_to: string;
  issued_at: number;
  /** Bearer token for the blob endpoint, signed by the issuing node. */
  download_token: string;
}

export interface RuntimeStatus {
  available: boolean;
  api: string | null;
  model: string | null;
  hook: boolean;
  repo: string | null;
  applied: string[];          // patch ids currently applied (from watchdog state)
  error?: string;
  /** Raw upstream text of the last model-side failure (logs / diagnostics; `error` stays the friendly message). */
  detail?: string;
}

export interface NodeConfig {
  name: string;
  dataDir: string;
  port: number;
  host: string;
  publicUrl?: string;
  roles: NodeRole[];
  peers: string[];
  ledger: {
    kind: 'local' | 'ain';
    ain?: {
      providerUrl: string;
      eventHandlerUrl?: string | null;
      chainId: number;
      appName: string;         // 'knowledge' (ain-js default)
    };
  };
  identity: {
    privateKey: string;        // hex (dev); production would use keystore
    address: string;
    publicKey: string;
  };
  operatorPasswordHash?: string;
  runtime?: {
    repo?: string;             // /mnt/newdata/qwen3.8
    api?: string;              // http://localhost:8000
    hookApi?: string;          // http://localhost:8001
    python?: string;
  };
  verifier?: {
    quorum: number;
    stake: string;
    allowSelfAttest: boolean;
    intervalMs: number;
  };
  market: {
    currency: 'AIN' | 'CREDIT';
    defaultPrice: string;
    royaltyShare: number;      // share of price distributed to lineage parents (0..1)
    initialCredit: string;     // local-credit wallet seed for new accounts
  };
  gossipIntervalMs: number;
  version: string;
  /** Show anchors marked visibility:'test' (e2e suites) in this node's catalog. */
  includeTestAnchors?: boolean;
}
