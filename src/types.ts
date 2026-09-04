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
  /**
   * Optional inline sample set: {prompt, expect} pairs used by verifiers. Teach anchors carry at most
   * `TEACH_SAMPLES_ON_CHAIN` (the child's own first, then one per parent); the full list lives in the dataset blob's
   * `benchmark.jsonl`, whose canonical hash is `answers_hash`. `source` names the parent a sample was taken from, so a
   * verifier scores per source without fetching the parents (lineage design §5.1).
   */
  samples?: BenchmarkSample[];
  /** sha256 of the sealed answer set (commit–reveal, 청구항 19-2) — for teach anchors: sha256(canonical full sample list). */
  answers_hash?: string;
}
export interface BenchmarkSample { prompt: string; expect: string; source?: string }
/** How many benchmark samples a teach anchor carries on the ledger (lineage design §5.1, F10: ~100 KB AIN free tier). */
export const TEACH_SAMPLES_ON_CHAIN = 32;

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

/**
 * A data provider credited on an anchor (teach mode). The on-chain `author` is always the publishing node
 * (AIN write rule `auth.addr === newData.author`); contributors are signed claims carried inside the anchor body.
 */
export interface Contributor {
  /** Paid address. */
  address: string;
  /** Teaching key when different from `address` (payout wallet declared by the key holder). */
  signer?: string;
  /** Display name (≤ 40 chars; the operator may hide it in the UI). */
  name?: string;
  /** 0..1 fraction of the SELLER remainder after the lineage pool (carved sequentially, see royaltySplit). */
  share: number;
  role: 'data_provider';
  /** 'signed' = `sig` proves the claim; 'declared' = payout wallet typed by the key holder (can only receive). */
  proof: 'signed' | 'declared';
  /** Signature by `signer ?? address` over hashCanonical({patch_sha256, benchmark_hash, address, share}). */
  sig?: string;
}

/** Maximum number of contributors carried on one anchor (the knowledge app lives on the AIN free tier, ~100 KB state). */
export const MAX_CONTRIBUTORS = 4;

/** Where an anchor came from: registered by the operator (default when absent) or taught by a visitor. */
export type PatchOrigin = 'operator' | 'teach';

/**
 * Licences a training set (and the knowledge built from it) may carry (lineage design §6.4). The list is closed: an
 * unknown string is refused at publish (`bad_license`) rather than written into an immutable record nobody can read.
 *  - CC0 / CC-BY / ODC-By parent → any child licence (attribution travels through `parents[]`);
 *  - CC-BY-SA parent → the child must be CC-BY-SA with dataset access at least the parent's;
 *  - Proprietary parent → a child may build on top (the parent earns the lineage share) but ships delta-only: no
 *    inherited rows in its blob and no inherited benchmark samples on the record.
 */
export const DATASET_LICENSES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'ODC-By-1.0', 'Proprietary'] as const;
export type DatasetLicense = (typeof DATASET_LICENSES)[number];
export function isDatasetLicense(v: unknown): v is DatasetLicense { return typeof v === 'string' && (DATASET_LICENSES as readonly string[]).includes(v); }
/** Who may read a published training set (lineage design §6.1). Absent on an anchor = `private`. */
export const DATASET_ACCESS_LEVELS = ['public', 'derivative', 'private'] as const;
export type DatasetAccess = (typeof DATASET_ACCESS_LEVELS)[number];

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
  /** Data providers credited (and paid) for this patch — ≤ MAX_CONTRIBUTORS entries; absent on operator-registered anchors. */
  contributors?: Contributor[];
  /** 'teach' for visitor-taught knowledge; absent/'operator' for knowledge registered by the node operator. */
  origin?: PatchOrigin;
  /**
   * Teach mode v2 / lineage: provenance of the training set this knowledge was built from. Hashes and counts on the
   * record; the bytes live in the content-addressed dataset blob store and are served under `access`
   * (lineage design §5.1, §6 — revises teachable-dataset-design D12: ≤ 32 trained questions are public on the record
   * in any case, as benchmark samples). Absent `access` = `private` (every anchor written before the lineage fields).
   */
  dataset?: AnchorDataset;
  /**
   * What this knowledge did to its bases (lineage design §5.1). Absent = "declared parent — not trained on top"
   * (every pre-lineage anchor: `parents[]` is credit and royalty only, apply order stays last-wins).
   */
  derivation?: PatchDerivation;
  /**
   * The table state the body was trained against (claim 55): an ordered stack of knowledges that must be applied
   * BELOW this one. Absent = stand-alone build (today's semantics). `export: 'squash'` carries the parent rows itself
   * and has an empty stack.
   */
  base?: PatchBase;
}

