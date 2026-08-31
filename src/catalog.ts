/**
 * Catalog derivation — turns ledger records into the marketplace view.
 * Status machine (도 16): DRAFT → ANNOUNCED → VERIFYING → LISTED | REJECTED; LISTED → CHALLENGED → VERIFYING;
 * LISTED → SUPERSEDED when a newer patch on the same benchmark schema overlaps its address set.
 */
import type { Attestation, Challenge, LedgerRecord, PatchAnchor, PatchStatus, Settlement } from './types.js';
import type { SupersedeRecord } from './ledger.js';

export interface CatalogEntry {
  anchor: PatchAnchor & { entry_id?: string; node_id?: string; gateway_url?: string };
  status: PatchStatus;
  attestations: Attestation[];
  passed: number;
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
      anchor: rec.body, status: 'ANNOUNCED', attestations: [], passed: 0, quorum, quorum_ok: false,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [],
      record_hash: rec.hash,
    });
  }
  for (const d of localDrafts) {
    if (!byId.has(d.id)) byId.set(d.id, {
      anchor: d, status: 'DRAFT', attestations: [], passed: 0, quorum, quorum_ok: false,
      settlements: [], downloads: 0, revenue: '0', challenges: [], superseded_by: [], supersedes: [], children: [], record_hash: '',
    });
  }
  for (const rec of attestations) {
    const e = byId.get(rec.body.patch_id);
    if (!e) continue;
    if (e.attestations.some((a) => a.verifier === rec.body.verifier)) continue;
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
    e.passed = e.attestations.filter((a) => a.passed).length;
    e.quorum_ok = e.passed >= quorum;
    e.downloads = e.settlements.length;
    e.revenue = e.settlements.reduce((s, x) => s + Number(x.amount || 0), 0).toFixed(6).replace(/\.?0+$/, '') || '0';
    if (e.status === 'DRAFT') continue;
    const failed = e.attestations.filter((a) => !a.passed).length;
    const latestChallenge = e.challenges.sort((a, b) => b.created_at - a.created_at)[0];
    if (e.quorum_ok) {
      e.status = 'LISTED';
      e.listed_at = Math.max(...e.attestations.filter((a) => a.passed).map((a) => a.created_at));
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

/** Royalty split along lineage: `share` of the amount is divided among unique ancestor authors (청구항 11, 16-3). */
export function royaltySplit(
  entry: CatalogEntry, all: Map<string, CatalogEntry>, amount: number, share: number,
): Record<string, string> {
  const ancestors: string[] = [];
  const walk = (id: string, depth: number) => {
    if (depth > 16) return;
    const e = all.get(id);
    if (!e) return;
    for (const p of e.anchor.parents) {
      const pe = all.get(p);
      if (pe && !ancestors.includes(pe.anchor.author)) ancestors.push(pe.anchor.author);
      walk(p, depth + 1);
    }
  };
  walk(entry.anchor.id, 0);
  const out: Record<string, string> = {};
  const fmt = (n: number) => n.toFixed(6).replace(/\.?0+$/, '');
  if (!ancestors.length) { out[entry.anchor.author] = fmt(amount); return out; }
  const pool = amount * share;
  const each = pool / ancestors.length;
  out[entry.anchor.author] = fmt(amount - pool);
  for (const a of ancestors) out[a] = fmt((Number(out[a] ?? 0)) + each);
  return out;
}
