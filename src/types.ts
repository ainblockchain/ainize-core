/**
 * Shared domain types for the n-gram knowledge patch marketplace.
 *
 * Vocabulary follows the patent specification (10-출원명세서-전문.md):
 *  - Patch (지식 패치): rows (addr, before, after) of an n-gram conditional-memory table + model identity.
 *  - Benchmark (벤치마크): queries/answers + collateral bound used to machine-verify a patch.
 *  - Anchor / Attest / Settle: ledger record kinds (등록·증명·정산 블록).
 *  - Publish state machine: DRAFT → ANNOUNCED → VERIFYING → LISTED | REJECTED, LISTED → CHALLENGED → VERIFYING,
 *    and any announced state → RETIRED when the author writes a `retire` record (the record stays; the sale stops).
 */

export type PatchStatus =
  | 'DRAFT'
  | 'ANNOUNCED'
  | 'VERIFYING'
  | 'LISTED'
  | 'REJECTED'
  | 'CHALLENGED'
  | 'SUPERSEDED'
  /** The author appended a `retire` record: the anchor stays on the permanent record, the knowledge stops being sold. */
  | 'RETIRED';

export const PATCH_STATUSES: PatchStatus[] = [
  'DRAFT', 'ANNOUNCED', 'VERIFYING', 'LISTED', 'REJECTED', 'CHALLENGED', 'SUPERSEDED', 'RETIRED',
];

/** Billing model for a patch (청구항 12). */
export type BillingModel = 'per_download' | 'per_apply_hour' | 'per_hit';

/**
 * The billing models a node can actually charge (finding 360).
 *
 * All three were offered on the publish form and printed to buyers as "pay per hour loaded" and "pay per use",
 * and `settlePayment` charges `anchor.price` exactly once per 402 round and copies `billing` onto the settlement.
 * Nothing anywhere meters an hour or a use. So a seller picked a revenue model the product does not implement,
 * and a buyer was told they were paying by the hour when they had paid once. Anchors already carrying one of the
 * other two keep it — the record is immutable — and every surface says what really happens to them; they are no
 * longer OFFERED to anyone new.
 */
export const BILLING_IMPLEMENTED: readonly BillingModel[] = ['per_download'];
export const billingImplemented = (b: unknown): b is BillingModel => BILLING_IMPLEMENTED.includes(b as BillingModel);

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

/**
 * The floor under `PatchAnchor.royalty_share` (item 191). Every public surface of this product promises the original
 * creators 30 % of each sale; before this constant that promise was `market.royaltyShare` on the node doing the
 * SELLING, so a derivative's seller could set it to 0 and keep the base creator's share while her page still said
 * 30 %. A seller may promise MORE (config, or a parent that already promised more); it may never promise less.
 */
export const NETWORK_MIN_ROYALTY_SHARE = 0.3;
/**
 * The floor under `PatchAnchor.verifier_share` (item 325): the fraction of the seller's side of each sale that is
 * divided equally among the attestations that count toward the knowledge's quorum. Verification is a GPU minute and
 * a gigabyte of someone else's body per item; before this it earned nothing anywhere in the product.
 */
export const NETWORK_MIN_VERIFIER_SHARE = 0.05;
/** Hard ceiling on the verification fee, whatever a config or a peer-written anchor claims. */
export const MAX_VERIFIER_SHARE = 0.5;
/** How many wrong answers one attestation carries back to the author (item 155). */
export const ATTESTATION_MAX_FAILURES = 5;
/** Truncation for the prompt / expected / actual strings in `Attestation.failures` (item 155). */
export const ATTESTATION_PROMPT_MAX = 200;
export const ATTESTATION_GOT_MAX = 120;
/** A challenge takes a knowledge off sale everywhere: it has to say why, in at least this many characters (item 328). */
export const CHALLENGE_MIN_REASON = 20;
/**
 * How long one address's challenge holds a knowledge before the same address may file another on it (item 328). A
 * challenge is free and stops every sale, so without this one node could keep a rival off sale for ever by re-filing.
 */
export const CHALLENGE_COOLDOWN_MS = 24 * 3600_000;

