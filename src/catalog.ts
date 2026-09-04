/**
 * Catalog derivation — turns ledger records into the marketplace view.
 * Status machine (도 16): DRAFT → ANNOUNCED → VERIFYING → LISTED | REJECTED; LISTED → CHALLENGED → VERIFYING;
 * LISTED → SUPERSEDED when a newer patch on the same benchmark schema overlaps its address set.
 */
import { effectiveRoyaltyShare, effectiveVerifierShare, MAX_CONTRIBUTORS } from './types.js';
import type { Attestation, Challenge, Contributor, LedgerRecord, PatchAnchor, PatchStatus, Settlement } from './types.js';
import type { SupersedeRecord } from './ledger.js';

export interface CatalogEntry {
  anchor: PatchAnchor & { entry_id?: string; node_id?: string; gateway_url?: string };
  status: PatchStatus;
  attestations: Attestation[];
  /** Attestations that actually executed the benchmark on a compatible runtime (count toward quorum). */
  passed: number;
  /** Integrity-only (hash-only) attestations — shown, but never sufficient for LISTED when the patch declares benchmark samples. */
  integrity_checks: number;
  /**
   * Attestations written by the anchor's own author that were EXCLUDED from the counts above (the shipped
   * `verifier.allowSelfAttest: false`). They stay in `attestations` — the record is permanent — but count for nothing.
   * 0 on a node configured to allow self-attestation, where they were counted like any other.
   */
  self_checks: number;
  quorum: number;
  quorum_ok: boolean;
  /** Quorum met AND nothing blocks the sale. CHALLENGED clears it — every buy gate reads this, not `quorum_ok`. */
  sellable: boolean;
  /**
   * The challenge nobody has answered yet: the newest challenge written after the newest attestation that counts.
   * Set on ANNOUNCED / VERIFYING / REJECTED entries too, not only on LISTED ones (item 242) — a challenge is a
   * question addressed to the verifiers, and an item stuck at 1/2 with one FAIL is exactly the case where the
   * publisher needs one re-run and the product told them to file a challenge to get it.
   */
  open_challenge?: Challenge;
  /** Every challenge on this entry and what the verifiers said about it afterwards (item 328). */
  challenge_log: { challenge: Challenge; state: 'open' | 'upheld' | 'dismissed'; answered_at?: number; answered_by?: string }[];
  /** Addresses of the attestations that COUNT toward the quorum — who is paid the verification share (item 325). */
  verifiers: string[];
  /**
   * Distinct model-server fingerprints behind those counted attestations (item 329): `2/2` with one entry here is
   * two verifier processes on ONE engine, which is not two independent verifications.
   */
  executors: string[];
  /** Counted attestations that carry no executor fingerprint (written before the field) — independence unknown. */
  executors_unknown: number;
  /** Counted attestations that ran without an un-patched baseline of their own — recorded, never counted (item 329). */
  no_baseline: number;
  settlements: Settlement[];
  downloads: number;
  revenue: string;
  challenges: Challenge[];
  superseded_by: string[];
  supersedes: string[];
  children: string[];          // derived patches (lineage)
  record_hash: string;
  listed_at?: number;
}

const sameAddr = (a: string, b: string) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * Which of one verifier's attestations counts for an entry.
 *  - after a challenge: the newest attestation written after it (re-verification answers the challenge and replaces
 *    the pre-challenge result — otherwise a challenged patch could never return to LISTED, since every verifier has
 *    already attested it);
 *  - otherwise: the first one, upgraded to the first attestation that actually executed the benchmark
 *    (a real run beats an earlier hash-only check by the same node).
 */
export function effectiveAttestation(list: Attestation[], challengedAt = 0): Attestation {
  if (challengedAt > 0) {
    const after = list.filter((a) => a.created_at > challengedAt).sort((a, b) => b.created_at - a.created_at);
    if (after.length) return after[0];
  }
  const first = list[0];
  if (first.verified_on === 'hash-only') return list.find((a) => a.verified_on !== 'hash-only') ?? first;
  return first;
}

/**
 * How a verification count is written for a human: the numerator never exceeds the quorum (`3/2` is arithmetic no
 * reader can interpret), and any attestations beyond it are reported as a separate, honest count.
 */