export type DerivationKind = 'extend' | 'update' | 'contradict' | 'merge' | 'transfer'; // transfer reserved (claim 18)
export interface DerivationBase { patch_id: string; patch_sha256: string; dataset_sha256?: string; rows: number }
export interface PatchDerivation {
  kind: DerivationKind;
  /** ⊆ parents */
  bases: DerivationBase[];
  added_rows: number;
  changed_rows: number;
  removed_rows: number;
  /** merge only */
  policy?: 'keep_a' | 'keep_b' | 'manual';
  /** merge only */
  tier?: 'union' | 'retrain' | 'rebuild';
}
export interface PatchBase {
  /** ordered; the table state the delta was trained against */
  stack: { patch_id: string; patch_sha256: string }[];
  export: 'delta' | 'squash';
  /** sha256 over sorted (addr int64 LE ‖ bf16(before) bytes) of this knowledge's rows */
  pre_state_sha256: string;
}
export interface AnchorDataset {
  sha256: string;
  rows: number;
  source: TeachDatasetSource;
  /** who may read the training set (§6.1); absent = 'private' */
  access?: DatasetAccess;
  /** one of DATASET_LICENSES (§6.4) */
  license?: string;
  /** the training sets this one was built from (⊆ parents) */
  parents?: { patch_id: string; sha256: string; rows: number }[];
  /** leaf = sha256(canonical row); lets a private parent's rows be proven by inclusion */
  merkle_root?: string;
}

/** Generation recipe R = (corpus template, benchmark, hyper-params) — what is portable across models. */
export interface PatchRecipe {
  corpus_template?: string;
  hyperparams?: Record<string, unknown>;
  teacher_student?: boolean;
  /** Teach mode: the trained `Q:/A:` renderings (kept OUT of the anchor body; recipe/blob only). */
  sentences?: string[];
  /** Teach mode: contrast sentences trained alongside so unrelated prompts stay unchanged. */
  contrast?: string[];
  /** Teach mode: held-out paraphrases used for the generalisation check. */
  held_out?: string[];
  /** Model the recipe was produced on (id_M), for local-run instructions. */
  model_id?: string;
  /** Teach mode probe result after training. */
  probe?: { hits: number; total: number; heldout_hits?: number };
  /** Teach mode v2: which dataset (exact bytes + revision) this lesson was trained from — enough to re-train it. */
  dataset?: { sha256: string; rows: number; revision: number; source: TeachDatasetSource; name?: string };
  /** Lineage: the knowledges loaded into the table before step 1 (in order), with the rows each contributed. */
  parents?: { patch_id: string; sha256: string; rows: number; loaded?: boolean }[];
  export?: 'delta' | 'squash';
  pre_state_sha256?: string;
  /** fact index → table addresses of its renderings (recipe.json only — never on the anchor). */
  fact_addrs?: Record<number, number[]>;
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
  /**
   * @deprecated Historical field. Builds up to 2026-09 copied `verifier.stake` in here and the UI called it a
   * "deposit the verifier loses if it verified wrongly" — nothing was ever escrowed, transferred or slashed
   * (item 127). New attestations omit it; readers must not present it as money at risk.
   */
  stake?: string;
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
  /** @deprecated Historical field — see `Attestation.stake`. Nothing is escrowed; new challenges omit it. */
  stake?: string;
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
  /** sha256 of published training sets held (sliced to 40, like `blobs`); a child node re-advertises the parent sets it fetched. */
  datasets?: string[];
  /** The build that is RUNNING (`VERSION` from the code), not the string config.json was written with. */
  version: string;
  /** When this node's binaries were last built/edited — the only honest answer to "which build is that?" (item 141). */
  build?: string;
  /** `version` of config.json: the schema version it was written by, kept for migrations. */
  config_version?: string;
  last_seen: number;
}