/** Effective lineage share for one sale: what the ANCHOR promised, floored at the network minimum (item 191). */
export function effectiveRoyaltyShare(anchor: { royalty_share?: number } | undefined, configured = NETWORK_MIN_ROYALTY_SHARE): number {
  const declared = typeof anchor?.royalty_share === 'number' && Number.isFinite(anchor.royalty_share) ? anchor.royalty_share : configured;
  return Math.min(1, Math.max(NETWORK_MIN_ROYALTY_SHARE, Number.isFinite(declared) ? declared : NETWORK_MIN_ROYALTY_SHARE));
}
/** Effective verification share for one sale: what the ANCHOR promised, floored at the network minimum (item 325). */
export function effectiveVerifierShare(anchor: { verifier_share?: number } | undefined, configured = NETWORK_MIN_VERIFIER_SHARE): number {
  const declared = typeof anchor?.verifier_share === 'number' && Number.isFinite(anchor.verifier_share) ? anchor.verifier_share : configured;
  return Math.min(MAX_VERIFIER_SHARE, Math.max(NETWORK_MIN_VERIFIER_SHARE, Number.isFinite(declared) ? declared : NETWORK_MIN_VERIFIER_SHARE));
}

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
  /**
   * The day the DATA this was trained on is true of — `YYYY-MM-DD`, declared by the publisher (item 267).
   *
   * `created_at` is when the file was registered and `listed_at` is the newest attestation, so a knowledge baked
   * from yesterday's feed and registered this morning looked exactly as fresh as one baked an hour ago, and the
   * only place the data's own date lived was the name string every daily publisher invented for themselves
   * ("krx-codes-2026-09-03"). Optional, because most knowledge has no such day; absent on every anchor written
   * before the field, which is why a reader must fall back to `created_at` and say which one it is showing.
   */
  as_of?: string;
  /** Address-set sketch (MinHash-like) for cheap conflict pre-checks across peers. */
  addr_sketch?: number[];
  /** Deposit / bond for verification (청구항 19). */
  bond?: string;
  /**
   * The lineage share this knowledge promises its ancestors: the fraction of every sale that is divided among the
   * authors it was built on (item 191). Written into the anchor at createDraft — never read from the SELLING node's
   * config, which the seller controls — as `max(NETWORK_MIN_ROYALTY_SHARE, this node's market.royaltyShare, every
   * parent anchor's declared share)`, so a derivative can raise what its parents promised but never lower it.
   * Absent on anchors written before the field: readers fall back to `max(NETWORK_MIN_ROYALTY_SHARE, config)`.
   */
  royalty_share?: number;
  /**
   * The verification share this knowledge promises the verifiers that attested it: the fraction of the seller's side
   * of every sale divided equally among the attestations that count toward its quorum (item 325). Same rule as
   * `royalty_share`: written at createDraft, floored at NETWORK_MIN_VERIFIER_SHARE, never taken from the seller's
   * config at settle time.
   */
  verifier_share?: number;
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
   * Up to ATTESTATION_MAX_FAILURES benchmark questions this run got WRONG, with what the model actually answered
   * (item 155). Signed with the rest of the body: a FAIL that says only "0/2" gives the author nothing to fix, and
   * the evidence existed — it was in the verifier's private event log and was thrown away on the way to the record.
   * `got` is truncated to ATTESTATION_GOT_MAX chars; absent on hash-only attestations and on every record written
   * before the field.
   */
  failures?: { prompt: string; expect: string; got: string }[];
  /**
   * Which model server executed this benchmark (item 329). `instance` is a 16-hex fingerprint of the engine — its
   * API origin, the served model id, and the engine's own start time when it reports one — so two verifier processes
   * sharing ONE vLLM produce the SAME instance and the catalog can say "2 attestations, 1 model server" instead of
   * "2 independent verifiers". Absent on hash-only attestations (nothing executed) and on pre-field records.
   */
  executor?: { api: string | null; model: string | null; engine_started?: number; instance: string };
  /**
   * false when this node already had the knowledge applied to the shared model, so the run had no un-patched
   * baseline of its own (item 329). Such an attestation is recorded but never counted toward a quorum.
   */
  baseline?: boolean;
  /**
   * @deprecated Historical field. Builds up to 2026-09 copied `verifier.stake` in here and the UI called it a
   * "deposit the verifier loses if it verified wrongly" — nothing was ever escrowed, transferred or slashed
   * (item 127). New attestations omit it; readers must not present it as money at risk.
   */
  stake?: string;
  /**
   * What the run cost (item 340). Without it a 4-question run and a 40-question run on a 2,761-fact knowledge read
   * identically to every buyer and to any payout rule built on top, which would price the cheapest possible run
   * exactly like the careful one. `samples_available` is the anchor's whole question set; `samples_run` is what this
   * verifier actually asked; `duration_ms` is the wall time of the measured section (probe, baseline, apply, score,
   * restore). Absent on hash-only attestations and on every record written before the field.
   */
  duration_ms?: number;
  samples_run?: number;
  samples_available?: number;
  /**
   * A deliberate re-measurement of something this verifier had already attested (item 339) — after a model update, a
   * buyer complaint, a doubt. It is NOT a challenge: it does not take the seller off sale. A recheck that FAILS
   * withdraws this verifier's earlier PASS; one that passes is a visible confirmation.
   */
  recheck?: true;
  /**
   * How much of the body this verifier scored is its declared parents', address for address (item 303): parent id →
   * rows this body shares with it, and `rows` is the body's own row count. A one-fact lesson that ships 2,992 of its
   * base's rows is a resale, and only the node that holds both files can say so. Absent when this node did not hold
   * a parent body to compare against.
   */
  rows_shared_with_parents?: Record<string, number>;
  rows?: number;
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
  /**
   * Lineage the seller's node could not resolve when it priced this sale (item 310): parent id → the amount that
   * ancestor's author was owed. The money is NOT in `royalty` and was NOT kept by the seller — the sale says out
   * loud that a share of it has no payee yet, instead of silently paying the seller 100 %.
   */
  royalty_unresolved?: Record<string, string>;
  billing: BillingModel;
  created_at: number;
}