export function verificationCount(e: { passed: number; quorum: number }): { fraction: string; extra: number } {
  const shown = Math.min(e.passed, e.quorum);
  return { fraction: `${shown}/${e.quorum}`, extra: e.passed - shown };
}

export function deriveCatalog(
  anchors: LedgerRecord<PatchAnchor>[],
  attestations: LedgerRecord<Attestation>[],
  settlements: LedgerRecord<Settlement>[],
  challenges: LedgerRecord<Challenge>[],
  supersedes: LedgerRecord<SupersedeRecord>[],
  quorum: number,
  localDrafts: PatchAnchor[] = [],
  /** Dev/single-node setting (`verifier.allowSelfAttest`): when true, an author's attestation of its own anchor counts. Default false — the shipped behaviour. */
  allowSelfAttest = false,
): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  const seen = new Set<string>();
  for (const rec of anchors) {
    if (seen.has(rec.body.id)) continue;   // first anchor wins (immutable)
    seen.add(rec.body.id);
    byId.set(rec.body.id, {
      anchor: rec.body, status: 'ANNOUNCED', attestations: [], passed: 0, integrity_checks: 0, self_checks: 0, quorum, quorum_ok: false, sellable: false,
      challenge_log: [], verifiers: [], executors: [], executors_unknown: 0, no_baseline: 0,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [],
      record_hash: rec.hash,
    });
  }
  for (const d of localDrafts) {
    if (!byId.has(d.id)) byId.set(d.id, {
      anchor: d, status: 'DRAFT', attestations: [], passed: 0, integrity_checks: 0, self_checks: 0, quorum, quorum_ok: false, sellable: false,
      challenge_log: [], verifiers: [], executors: [], executors_unknown: 0, no_baseline: 0,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [], record_hash: '',
    });
  }
  // Every attestation is kept per verifier here; which one of a verifier's attestations counts is decided below,
  // once the challenges are known (a re-verification written after a challenge replaces the pre-challenge one).
  const byVerifier = new Map<string, Map<string, Attestation[]>>();
  for (const rec of attestations) {
    const e = byId.get(rec.body.patch_id);
    if (!e) continue;
    const per = byVerifier.get(rec.body.patch_id) ?? new Map<string, Attestation[]>();
    const list = per.get(rec.body.verifier) ?? [];
    list.push(rec.body);
    per.set(rec.body.verifier, list);
    byVerifier.set(rec.body.patch_id, per);
  }
  for (const rec of settlements) {
    const e = byId.get(rec.body.patch_id);
    if (!e) continue;
    e.settlements.push(rec.body);
  }
  for (const rec of challenges) {
    const e = byId.get(rec.body.patch_id);
    if (e) e.challenges.push(rec.body);
  }
  for (const rec of supersedes) {
    const oldE = byId.get(rec.body.old_patch_id);
    const newE = byId.get(rec.body.new_patch_id);
    if (oldE) oldE.superseded_by.push(rec.body.new_patch_id);
    if (newE) newE.supersedes.push(rec.body.old_patch_id);
  }
  for (const e of byId.values()) {
    for (const p of e.anchor.parents) byId.get(p)?.children.push(e.anchor.id);
    const latestChallenge = e.challenges.sort((a, b) => b.created_at - a.created_at)[0];
    e.attestations = [...(byVerifier.get(e.anchor.id) ?? new Map<string, Attestation[]>()).values()]
      .map((list) => effectiveAttestation(list, latestChallenge?.created_at ?? 0));
    // A patch that ships benchmark samples must be *executed* by verifiers; hash-only checks are recorded but do not list it.
    const needsBenchmark = (e.anchor.benchmark.samples?.length ?? 0) > 0;
    // An author attesting its own anchor is a self-check, never a verification: it is shown but excluded from every count
    // that decides LISTED, so an attestation already on the chain stops counting the moment this node reads it.
    const isSelf = (a: Attestation) => !allowSelfAttest && sameAddr(a.verifier, e.anchor.author);
    const independent = e.attestations.filter((a) => !isSelf(a));
    // A run on a table where the knowledge was ALREADY applied has no un-patched baseline of its own: the record is
    // kept (it is on the ledger for ever) but it is not a verification of anything (item 329).
    const counted = independent.filter((a) => a.baseline !== false);
    e.no_baseline = independent.length - counted.length;
    const executed = counted.filter((a) => a.passed && (!needsBenchmark || a.verified_on !== 'hash-only'));
    e.passed = executed.length;
    e.verifiers = [...new Set(executed.map((a) => a.verifier))];
    // Independence is a claim about the MACHINE, not the address: two verifier processes on one vLLM produce one
    // executor fingerprint, and the entry says so instead of counting them as two independent verifications.
    e.executors = [...new Set(executed.map((a) => a.executor?.instance).filter((x): x is string => !!x))];
    e.executors_unknown = executed.filter((a) => !a.executor?.instance).length;
    e.integrity_checks = counted.filter((a) => a.verified_on === 'hash-only').length;
    e.self_checks = e.attestations.length - independent.length;
    e.quorum_ok = e.passed >= quorum;
    e.downloads = e.settlements.length;
    e.revenue = e.settlements.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(6).replace(/\.?0+$/, '') || '0';
    // What happened to each challenge: the attestations written after it are the verifiers' answer (item 328).
    const byTime = [...e.challenges].sort((a, b) => a.created_at - b.created_at);
    e.challenge_log = byTime.map((ch, i) => {
      const until = byTime[i + 1]?.created_at ?? Infinity;
      const answers = independent.filter((a) => a.created_at > ch.created_at && a.created_at < until).sort((a, b) => b.created_at - a.created_at);
      const answer = answers[0];
      if (!answer) return { challenge: ch, state: 'open' as const };
      return { challenge: ch, state: (answer.passed ? 'dismissed' : 'upheld') as 'dismissed' | 'upheld', answered_at: answer.created_at, answered_by: answer.verifier };
    });
    // A challenge nobody has answered yet is open whatever the status is (item 242): an ANNOUNCED / VERIFYING /
    // REJECTED entry is exactly where the publisher needs the re-run, and the verifier round reads this flag.
    const openChallenge = e.challenge_log.filter((c) => c.state === 'open').map((c) => c.challenge).sort((a, b) => b.created_at - a.created_at)[0];
    if (openChallenge) e.open_challenge = openChallenge;
    if (e.status === 'DRAFT') { e.sellable = false; continue; }
    const failed = counted.filter((a) => !a.passed && (!needsBenchmark || a.verified_on !== 'hash-only')).length;
    if (e.quorum_ok) {
      e.status = 'LISTED';
      e.listed_at = Math.max(...executed.map((a) => a.created_at));
      // An unanswered challenge holds the entry until a verifier re-runs it (that re-verification is newer than the
      // challenge, so it answers it and lifts the status again).
      if (e.open_challenge) e.status = 'CHALLENGED';
      if (e.superseded_by.length && e.status !== 'CHALLENGED') e.status = 'SUPERSEDED';
    } else if (failed >= quorum) {
      e.status = 'REJECTED';
    } else if (e.attestations.length > 0) {
      e.status = 'VERIFYING';
    } else {
      e.status = 'ANNOUNCED';
    }
    // A disputed entry is not for sale at any price: the 402 gate, `patch buy` and the agent all read this flag.
    e.sellable = e.quorum_ok && e.status !== 'CHALLENGED';
  }
  return [...byId.values()].sort((a, b) => b.anchor.created_at - a.anchor.created_at);
}