export type NodeRole = 'seller' | 'verifier' | 'serving' | 'gateway';

/** Generic signed ledger record (local-ledger mode). Content-addressed by `hash`. */
/** Every kind of record the ledger holds — the closed list `ainize ledger ls --kind` offers. */
export const RECORD_KINDS = ['anchor', 'attest', 'settle', 'challenge', 'branch', 'node', 'supersede', 'subscribe'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

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

/**
 * Sampling sent to the serving model on one generation path (D1 — runaway/degenerate answers).
 * Every field is optional; an omitted field is simply not sent, so the server default applies.
 * Measured on the shared e2e instance (PROBE A/B, 2026-09-01): a stop sequence is the only knob that
 * lowered degeneration AND raised answer accuracy; repetition/frequency penalties left half the loops
 * in place and made the model refuse legitimately repetitive questions, so they default to unset.
 */
export interface SamplingOptions {
  /** Stop sequences (vLLM `stop`). Chat default ["\n\n\n\n", "<think>"]; completion default ["\n\n", "<think>"]. */
  stop?: string[];
  /** Cap on generated tokens when the caller does not pass one. */
  maxTokens?: number;
  temperature?: number;
  /** vLLM `repetition_penalty` (1 = off). Measured harmful at 1.1 — leave unset unless you re-measure. */
  repetitionPenalty?: number;
  /** vLLM `frequency_penalty` (0 = off). Lowers loops but costs correct answers. */
  frequencyPenalty?: number;
  /** vLLM `presence_penalty` (0 = off). */
  presencePenalty?: number;
  /** Post-generation degeneracy guard (repetition detector + truncation). Default on; `false` returns the raw text. */
  guard?: boolean;
}

/** Per-path sampling. `verify` is deliberately absent: benchmark verification always generates on the pre-guard settings. */
export interface RuntimeSampling {
  /** /v1/chat/completions — the path the web Live test uses. */
  chat?: SamplingOptions;
  /** /v1/completions — the operator's free-generation endpoint (verification and teach opt out explicitly). */
  complete?: SamplingOptions;
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
    /** Patch-hook mailbox of the serving instance `api` points at (default <repo>/ple_patch). One directory per
     *  vLLM instance: it carries the apply/remove requests and the cross-process runtime lock, so two servers
     *  (e.g. the demo cluster on its own GPUs and a second instance) never write into each other's table. */
    patchDir?: string;         // /mnt/newdata/qwen3.8/ple_patch_e2e
    /** Sampling + degeneracy guard per generation path (D1). Omit for the measured defaults. */
    sampling?: RuntimeSampling;
  };
  verifier?: {
    quorum: number;
    /**
     * @deprecated Never escrowed. Kept so existing config.json files still validate; the node ignores it and
     * neither attestations nor challenges carry it any more (item 127).
     */
    stake?: string;
    /** false (the default): the author of an anchor cannot attest it — the write is refused and such records never count toward the quorum. */
    allowSelfAttest: boolean;
    intervalMs: number;
    /** false = verify only on demand (`ainize patch verify` / POST /api/patches/:id/verify); no background rounds. Default true. */
    auto?: boolean;
  };
  market: {
    currency: 'AIN' | 'CREDIT';
    defaultPrice: string;
    royaltyShare: number;      // share of price distributed to lineage parents (0..1)
    initialCredit: string;     // local-credit wallet seed for new accounts
  };
  /**
   * HTTP server knobs. `trustProxy` is Express's `trust proxy` setting: `false` (default) → `req.ip` is the TCP peer, so a
   * client cannot pick its own address with X-Forwarded-For (per-IP quotas, bans and rate limits key on `req.ip`).
   * Behind a reverse proxy set it to the hop count (`1`), `'loopback'`, or the proxy's IP/CIDR list.
   */
  server?: { trustProxy?: boolean | number | string | string[] };
  /** Teach mode (visitor-taught knowledge). Absent in configs written before teach mode → `teachConfig()` fills the defaults. */
  teach?: TeachConfig;
  gossipIntervalMs: number;
  version: string;
  /** Show anchors marked visibility:'test' (e2e suites) in this node's catalog. */
  includeTestAnchors?: boolean;
}