/**
 * A settled buyer says the knowledge they paid for did not work, and the seller answers on the same record (item 347).
 *
 * /terms is honest that "refunds are at the seller's discretion and are not mediated by the protocol" and that a
 * payment "is final once executed" — and non-delivery IS recoverable, because a settled buyer can always fetch the
 * body with a signed header. What was unrecoverable, and unrecorded, is the one thing a buyer cannot get back:
 * quality. The only lever was `patch challenge`, which spends other operators' GPU time, pays the challenger nothing,
 * takes the seller off sale, and appears on no buyer surface — so a bad seller's record stayed clean.
 *
 * A dispute is NOT a challenge: it does not stop sales and it asks nobody to re-run a benchmark. It is a record that
 * a sale was contested, counted per seller, with the seller's answer beside it.
 */
export interface Dispute {
  patch_id: string;
  /** 'claim' by the buyer; 'answer' by the seller of the same settlement. */
  role: 'claim' | 'answer';
  author: string;
  /** The settlement this is about — the buyer's proof they paid for it. */
  settle_hash: string;
  /** At least DISPUTE_MIN_REASON characters: what did not work. */
  reason: string;
  created_at: number;
  sig: string;
}

/** A dispute has to say something: the same floor a challenge reason has. */
export const DISPUTE_MIN_REASON = 20;
export const DISPUTE_MAX_REASON = 1000;

export interface Challenge {
  patch_id: string;
  challenger: string;
  /** Why the challenger thinks the benchmark no longer holds — at least CHALLENGE_MIN_REASON chars (item 328). */
  reason: string;
  /** @deprecated Historical field — see `Attestation.stake`. Nothing is escrowed; new challenges omit it. */
  stake?: string;
  created_at: number;
}

/**
 * What a track costs to subscribe to, per period (finding 359).
 *
 * There was no subscription: `BranchInfo` carried name, description, context and ids and no terms at all, prices
 * are per anchor, and a track owner who curates other people's knowledge received nothing for curating. So the
 * most loyal customer was the most expensive one — every day of a daily track is a fresh full-price sale — and
 * nobody was paid to keep a channel good. This is the CURATION fee, paid to the track's owner once per period; the
 * knowledge on the track is still bought from whoever published it, because it is theirs.
 */
export interface SubscriptionTerms {
  /** What one period of curation costs, in `currency`. '0' is a free track that still has terms. */
  price: string;
  currency: string;
  /** How long one payment lasts, in days. */
  period_days: number;
}