/** A caller-supplied value was malformed (HTTP layers map it to 400 instead of 500). */
export class ValidationError extends Error { constructor(message: string) { super(message); this.name = 'ValidationError'; } }

/** Anchor price: a non-negative decimal string (`'0'`, `'0.1'`, `'25'`); negative or non-numeric prices would produce negative royalties. */
export const PRICE_RE = /^\d+(\.\d+)?$/;
export function validatePrice(price: unknown, label = 'price'): string {
  if (typeof price !== 'string' || !PRICE_RE.test(price.trim())) throw new ValidationError(`${label} must be a non-negative number (e.g. "0", "0.1", "25")`);
  return price.trim();
}

/**
 * Validate an anchor's contributor list (createDraft / updateDraft / publish). Returns a normalised copy.
 * Rules: ≤ MAX_CONTRIBUTORS entries, unique addresses, 0 ≤ share ≤ 1 each and Σ share ≤ 1, role 'data_provider',
 * proof 'signed' | 'declared', name ≤ 40 chars. Throws ValidationError(<message>) on the first violation.
 */
export function validateContributors(list: unknown): Contributor[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new ValidationError('contributors must be an array');
  if (list.length > MAX_CONTRIBUTORS) throw new ValidationError(`at most ${MAX_CONTRIBUTORS} contributors per patch`);
  const out: Contributor[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const raw of list) {
    const c = raw as Partial<Contributor> | null;
    if (!c || typeof c !== 'object') throw new ValidationError('contributor must be an object');
    if (typeof c.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) throw new ValidationError('contributor.address must be an AIN address (0x + 40 hex)');
    const address = c.address.toLowerCase();
    if (seen.has(address)) throw new ValidationError(`duplicate contributor address: ${c.address}`);
    seen.add(address);
    if (typeof c.share !== 'number' || !Number.isFinite(c.share) || c.share < 0 || c.share > 1) throw new ValidationError('contributor.share must be a number between 0 and 1');
    sum += c.share;
    if (sum > 1 + 1e-9) throw new ValidationError('contributor shares add up to more than 1');
    if (c.role !== undefined && c.role !== 'data_provider') throw new ValidationError(`unsupported contributor role: ${String(c.role)}`);
    if (c.proof !== undefined && c.proof !== 'signed' && c.proof !== 'declared') throw new ValidationError(`unsupported contributor proof: ${String(c.proof)}`);
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 40)) throw new ValidationError('contributor.name must be a string of at most 40 chars');
    if (c.signer !== undefined && (typeof c.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.signer))) throw new ValidationError('contributor.signer must be an AIN address');
    if (c.sig !== undefined && typeof c.sig !== 'string') throw new ValidationError('contributor.sig must be a string');
    const entry: Contributor = { address: c.address, share: c.share, role: 'data_provider', proof: c.proof ?? (c.sig ? 'signed' : 'declared') };
    if (c.signer) entry.signer = c.signer;
    if (c.name) entry.name = c.name.trim();
    if (c.sig) entry.sig = c.sig;
    out.push(entry);
  }
  return out;
}