/** Teach-mode policy and trainer settings (`config.json` → `teach`; defaults in `DEFAULT_TEACH_CONFIG`). */
export interface TeachConfig {
  /** Master switch — every visitor teach route answers 403 `teaching_disabled` while false. */
  enabled: boolean;
  /** What happens when a visitor publishes: operator review (default), automatic announce, or never. */
  publish: 'review' | 'auto' | 'never';
  factsPerJob: number;
  jobsPerKeyPerDay: number;
  jobsPerIpPerDay: number;
  queueMax: number;
  /** Default `Contributor.share` frozen into the anchor at publish (fraction of the seller remainder after lineage). */
  contributorShare: number;
  /** Private READY drafts expire after this many days without save/publish. */
  draftTtlDays: number;
  /** 'gradient' runs train/teach.py in the trainer container; 'stub' copies a fixture npz (CI/e2e, no GPU). */
  backend: 'gradient' | 'stub';
  /**
   * With `backend: 'stub'`: never touch the serving model — preflight answers and CHECKING are simulated
   * (a prompt that already contains the answer counts as "already known"; `LOCALITY_FAIL` in a fact fails the locality gate).
   * For CI / e2e nodes without a model server. Ignored for the gradient backend.
   */
  stubOffline?: boolean;
  trainer: {
    container: string;
    script: string;
    gpus: string;
    maxSteps: number;
    timeoutMs: number;
    minFreeGpuMb: number;
    idleStopMin: number;
  };
  /** Locality gate: fixed prompts whose greedy answers must stay identical for at least `minSame` of them. */
  locality: { prompts: string[]; minSame: number };
  /** Teach mode v2 — uploaded/collected datasets (design §6.4). */
  dataset: TeachDatasetLimits;
  /** How many questions one lesson may train. Derived at runtime from measured gradient runs; these are the bounds. */
  rowsPerJob: { floorGradient: number; floorStub: number; ceiling: number; safetyFactor: number };
  /** The three effort presets. `lr` is fixed for all three — nobody has measured that changing it helps. */
  effort: { quick: TeachEffortPreset; balanced: TeachEffortPreset; thorough: TeachEffortPreset; lr: number };
  /** CHECKING budget — independent of dataset size, so a 1000-question lesson holds the runtime lock no longer than an 8-question one. */
  check: { callBudget: number; sampleRows: number; chatFormRows: number; parentSamplesMax: number; lockTargetMs: number; lockAbortMs: number };
  /** Interactive preflight sampling. */
  preflight: { sampleRows: number; perCall: number };
  /** Total questions the queue may hold across all waiting lessons. */
  queuedRowsMax: number;
  /**
   * Feature flag `teach.lineage` (lineage design §18): while false the node refuses `base_ids` on a teach job and the
   * web hides "Build on this" / the basket base row / `--on`. Off until the runtime stack (L2) and the on-top trainer
   * (L3) are verified end to end on the gradient backend; the dataset blob, its access levels and `dataset get` do
   * not depend on it.
   */
  lineage?: boolean;
}