export interface BranchInfo {
  name: string;               // e.g. "law/KR"
  description: string;
  /** Context attribute mapping used by the gateway router (청구항 17-2), e.g. {jurisdiction: "KR"}. */
  context: Record<string, string>;
  owner: string;
  patch_ids: string[];
  /** The curation fee, set by the owner (finding 359). Absent = free to subscribe, as every track was before. */
  terms?: SubscriptionTerms;
  created_at: number;
  /**
   * `test` = a fixture track: hidden from /network, from `GET /api/branches` (unless `include_test`) and from the
   * router, exactly as `PatchAnchor.visibility` already worked for anchors (item 269). The one page that sells
   * "subscribe to a track" was 32 throwaway `e2e/*` rows and three real ones, and nothing could ever be taken off.
   * Absent = `public`, so every track written before this field keeps reading as one.
   */
  visibility?: 'public' | 'test';
  /** The owner is done with this track: kept on the record, hidden from the lists and never routed to (item 269). */
  archived?: boolean;
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
  /**
   * What this node has LOADED in its serving model right now, bottom first (item 234). `branches` records what a
   * node once subscribed to; a router that sends traffic on that alone can pick a node serving the superseded bake,
   * a rejected one, or nothing at all. Absent on records written before the field.
   */
  applied?: string[];
  blobs: string[];            // sha256 of patch bodies held
  /** sha256 of published training sets held (sliced to 40, like `blobs`); a child node re-advertises the parent sets it fetched. */
  datasets?: string[];
  /** The build that is RUNNING (`VERSION` from the code), not the string config.json was written with. */
  version: string;
  /** When this node's binaries were last built/edited — the only honest answer to "which build is that?" (item 141). */
  build?: string;
  /** `version` of config.json: the schema version it was written by, kept for migrations. */
  config_version?: string;
  /**
   * A per-START id, minted when the node process boots (item 139). Two endpoints presenting one ADDRESS is either a
   * node that moved — same instance, new URL — or two nodes running on one identity, which silently breaks every
   * download and attestation routed by address. Without this the two cases are indistinguishable.
   */
  instance?: string;
  /**
   * What this node offers the people who publish through it (item 307). The split a teacher is shown was the local
   * operator's config value, take it or leave it, and there was no surface anywhere comparing what another node
   * offers — the person contributing the data had no lever and no market. `teach` is the share of a sale this node
   * pays the teacher; `royalty` and `verifier` are what its anchors promise ancestors and verifiers.
   * Absent on a node that does not accept contributions, and on every record written before the field.
   */
  shares?: { teach?: number; royalty: number; verifier: number };
  /**
   * The other half of this node's terms (item 368): how many independent attestations it requires before it calls
   * anything verified, what it prices a knowledge at when the publisher names none, and whether it takes lessons
   * from visitors at all. With `shares` and `ledger` this is everything a creator choosing where to publish, or a
   * buyer wondering what their money splits into, has to compare — and none of it was published before.
   * Absent on a node running an older build: a consumer must say "not published", never assume a default.
   */
  quorum?: number;
  default_price?: string;
  accepts_contributions?: boolean;
  last_seen: number;
}

export type NodeRole = 'seller' | 'verifier' | 'serving' | 'gateway';

/** Generic signed ledger record (local-ledger mode). Content-addressed by `hash`. */
/** Every kind of record the ledger holds — the closed list `ainize ledger ls --kind` offers. */
export const RECORD_KINDS = ['anchor', 'attest', 'settle', 'challenge', 'branch', 'node', 'supersede', 'subscribe', 'retire', 'dispute', 'price', 'payout'] as const;
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

/**
 * One knowledge the buyer must ALSO hold for the quoted one to work (lineage design §12.5): an add-on trained on
 * top of a base is useless without that base underneath, and its price is not part of the quoted price. Deepest
 * ancestor first — the order they have to be loaded in.
 */
