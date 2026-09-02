/**
 * Catalog derivation — turns ledger records into the marketplace view.
 * Status machine (도 16): DRAFT → ANNOUNCED → VERIFYING → LISTED | REJECTED; LISTED → CHALLENGED → VERIFYING;
 * LISTED → SUPERSEDED when a newer patch on the same benchmark schema overlaps its address set.
 */
import { MAX_CONTRIBUTORS } from './types.js';
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
  /** The challenge that is currently holding the sale (newest challenge written after the entry was listed). */
  open_challenge?: Challenge;
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
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [],
      record_hash: rec.hash,
    });
  }
  for (const d of localDrafts) {
    if (!byId.has(d.id)) byId.set(d.id, {
      anchor: d, status: 'DRAFT', attestations: [], passed: 0, integrity_checks: 0, self_checks: 0, quorum, quorum_ok: false, sellable: false,
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
    const executed = independent.filter((a) => a.passed && (!needsBenchmark || a.verified_on !== 'hash-only'));
    e.passed = executed.length;
    e.integrity_checks = independent.filter((a) => a.verified_on === 'hash-only').length;
    e.self_checks = e.attestations.length - independent.length;
    e.quorum_ok = e.passed >= quorum;
    e.downloads = e.settlements.length;
    e.revenue = e.settlements.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(6).replace(/\.?0+$/, '') || '0';
    if (e.status === 'DRAFT') { e.sellable = false; continue; }
    const failed = independent.filter((a) => !a.passed && (!needsBenchmark || a.verified_on !== 'hash-only')).length;
    if (e.quorum_ok) {
      e.status = 'LISTED';
      e.listed_at = Math.max(...executed.map((a) => a.created_at));
      // A challenge written after the newest counted verification holds the entry until a verifier re-runs it
      // (that re-verification is newer than the challenge, so it lands in `executed` and lifts the status again).
      if (latestChallenge && latestChallenge.created_at > (e.listed_at ?? 0)) { e.status = 'CHALLENGED'; e.open_challenge = latestChallenge; }
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
 * Royalty split (청구항 11, 16-3, 21) — two passes over one sale of `amount`:
 *
 *  pass 1  — lineage pool = amount × share, divided equally among the unique ancestor AUTHORS
 *            (an ancestor by the seller itself folds its slice back into the seller);
 *  pass 1b — an ancestor author's slice is divided equally among that author's ancestor anchors, and each anchor
 *            slice is shared with the anchor's `contributors[]` by their shares (a data provider keeps earning
 *            when someone builds on their lesson);
 *  pass 2  — the seller remainder (amount − pool) is carved sequentially for `entry.anchor.contributors[]`:
 *            carve = remainder × c.share; remainder −= carve. A contributor whose address is the seller is skipped.
 *
 * Amounts are decimal strings (6 dp, trailing zeros trimmed); zero-valued payouts are omitted except the seller's own line.
 */
export function royaltySplit(
  entry: CatalogEntry, all: Map<string, CatalogEntry>, amount: number, share: number,
): Record<string, string> {
  const seller = entry.anchor.author;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  // Defensive: shares outside [0, 1] (unvalidated peer / chain anchors) are clamped and the total carve of one anchor can
  // never exceed the slice it is carved from, so Σ payouts ≤ amount holds whatever the lineage carries.
  const safeShare = (c: Contributor) => (typeof c.share === 'number' && Number.isFinite(c.share) ? Math.min(1, Math.max(0, c.share)) : 0);
  const ancestors: string[] = [];                       // unique ancestor authors, first-seen order
  const anchorsByAuthor = new Map<string, CatalogEntry[]>();
  const visited = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (depth > 16) return;
    const e = all.get(id);
    if (!e) return;
    for (const p of e.anchor.parents) {
      const pe = all.get(p);
      if (pe && !visited.has(pe.anchor.id)) {
        visited.add(pe.anchor.id);
        if (!ancestors.includes(pe.anchor.author)) ancestors.push(pe.anchor.author);
        const list = anchorsByAuthor.get(pe.anchor.author) ?? [];
        list.push(pe);
        anchorsByAuthor.set(pe.anchor.author, list);
      }
      walk(p, depth + 1);
    }
  };
  walk(entry.anchor.id, 0);

  const sums: Record<string, number> = {};
  const add = (addr: string, n: number) => { sums[addr] = (sums[addr] ?? 0) + n; };

  // pass 1 + 1b
  const pool = ancestors.length ? amount * share : 0;
  const each = ancestors.length ? pool / ancestors.length : 0;
  for (const a of ancestors) {
    const anchors = anchorsByAuthor.get(a) ?? [];
    const sub = anchors.length ? each / anchors.length : each;
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
    if (!anchors.length) add(a, each);
  }

  // pass 2
  let remainder = amount - pool;
  for (const c of Array.isArray(entry.anchor.contributors) ? entry.anchor.contributors : []) {
    if (!c || typeof c.address !== 'string' || same(c.address, seller)) continue;
    const carve = Math.min(remainder, remainder * safeShare(c));
    add(c.address, carve);
    remainder -= carve;
  }
  add(seller, remainder);

  const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, '');
  const out: Record<string, string> = {};
  for (const [addr, n] of Object.entries(sums)) {
    if (addr !== seller && n <= 0) continue;
    out[addr] = fmt(n) || '0';
  }
  return out;
}