export interface TeachEffortPreset { maxSteps: number; evalEvery: number }

export interface TeachDatasetLimits {
  /** Upload byte cap (operator ceiling 20 MB); the QUESTION cap must always bite first so the message is readable. */
  maxBytes: number;
  /** Parse ceiling — beyond this the parser stops and says so. */
  maxSourceLines: number;
  /** Accepted questions stored per dataset. */
  maxRows: number;
  /** New datasets per teaching key per day. */
  perKeyPerDay: number;
  /** Datasets retained per key. */
  keptPerKey: number;
  /** Questions TRAINED per key per day. */
  rowsPerKeyPerDay: number;
  rowsPerIpPerDay: number;
  bytesPerKeyPerDay: number;
  /** `ready` datasets are swept this many days after their last job finished. */
  ttlDays: number;
  /** `staged` datasets never used by a job are swept after this many hours. */
  stagedTtlHours: number;
  /** In-memory per-IP create limiter (like `policyHits`). */
  createsPerIpPerMin: number;
  /** Above this many questions, publishing needs a rights/PII declaration. */
  declarationRows: number;
}

// ------------------------------------------------------------------ teach mode v2: the dataset (design docs/teachable-dataset-design.md §6.3)

/** How a dataset came to exist. `derived` = materialised from a v1 job's inline facts; `sample` = a node-shipped example. */
export type TeachDatasetSource = 'chat' | 'upload' | 'derived' | 'sample';
/** `staged` = parsed, never trained; `ready` = usable; `in_use` = a job is running against it; `deleted` = tombstone. */
export type TeachDatasetStatus = 'staged' | 'ready' | 'in_use' | 'deleted';

/**
 * The durable artifact the whole v2 teach UI is organised around: one canonical `rows.jsonl` on the node, owned by a
 * teaching key, hashed, versioned, and re-trainable. Both doors (chat basket / file upload) produce one of these.
 */
export interface TeachDataset {
  id: string;                       // uuid — NOT the sha256 (design §D3: dedup is scoped to the owner)
  owner_address: string;            // teaching key
  name: string;                     // ≤ 80 chars
  status: TeachDatasetStatus;
  source: TeachDatasetSource;
  sha256: string;                   // over the canonical rows.jsonl bytes
  revision: number;                 // bumped by every edit; (owner, sha256, revision) is unique
  rows: number;                     // accepted questions
  invalid_rows: number;
  size_bytes: number;               // rows.jsonl
  source_bytes?: number;            // the upload
  source_name?: string;             // original filename
  format?: TeachDatasetFormat;
  encoding?: string;                // what the parser decided, shown in the preview
  layout?: string;                  // txt sub-layout: 'tsv' | 'qa' | 'blocks' | 'prompts'
  delimiter?: string;
  has_header?: boolean;
  columns?: Record<string, string | number>;
  summary: TeachDatasetSummary;     // counts ONLY — never the per-row report (it is read paginated from disk)
  parent_dataset?: string;          // set by fork and by "add questions" on an in-use dataset
  retention: 'keep' | 'delete_after_training';
  job_ids: string[];
  created_at: number;
  updated_at: number;
  expires_at?: number;
  deleted_at?: number;
}

export type TeachDatasetFormat = 'jsonl' | 'json' | 'csv' | 'tsv' | 'txt';

/** Counts over the SOURCE rows — nothing is silently dropped, so every rejection has a bucket here. */
export interface TeachDatasetSummary {
  source_rows: number;
  accepted: number;
  fixed: number;
  rejected: number;
  duplicates: number;
  conflicts: number;
  blocked: number;
  too_long: number;
  empty: number;
  not_parsed: number;
  /** Accepted questions past `dataset.maxRows` — counted, never silently truncated. */
  over_cap: number;
  /** Advisory only (design §8.5): accepted questions that share their last three tokens with ≥ 2 others. */
  shared_ending: number;
  /**
   * Accepted questions that look like personal information (an e-mail, a phone number, a resident registration number,
   * a card number that passes Luhn). They train, and they block publishing the training set above `private`
   * (lineage design §6.5). Absent in reports written before the check existed.
   */
  pii?: number;
  langs: Record<TeachDatasetLang, number>;
}