export interface X402Required {
  id: string;
  name: string;
  price: string;
  currency: string;
  author: string;
  author_name?: string | null;
  /** where that one is sold (its own anchor's gateway), when this node knows it */
  gateway_url?: string | null;
  /** how far below the quoted knowledge it sits (1 = its own base) */
  depth: number;
  /** false when the quoting node has never seen that anchor: its price is in no total and the buyer must find it */
  known: boolean;
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
  /** The bases this knowledge needs underneath it, deepest first — each one a separate purchase (finding 270). */
  requires?: X402Required[];
  /** `maxAmountRequired` + every `requires[]` price: what the whole family costs at list price. */
  total?: string;
  /** true when this body stands alone (no base stack, or a squash that carries its bases' rows). */
  self_contained?: boolean;
  /** The nonce is spent by the settlement that redeems it; a rejected attempt leaves it usable (finding 272). */
  single_use?: boolean;
  /**
   * What is being sold, on the quote itself (finding 236). An x402 client is not an ainize node: it has the 402 and
   * nothing else, so a script assembling a set from ids seen last week used to buy and stack retired versions with
   * no way to know, and no agent could decide on lineage, licence or who is paid BEFORE paying.
   *
   * `status` is the seller's own catalogue status (`LISTED` | `SUPERSEDED`); `superseded_by` names the newer
   * versions; `license` is the anchor's SPDX id; `lineage.standalone` is true when nothing is declared underneath;
   * `split_preview` is the same `royaltyPlan` that will settle the sale, so the buyer sees the split before paying
   * and can compare it with the one on the receipt afterwards.
   */
  status?: string;
  superseded_by?: string[];
  license?: string | null;
  lineage?: { parents: { id: string; author: string | null; name: string | null }[]; standalone: boolean };
  split_preview?: { address: string; name: string | null; role: string; amount: string }[];
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
    /**
     * Which GPUs the serving instance `api` addresses occupies, e.g. "4,5" (item 145). Nothing on the node can
     * discover this — the model is behind an HTTP URL — and without it the teach trainer cannot be stopped from
     * being pointed at the GPUs that serve every verification and live test. Unset = no cross-check is possible.
     */
    gpus?: string;
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
    /**
     * Sell knowledge that has NOT met the quorum, at the buyer's risk. Off by default.
     *
     * It does NOT change the status: an unverified anchor stays ANNOUNCED or VERIFYING and is never
     * relabelled LISTED. Verification is the one quality signal this marketplace has, and a status claiming
     * "verified" when nobody checked would be worth less than no status at all. What this permits is a buyer
     * choosing, with the attestation count in front of them, to take the risk — which is a different thing
     * from the network hiding that there is one.
     */
    sellUnverified?: boolean;
    intervalMs: number;
    /** false = verify only on demand (`ainize patch verify` / POST /api/patches/:id/verify); no background rounds. Default true. */
    auto?: boolean;
    /**
     * Stop attesting below this balance, on a chain that charges gas (item 341). An attestation is a write the
     * VERIFIER signs and pays for, and `verifier.auto` would keep writing until the account was empty — at which
     * point every other thing this node does on chain (announce, settle, payout) fails too. Ignored on the local
     * ledger, which has no gas.
     */
    minBalance?: number;
    /**
     * Verify anchors published with `visibility: 'test'` (item 332). Default FALSE: on the demo chain 209 of 213
     * anchors were hidden test listings nobody can buy, and every e2e run of every other workstream cost each
     * verifier a download and a benchmark.
     */
    includeTest?: boolean;
    /** Skip anchors priced below this (decimal string, item 332). Default '0' — verify everything, free items included. */
    minPrice?: string;
    /** At most this many items per rolling hour (item 332). Default 40; 0 disables background verification entirely. */
    maxPerHour?: number;
    /**
     * Minutes of shared-model lock this node will spend verifying per rolling hour (items 332 / 333). Default 10 —
     * node-b spent 54.9 min on one demo afternoon, all of it in front of its own visitors.
     */
    maxModelMinutesPerHour?: number;
    /** Local-time window `{from: 'HH:MM', to: 'HH:MM'}` outside which no background verification starts (item 333). */
    window?: { from: string; to: string } | null;
    /**
     * Keep a body after the attestation that needed it counted (item 336). Default FALSE: a verifier's disk grew to
     * 932 MB of files it neither wrote nor bought. Bodies this node authored, bought or serves are never dropped.
     */
    retainBodies?: boolean;
  };
  market: {
    currency: 'AIN' | 'CREDIT';
    defaultPrice: string;
    royaltyShare: number;      // share of price distributed to lineage parents (0..1)
    /**
     * Share of the SELLER side of each sale paid to the verifiers whose attestations count for that knowledge
     * (item 325). Written into every anchor this node creates and floored at NETWORK_MIN_VERIFIER_SHARE when it
     * is read back, so a seller cannot publish knowledge that pays its verifiers nothing.
     */
    verifierShare?: number;
    initialCredit: string;     // local-credit wallet seed for new accounts
    /**
     * How many addresses this node will ever hand `initialCredit` to (default 100). Local credit is issued by the
     * node, not owned by the buyer: without a cap a fresh keypair is worth 100 CREDIT and any spend limit is one
     * `ainize keys new` away (item 364). Every grant is recorded; past the cap a new address gets nothing.
     */
    creditGrants?: number;
  };
  /**
   * What this node accepts from the gossip network (items 136/137). Peer exchange used to add every endpoint any
   * peer advertised — no cap, no record of where it came from, no way to refuse — so an operator could not answer
   * "who is my node talking to?" from config.json, and `peers rm` survived exactly one gossip round.
   */
  p2p?: {
    /** Learn peers from peer exchange at all (default true). false = talk only to the configured list. */
    acceptExchange?: boolean;
    /** Ceiling on the peer table (default 50). Past it the least recently seen LEARNED peer is dropped. */
    maxPeers?: number;
    /** Drop a LEARNED peer after this many consecutive failed rounds (default 60; 0 = never). */
    evictAfterFailures?: number;
    /** Drop a LEARNED peer this many days after it was last seen (default 7; 0 = never). */
    staleDays?: number;
  };
  /**
   * HTTP server knobs. `trustProxy` is Express's `trust proxy` setting: `false` (default) → `req.ip` is the TCP peer, so a
   * client cannot pick its own address with X-Forwarded-For (per-IP quotas, bans and rate limits key on `req.ip`).
   * Behind a reverse proxy set it to the hop count (`1`), `'loopback'`, or the proxy's IP/CIDR list.
   */
  server?: { trustProxy?: boolean | number | string | string[] };
  /**
   * Retention of the node's own bookkeeping (item 128). `events.retentionDays` is how long raw rows of the `events`
   * table are kept before the hourly purge removes them — the demand counters are materialised at write time, so
   * nothing measured is lost with them. Default 90 days.
   */
  events?: { retentionDays: number };
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
  check: { callBudget: number; sampleRows: number; chatFormRows: number; parentSamplesMax: number; lockTargetMs: number; lockAbortMs: number;
    /**
     * How long a lesson waits for a BUSY shared model before it is saved unchecked (item 244). A model OUTAGE has had
     * a 15-minute grace since the beginning; a busy runtime was retried for ever, so a 3 a.m. bake could sit behind
     * verification of its own yesterday's version with a terminal that said nothing. Default 30 min.
     */
    lockGraceMs: number };
  /** Interactive preflight sampling. */
  preflight: { sampleRows: number; perCall: number };
  /** Total questions the queue may hold across all waiting lessons. */
  queuedRowsMax: number;
  /**
   * Teaching keys this node does not ration (item 246): the daily lesson limit is meant to stop a stranger filling
   * the GPU, and it locked the operator out of their OWN node after one failed bake and one retry — with no reset
   * time anywhere. The node's own identity is always trusted; add the keys you teach with here.
   */
  trustedKeys?: string[];
  /**
   * Run the live side-effect check even when the trainer is the demo stub (item 247). Default false: a stub writes a
   * PLACEHOLDER body, so the ~4.5 minutes of shared model the check costs measure nothing — the held lock is the only
   * real thing about the run, and the lesson ends `NEEDS_MORE · taught 0/18` on a page that says nothing was trained.
   * A test rig with a fake model server sets this, because the check path is what it asserts; a node pointed at a
   * production vLLM should not.
   */
  checkStubLessons?: boolean;
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
  /** Lineage (design §5.3): the published KNOWLEDGE this set was copied out of, its set's sha, and how many rows are still its. */
  parent_patch?: string;
  parent_dataset_sha?: string;
  inherited_rows?: number;
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
  /**
   * How many report entries were carried over from an earlier revision (rows refused when the file was read that the
   * last edit did not resolve). They are already counted in `rejected` and in their own bucket; this says how many of
   * those numbers are about the original file rather than the current bytes. Absent before the carry rule existed.
   */
  carried?: number;
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
  /**
   * A refused row CARRIED FORWARD from an earlier revision of this dataset (design §11). An edit rewrites the set from
   * its accepted rows, so a row the parser refused when the file was read is not in the new bytes; it is kept in the
   * report anyway, because "nothing is silently dropped" has to hold across revisions too. `line` is still its line in
   * the file that was uploaded — never a position in the current set — which is why the table labels it differently.
   */
  carried?: true;
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

/**
 * Are these the same address?
 *
 * An AIN/Ethereum address is checksummed — the same address is written `0xAbC…` in one record and `0xabc…` in
 * another, and `===` between the two forms is false. Comparisons of this kind were spread across the node, the
 * catalogue and the verifier as three private copies plus a scattering of raw `===`, which is how a verifier
 * ended up unable to recognise its own earlier attestation. One definition, and it lives here because `types.ts`
 * imports nothing and so is reachable from a browser bundle too.
 */
export const sameAddr = (a: string | undefined | null, b: string | undefined | null): boolean =>
  (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