/**
 * Non-throwing variant for anchors we did not write (peer gossip, chain reads): a malformed contributor list is treated as
 * "no contributors" so a hostile peer anchor (share 5, 40 entries, junk addresses) can never inflate a payout here.
 */
export function sanitizeContributors(list: unknown): Contributor[] | undefined {
  if (list === undefined || list === null) return undefined;
  try { const out = validateContributors(list); return out.length ? out : undefined; } catch { return undefined; }
}

/**
 * Royalty plan for one sale of `amount` (청구항 11, 16-3, 21) — the arithmetic that decides who is paid what. It is
 * computed from the ANCHOR, never from the selling node's config (item 191): a derivative's seller could otherwise
 * set `market.royaltyShare` to 0 and keep the base creator's share while her page still promised 30 %.
 *
 *  pass 1  — lineage pool = amount × share, divided equally among the unique ancestor AUTHORS OTHER THAN THE SELLER.
 *            A version chain of the seller's own bakes no longer dilutes outside creators (item 192): before this,
 *            listing yesterday's version as a parent — which the design's own worked example recommends — halved
 *            every outside creator's share on day 2 and, past the old depth-16 cut, dropped them to zero.
 *  pass 1b — an outside ancestor author's slice is divided equally among that author's ancestor anchors, and each
 *            anchor slice is shared with that anchor's `contributors[]` by their shares (a data provider keeps
 *            earning when someone builds on their lesson).
 *  pass 1c — an ancestor the seller's ledger cannot resolve is NOT silently dropped (item 310): the anchor that
 *            names it carries `parent_authors[i]`, so the slice is still paid to that author; only when nothing
 *            names an author does the slice go to `unresolved` — held back and written onto the settle record,
 *            never quietly folded into the seller's own line.
 *  pass 2  — the seller side (amount − pool) pays, in this order:
 *              · the verification fee (item 325): sellerSide × verifier_share, divided equally among the
 *                attestations that count toward this entry's quorum. Verifying costs a GPU minute and a gigabyte of
 *                someone else's body per item and earned nothing anywhere in this product before it;
 *              · the data providers: `c.share` of what is left, for the contributors credited on the sold anchor
 *                AND on the seller's own ancestor anchors (one carve per address, the largest share they hold), so
 *                the promise "your share of this node's take" survives the seller re-baking on top of itself;
 *              · the seller keeps the remainder.
 *
 * Addresses are summed case-insensitively under their first-seen spelling (item 309): the same person credited once
 * as a contributor (as typed) and once as an ancestor author (checksummed) was paid twice into two keys, and a local
 * wallet that compares exactly could see neither.
 *
 * Amounts are decimal strings (6 dp, trailing zeros trimmed); zero-valued payouts are omitted except the seller's own line.
 */