export type TeachDatasetLang = 'hangul' | 'latin' | 'han' | 'kana' | 'other';

/**
 * Per-source-row status. `ok`, `fixed` and `pii` enter rows.jsonl (a `pii` row trains, but keeps the training set
 * from being published above `private` until it is removed); `over_cap` is an accepted question that did not fit
 * this node's per-dataset cap.
 */
export type TeachRowStatus =
  | 'ok' | 'fixed' | 'pii' | 'duplicate' | 'conflict' | 'too_long' | 'empty' | 'blocked' | 'not_parsed' | 'over_cap';
/** Kinds of personal information the parser looks for (lineage design §6.5). */
export type TeachPiiKind = 'email' | 'phone' | 'rrn' | 'card';
/** Row statuses that mean "this question is in rows.jsonl" (the helper every filter should use instead of listing the two or three by hand). */
export const ACCEPTED_ROW_STATUSES: readonly TeachRowStatus[] = ['ok', 'fixed', 'pii'];
export const isAcceptedRowStatus = (s: string | undefined): boolean => !!s && (ACCEPTED_ROW_STATUSES as readonly string[]).includes(s);

/** One entry per SOURCE row — accepted or not. `index` is the position in rows.jsonl, null when the row was not accepted. */
export interface TeachDatasetRow {
  index: number | null;
  /** 1-based LOGICAL source row (a quoted CSV newline is one row, not two). */
  line: number;
  status: TeachRowStatus;
  prompt?: string;
  answer?: string;
  alt_prompt?: string;
  note?: string;
  /** 'answer_flattened' | 'whitespace_collapsed' | 'controls_stripped' | 'qa_prefix_stripped' | 'note_truncated' */
  fixes?: string[];
  /** Never blocks training. */
  advisory?: 'shared_ending'[];
  /** Only with `status: 'pii'` — what was found (the row still trains; it blocks publishing above `private`). */
  pii?: TeachPiiKind[];
  /**
   * Provenance of an inherited question (lineage design §5.2): `from = '<parent knowledge>#<row index>'` on a row
   * copied unchanged from the training set this one was forked from, `replaces` on a row whose answer was changed.
   * The rows table renders them as the *from {name}* chip and the Mine / Inherited / Changed filters.
   */
  from?: string;
  replaces?: string;
  /** e.g. 'conflicts with line 41', 'answer is 240 characters (40 over the 200 limit)' */
  detail?: string;
  /** ≤ 200 chars, only for not_parsed. */
  raw?: string;
  lang?: TeachDatasetLang;
}

/** What a job records about its input (`job.dataset`). A v1 job renders with `id: null` and `source: 'derived'`. */
export interface TeachDatasetRef {
  id: string | null;
  sha256: string | null;
  revision?: number;
  rows: number;
  source: TeachDatasetSource;
  name?: string;
  trained_rows: number;
  selected_indexes?: number[];
  /** Live-model check coverage when the dataset was too big to check whole. */
  sampled?: { checked: number; of: number };
  deleted?: true;
}

/** Effort preset a job was trained with (design §D6: presets change `max_steps` and nothing else the visitor can see). */
export type TeachEffort = 'quick' | 'balanced' | 'thorough';

export interface TeachTrainingSpec {
  effort: TeachEffort;
  max_steps: number;
  eval_every: number;
  lr: number;
  rows_limit?: number;
  row_offset?: number;
  check_side_effects: boolean;
  use_alt: boolean;
  /** Positions in the dataset this lesson trained, in order: `job.facts[i]` is `dataset.rows[selected_indexes[i]]`. */
  selected_indexes?: number[];
}
