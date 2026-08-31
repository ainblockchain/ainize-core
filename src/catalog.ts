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
  quorum: number;
  quorum_ok: boolean;
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

export function deriveCatalog(
  anchors: LedgerRecord<PatchAnchor>[],
  attestations: LedgerRecord<Attestation>[],
  settlements: LedgerRecord<Settlement>[],
  challenges: LedgerRecord<Challenge>[],
  supersedes: LedgerRecord<SupersedeRecord>[],
  quorum: number,
  localDrafts: PatchAnchor[] = [],
): CatalogEntry[] {
  const byId = new Map<string, CatalogEntry>();
  const seen = new Set<string>();
  for (const rec of anchors) {
    if (seen.has(rec.body.id)) continue;   // first anchor wins (immutable)
    seen.add(rec.body.id);
    byId.set(rec.body.id, {
      anchor: rec.body, status: 'ANNOUNCED', attestations: [], passed: 0, integrity_checks: 0, quorum, quorum_ok: false,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [],
      record_hash: rec.hash,
    });
  }
  for (const d of localDrafts) {
    if (!byId.has(d.id)) byId.set(d.id, {
      anchor: d, status: 'DRAFT', attestations: [], passed: 0, integrity_checks: 0, quorum, quorum_ok: false,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [], record_hash: '',
    });
  }
  for (const rec of attestations) {
    const e = byId.get(rec.body.patch_id);
    if (!e) continue;
    const idx = e.attestations.findIndex((a) => a.verifier === rec.body.verifier);
    if (idx >= 0) {
      // same verifier again: keep the stronger evidence (real benchmark beats hash-only), otherwise the first one
      if (e.attestations[idx].verified_on === 'hash-only' && rec.body.verified_on !== 'hash-only') e.attestations[idx] = rec.body;
      continue;
    }
    e.attestations.push(rec.body);
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
    // A patch that ships benchmark samples must be *executed* by verifiers; hash-only checks are recorded but do not list it.
    const needsBenchmark = (e.anchor.benchmark.samples?.length ?? 0) > 0;
    const executed = e.attestations.filter((a) => a.passed && (!needsBenchmark || a.verified_on !== 'hash-only'));
    e.passed = executed.length;
    e.integrity_checks = e.attestations.filter((a) => a.verified_on === 'hash-only').length;
    e.quorum_ok = e.passed >= quorum;
    e.downloads = e.settlements.length;
    e.revenue = e.settlements.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(6).replace(/\.?0+$/, '') || '0';
    if (e.status === 'DRAFT') continue;
    const failed = e.attestations.filter((a) => !a.passed && (!needsBenchmark || a.verified_on !== 'hash-only')).length;
    const latestChallenge = e.challenges.sort((a, b) => b.created_at - a.created_at)[0];
    if (e.quorum_ok) {
      e.status = 'LISTED';
      e.listed_at = Math.max(...executed.map((a) => a.created_at));
      if (latestChallenge && latestChallenge.created_at > (e.listed_at ?? 0)) e.status = 'CHALLENGED';
      if (e.superseded_by.length) e.status = 'SUPERSEDED';
    } else if (failed >= quorum) {
      e.status = 'REJECTED';
    } else if (e.attestations.length > 0) {
      e.status = 'VERIFYING';
    } else {
      e.status = 'ANNOUNCED';
    }
  }
  return [...byId.values()].sort((a, b) => b.anchor.created_at - a.anchor.created_at);
}

/**
 * Validate an anchor's contributor list (createDraft / updateDraft / publish). Returns a normalised copy.
 * Rules: ≤ MAX_CONTRIBUTORS entries, unique addresses, 0 ≤ share ≤ 1 each and Σ share ≤ 1, role 'data_provider',
 * proof 'signed' | 'declared', name ≤ 40 chars. Throws Error(<message>) on the first violation.
 */
export function validateContributors(list: unknown): Contributor[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('contributors must be an array');
  if (list.length > MAX_CONTRIBUTORS) throw new Error(`at most ${MAX_CONTRIBUTORS} contributors per patch`);
  const out: Contributor[] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (const raw of list) {
    const c = raw as Partial<Contributor> | null;
    if (!c || typeof c !== 'object') throw new Error('contributor must be an object');
    if (typeof c.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.address)) throw new Error('contributor.address must be an AIN address (0x + 40 hex)');
    const address = c.address.toLowerCase();
    if (seen.has(address)) throw new Error(`duplicate contributor address: ${c.address}`);
    seen.add(address);
    if (typeof c.share !== 'number' || !Number.isFinite(c.share) || c.share < 0 || c.share > 1) throw new Error('contributor.share must be a number between 0 and 1');
    sum += c.share;
    if (sum > 1 + 1e-9) throw new Error('contributor shares add up to more than 1');
    if (c.role !== undefined && c.role !== 'data_provider') throw new Error(`unsupported contributor role: ${String(c.role)}`);
    if (c.proof !== undefined && c.proof !== 'signed' && c.proof !== 'declared') throw new Error(`unsupported contributor proof: ${String(c.proof)}`);
    if (c.name !== undefined && (typeof c.name !== 'string' || c.name.length > 40)) throw new Error('contributor.name must be a string of at most 40 chars');
    if (c.signer !== undefined && (typeof c.signer !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(c.signer))) throw new Error('contributor.signer must be an AIN address');
    if (c.sig !== undefined && typeof c.sig !== 'string') throw new Error('contributor.sig must be a string');
    const entry: Contributor = { address: c.address, share: c.share, role: 'data_provider', proof: c.proof ?? (c.sig ? 'signed' : 'declared') };
    if (c.signer) entry.signer = c.signer;
    if (c.name) entry.name = c.name.trim();
    if (c.sig) entry.sig = c.sig;
    out.push(entry);
  }
  return out;
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
      for (const c of pe.anchor.contributors ?? []) {
        if (c.address === a) continue;               // folds back into the author anyway
        const carve = sub * c.share;
        add(c.address, carve);
        rem -= carve;
      }
      add(a, rem);
    }
    if (!anchors.length) add(a, each);
  }

  // pass 2
  let remainder = amount - pool;
  for (const c of entry.anchor.contributors ?? []) {
    if (c.address === seller) continue;
    const carve = remainder * c.share;
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