export interface RoyaltyPlan {
  /** address → amount. What the settle record carries and what payouts / credit balances are derived from. */
  royalty: Record<string, string>;
  /** parent id → amount owed to an ancestor this node could not name. Held back, and written onto the settlement. */
  unresolved: Record<string, string>;
  /** The verifier lines inside `royalty` (address → amount), so a wallet can say what was earned by verifying. */
  verification: Record<string, string>;
  /** Ancestor ids that resolved but whose walk was cut at MAX_LINEAGE_ANCHORS. */
  truncated: boolean;
  /** The shares actually used — the anchor's promise, floored at the network minimum. */
  share: number;
  verifier_share: number;
}

/** Cycle-safe ceiling on the lineage walk. Replaces the old `depth > 16` cut, which paid an 18-hop ancestor nothing. */
export const MAX_LINEAGE_ANCHORS = 4096;

export function royaltyPlan(
  entry: CatalogEntry, all: Map<string, CatalogEntry>, amount: number, share: number,
  opts: { verifierShare?: number; verifiers?: string[] } = {},
): RoyaltyPlan {
  const seller = entry.anchor.author;
  const same = (a: string, b: string) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
  const shareUsed = effectiveRoyaltyShare(entry.anchor, share);
  const verifiers = [...new Set((opts.verifiers ?? entry.verifiers ?? []).filter((v) => typeof v === 'string' && v && !same(v, seller)))];
  const verifierShareUsed = verifiers.length ? effectiveVerifierShare(entry.anchor, opts.verifierShare) : 0;
  // Defensive: shares outside [0, 1] (unvalidated peer / chain anchors) are clamped and the total carve of one anchor can
  // never exceed the slice it is carved from, so Σ payouts ≤ amount holds whatever the lineage carries.
  const safeShare = (c: Contributor) => (typeof c.share === 'number' && Number.isFinite(c.share) ? Math.min(1, Math.max(0, c.share)) : 0);

  // ---- the walk: every ancestor anchor, breadth-first, cycle-safe, with no depth cut (item 192)
  const outside: string[] = [];                          // unique ancestor authors ≠ seller, first-seen order
  const anchorsByAuthor = new Map<string, CatalogEntry[]>();
  const selfAncestors: CatalogEntry[] = [];              // ancestor anchors published by the seller itself
  const unresolvedIds: string[] = [];                    // parent ids no anchor and no `parent_authors` entry names
  const visited = new Set<string>([entry.anchor.id]);    // the sold anchor is never its own ancestor
  const noteAuthor = (author: string, pe?: CatalogEntry) => {
    if (same(author, seller)) { if (pe) selfAncestors.push(pe); return; }
    const key = outside.find((a) => same(a, author)) ?? (outside.push(author), author);
    if (pe) { const list = anchorsByAuthor.get(key) ?? []; list.push(pe); anchorsByAuthor.set(key, list); }
  };
  let truncated = false;
  const queue: string[] = [entry.anchor.id];
  for (let head = 0; head < queue.length; head++) {
    const e = all.get(queue[head]);
    if (!e) continue;
    const parents = e.anchor.parents ?? [];
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i];
      if (visited.has(p)) continue;
      if (visited.size >= MAX_LINEAGE_ANCHORS) { truncated = true; break; }
      visited.add(p);
      const pe = all.get(p);
      if (pe) { noteAuthor(pe.anchor.author, pe); queue.push(p); continue; }
      // The anchor is not in this node's map. The record that names it also names its author — use that, and only
      // give up (and say so on the settlement) when nothing does.
      const named = e.anchor.parent_authors?.[i];
      if (named && typeof named === 'string') noteAuthor(named);
      else unresolvedIds.push(p);
    }
    if (truncated) break;
  }

  const sums: Record<string, number> = {};
  const keyFor = new Map<string, string>();               // lower-cased address → the spelling we sum under
  const add = (addr: string, n: number) => {
    const lower = (addr ?? '').toLowerCase();
    const key = keyFor.get(lower) ?? (keyFor.set(lower, addr), addr);
    sums[key] = (sums[key] ?? 0) + n;
  };

  // ---- pass 1 / 1b / 1c: the lineage pool
  const payees = outside.length + unresolvedIds.length;
  const pool = payees ? amount * shareUsed : 0;
  const each = payees ? pool / payees : 0;
  const unresolved: Record<string, string> = {};
  for (const a of outside) {
    const anchors = anchorsByAuthor.get(a) ?? [];
    if (!anchors.length) { add(a, each); continue; }      // named by `parent_authors` but not held here
    const sub = each / anchors.length;
    for (const pe of anchors) {
      let rem = sub;
      for (const c of Array.isArray(pe.anchor.contributors) ? pe.anchor.contributors : []) {
        if (!c || typeof c.address !== 'string' || same(c.address, a)) continue;   // folds back into the author anyway
        const carve = Math.min(rem, sub * safeShare(c));
        add(c.address, carve);
        rem -= carve;
      }
      add(a, rem);
    }
  }
  for (const id of unresolvedIds) unresolved[id] = (each).toFixed(6).replace(/\.?0+$/, '') || '0';

  // ---- pass 2: the seller side
  const sellerSide = amount - pool;
  let remainder = sellerSide;
  const verification: Record<string, string> = {};
  const verifierPool = sellerSide * verifierShareUsed;
  if (verifiers.length && verifierPool > 0) {
    const per = verifierPool / verifiers.length;
    for (const v of verifiers) {
      const carve = Math.min(remainder, per);
      add(v, carve);
      verification[v] = carve.toFixed(6).replace(/\.?0+$/, '') || '0';
      remainder -= carve;
    }
  }
  // Contributors credited on the sold anchor and on the seller's own ancestor anchors, once per address at the
  // largest share they hold; every carve is a fraction of the SAME base, so two 0.5 providers are 50 % and 50 %.
  const base = remainder;
  const providers = new Map<string, { address: string; share: number }>();
  for (const pe of [entry, ...selfAncestors]) {
    for (const c of Array.isArray(pe.anchor.contributors) ? pe.anchor.contributors : []) {
      if (!c || typeof c.address !== 'string' || same(c.address, seller)) continue;
      const lower = c.address.toLowerCase();
      const cur = providers.get(lower);
      if (!cur || safeShare(c) > cur.share) providers.set(lower, { address: cur?.address ?? c.address, share: Math.max(cur?.share ?? 0, safeShare(c)) });
    }
  }
  for (const { address, share: sh } of providers.values()) {
    const carve = Math.min(remainder, base * sh);
    add(address, carve);
    remainder -= carve;
  }
  add(seller, remainder);

  const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, '');
  const royalty: Record<string, string> = {};
  for (const [addr, n] of Object.entries(sums)) {
    if (!same(addr, seller) && n <= 0) continue;
    royalty[addr] = fmt(n) || '0';
  }
  return { royalty, unresolved, verification, truncated, share: shareUsed, verifier_share: verifierShareUsed };
}

/** The payout map alone — the shape every caller before the lineage/verifier work expected. */
export function royaltySplit(
  entry: CatalogEntry, all: Map<string, CatalogEntry>, amount: number, share: number,
  opts: { verifierShare?: number; verifiers?: string[] } = {},
): Record<string, string> {
  return royaltyPlan(entry, all, amount, share, opts).royalty;
}
