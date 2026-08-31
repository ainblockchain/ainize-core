/**
 * AinLedger — AI Network blockchain backend built on @ainblockchain/ain-js.
 *
 * Mapping (see 10-출원명세서 §4 원장·거래부, 청구항 11-1..11-3, 19):
 *  - anchor   → knowledge.explore(): gated exploration (price + gateway_url = this node's x402 endpoint),
 *               content = patch manifest JSON → content_hash on-chain; parentEntry → `extends` graph edge
 *               (lineage / royalty), relatedEntries → `related` edges (branch siblings, conflicts).
 *               Public patch metadata mirrors to /apps/knowledge/market/patches/$id (author-only write rule).
 *  - attest   → /apps/knowledge/market/attestations/$id/$verifier   (rule: auth.addr === $verifier)
 *  - settle   → /apps/knowledge/market/settlements/$id/$tx           (rule: buyer or seller)
 *               + ain-js access receipt (/apps/knowledge/access/$buyer/…) written by the buyer.
 *  - challenge→ /apps/knowledge/market/challenges/$id/$challenger
 *  - branch   → /apps/knowledge/market/branches/$name                 (rule: owner)
 *  - node     → /apps/knowledge/market/nodes/$addr                    (rule: auth.addr === $addr)
 *  - supersede→ /apps/knowledge/market/supersedes/$old/$new
 *  - subscribe→ /apps/knowledge/market/subscriptions/$node/$branch
 *
 * Permissions are enforced by the chain's rule engine, not by this process. Every write is a
 * signed transaction from the node identity, so records carry the chain tx hash as `sig`.
 */
import { createRequire } from 'node:module';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { Ledger, LedgerEvents, LedgerInfo, RecordBody, SubscriptionRecord, SupersedeRecord } from './ledger.js';
import type {
  Attestation, BranchInfo, Challenge, LedgerRecord, PatchAnchor, PeerInfo, RecordKind, Settlement,
} from './types.js';
import type { Identity } from './identity.js';

const require = createRequire(import.meta.url);
// ain-js is CommonJS with `exports.default`
const AinCtor = (require('@ainblockchain/ain-js') as { default: any }).default;

export interface AinLedgerOptions {
  providerUrl: string;
  eventHandlerUrl?: string | null;
  chainId: number;
  appName?: string;          // ain-js hard-codes '/apps/knowledge'
  gasPrice?: number;
}

const APP = '/apps/knowledge';
const MARKET = `${APP}/market`;

function keyOf(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export class AinLedger implements Ledger {
  readonly kind = 'ain' as const;
  readonly ain: any;
  private cache: LedgerRecord[] = [];
  private lastPoll = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly opts: AinLedgerOptions,
    private readonly identity: Identity,
    private readonly events: LedgerEvents = {},
    private readonly pollMs = 8000,
  ) {
    this.ain = new AinCtor(opts.providerUrl, opts.eventHandlerUrl ?? null, opts.chainId);
    this.ain.wallet.addAndSetDefaultAccount(identity.privateKey);
  }

  get address(): string { return this.identity.address; }

  async init(): Promise<void> {
    await this.refresh();
    this.pollTimer = setInterval(() => { this.refresh().catch(() => undefined); }, this.pollMs);
    this.pollTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async info(): Promise<LedgerInfo> {
    let height: number | undefined;
    try { height = Number(await this.ain.getLastBlockNumber()); } catch { height = undefined; }
    return {
      kind: 'ain', network: `ain:${this.opts.chainId === 0 ? 'local' : 'mainnet'}`, provider: this.opts.providerUrl,
      app: APP, height, records: this.cache.length, valid: true,
    };
  }

  // ---------------------------------------------------------------- chain helpers
  private tx(extra: Record<string, unknown> = {}) {
    return { nonce: -1, gas_price: this.opts.gasPrice ?? 0, ...extra };
  }

  private async set(ref: string, value: unknown): Promise<string> {
    const res = await this.ain.db.ref(ref).setValue({ value, ...this.tx() });
    return AinLedger.assertOk(res, ref);
  }

  private static assertOk(res: any, what: string): string {
    const code = res?.result?.code ?? res?.result?.result_list?.['0']?.code;
    if (res?.result?.message && code !== 0 && code !== undefined) {
      throw new Error(`AIN write rejected (${what}): ${res.result.message}`);
    }
    if (res?.result?.code && res.result.code !== 0) throw new Error(`AIN write rejected (${what}): code ${res.result.code}`);
    return res?.tx_hash ?? '';
  }

  async getValue(ref: string): Promise<any> {
    return this.ain.db.ref(ref).getValue();
  }

  async balance(address = this.identity.address): Promise<number> {
    return this.ain.wallet.getBalance(address);
  }

  async transfer(to: string, value: number): Promise<{ tx_hash: string; key: string }> {
    const res = await this.ain.wallet.transfer({ to, value, nonce: -1 });
    const hash = AinLedger.assertOk(res, `transfer→${to}`);
    return { tx_hash: hash, key: '' };
  }

  /** Verify an AIN transfer by tx hash: returns {from,to,value} if finalized/executed. */
  async verifyTransfer(txHash: string): Promise<{ from: string; to: string; value: number; key: string } | null> {
    const info = await this.ain.getTransactionByHash(txHash);
    const op = info?.transaction?.tx_body?.operation;
    if (!op || op.type !== 'SET_VALUE') return null;
    const m = /^\/transfer\/([^/]+)\/([^/]+)\/([^/]+)\/value$/.exec(op.ref ?? '');
    if (!m) return null;
    if (!(info.is_executed || info.is_finalized)) return null;
    if (info.exec_result?.code && info.exec_result.code !== 0) return null;
    return { from: m[1], to: m[2], key: m[3], value: Number(op.value) };
  }

  /**
   * One-time app setup (run by the first node = app admin): ain-js setupApp() + market rules.
   * Idempotent: if the app exists and we are not admin, only checks readability.
   */
  async setupApp(): Promise<{ created: boolean; tx?: string; admin?: string }> {
    const cfg = await this.ain.db.ref('/manage_app/knowledge/config').getValue();
    if (!cfg) {
      const res = await this.ain.knowledge.setupApp({ nonce: -1 });
      const tx = AinLedger.assertOk(res, 'setupApp');
      await this.setMarketRules();
      return { created: true, tx, admin: this.identity.address };
    }
    const admin = Object.keys(cfg.admin ?? {})[0];
    if (cfg.admin?.[this.identity.address]) {
      await this.setMarketRules().catch(() => undefined);
    }
    return { created: false, admin };
  }

  private async setMarketRules(): Promise<void> {
    const rules: [string, string][] = [
      [`${MARKET}/patches/$patch_id`, "auth.addr === newData.author && (data === null || data.author === auth.addr)"],
      [`${MARKET}/attestations/$patch_id/$verifier`, 'auth.addr === $verifier'],
      [`${MARKET}/settlements/$patch_id/$tx_hash`, 'auth.addr === newData.seller || auth.addr === newData.buyer'],
      [`${MARKET}/challenges/$patch_id/$challenger`, 'auth.addr === $challenger'],
      [`${MARKET}/branches/$branch`, "auth.addr === newData.owner && (data === null || data.owner === auth.addr)"],
      [`${MARKET}/nodes/$addr`, 'auth.addr === $addr'],
      [`${MARKET}/supersedes/$old_id/$new_id`, "auth.addr !== ''"],
      [`${MARKET}/subscriptions/$node/$branch`, 'auth.addr === $node'],
    ];
    const op_list = rules.map(([ref, write]) => ({ type: 'SET_RULE', ref, value: { '.rule': { write } } }));
    const res = await this.ain.sendTransaction({ operation: { type: 'SET', op_list }, ...this.tx() });
    AinLedger.assertOk(res, 'market rules');
  }

  // ---------------------------------------------------------------- Ledger API
  async append<T extends RecordBody>(kind: RecordKind, body: T): Promise<LedgerRecord<T>> {
    const ts = Date.now();
    let txHash = '';
    let ref = '';
    switch (kind) {
      case 'anchor': {
        const a = body as unknown as PatchAnchor;
        ref = `${MARKET}/patches/${a.id}`;
        // 1) public metadata mirror (rule: author only)
        txHash = await this.set(ref, a);
        // 2) knowledge graph entry with lineage edges (parentEntry = first parent, others related)
        const parentAnchors = await this.anchors();
        const findEntry = (pid: string) => parentAnchors.find((r) => r.body.id === pid)?.body as (PatchAnchor & { entry_id?: string }) | undefined;
        const parentEntry = a.parents[0] ? findEntry(a.parents[0]) : undefined;
        const related = a.parents.slice(1).map(findEntry).filter(Boolean) as (PatchAnchor & { entry_id?: string })[];
        const manifest = canonicalJson({ id: a.id, patch_sha256: a.patch_sha256, model: a.model, benchmark_hash: a.benchmark_hash, rows: a.rows, size_bytes: a.size_bytes });
        const gateway = (a as PatchAnchor & { gateway_url?: string }).gateway_url ?? '';
        const ex = await this.ain.knowledge.explore({
          topicPath: a.topic_path || 'patches',
          title: a.name,
          content: manifest,
          summary: a.description.slice(0, 500),
          depth: Math.min(5, Math.max(1, a.parents.length + 1)),
          tags: `patch,${a.model.id_M},${a.benchmark.schema}${a.branch ? ',' + a.branch : ''}`,
          price: a.price,
          gatewayUrl: gateway || null,
          parentEntry: parentEntry?.entry_id ? { ownerAddress: parentEntry.author, topicPath: parentEntry.topic_path, entryId: parentEntry.entry_id } : null,
          relatedEntries: related.filter((r) => r.entry_id).map((r) => ({ ownerAddress: r.author, topicPath: r.topic_path, entryId: r.entry_id!, type: 'related' as const })),
        }, { nonce: -1 });
        // 3) remember entry id on the mirror so buyers can `knowledge.access()` it
        await this.set(`${ref}/entry_id`, ex.entryId);
        await this.set(`${ref}/node_id`, ex.nodeId);
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).entry_id = ex.entryId;
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).node_id = ex.nodeId;
        break;
      }
      case 'attest': {
        const at = body as unknown as Attestation;
        ref = `${MARKET}/attestations/${at.patch_id}/${this.identity.address}`;
        txHash = await this.set(ref, at);
        break;
      }
      case 'settle': {
        const s = body as unknown as Settlement;
        ref = `${MARKET}/settlements/${s.patch_id}/${keyOf(s.tx_hash || String(ts))}`;
        txHash = await this.set(ref, s);
        break;
      }
      case 'challenge': {
        const c = body as unknown as Challenge;
        ref = `${MARKET}/challenges/${c.patch_id}/${this.identity.address}`;
        txHash = await this.set(ref, c);
        break;
      }
      case 'branch': {
        const b = body as unknown as BranchInfo;
        ref = `${MARKET}/branches/${keyOf(b.name)}`;
        txHash = await this.set(ref, b);
        break;
      }
      case 'node': {
        ref = `${MARKET}/nodes/${this.identity.address}`;
        txHash = await this.set(ref, body);
        break;
      }
      case 'supersede': {
        const s = body as unknown as SupersedeRecord;
        ref = `${MARKET}/supersedes/${s.old_patch_id}/${s.new_patch_id}`;
        txHash = await this.set(ref, s);
        break;
      }
      case 'subscribe': {
        const s = body as unknown as SubscriptionRecord;
        ref = `${MARKET}/subscriptions/${this.identity.address}/${keyOf(s.branch)}`;
        txHash = await this.set(ref, s);
        break;
      }
    }
    const rec: LedgerRecord<T> = {
      hash: sha256Hex(`${ref}:${txHash}`), kind, body, author: this.identity.address, ts, parents: [], sig: txHash,
    };
    this.cache.push(rec);
    this.events.onRecord?.(rec);
    return rec;
  }

  /** Records are authoritative on-chain; peers don't push them to us. */
  async ingest(): Promise<boolean> { return false; }

  /** Re-read the market subtree and rebuild the record cache. */
  async refresh(): Promise<void> {
    const market = (await this.ain.db.ref(MARKET).getValue()) ?? {};
    const recs: LedgerRecord[] = [];
    const push = (kind: RecordKind, ref: string, body: any, author: string, ts: number) =>
      recs.push({ hash: sha256Hex(`${ref}:${canonicalJson(body)}`), kind, body, author, ts, parents: [], sig: '' });
    for (const [id, a] of Object.entries<any>(market.patches ?? {})) push('anchor', `${MARKET}/patches/${id}`, a, a.author, a.created_at ?? 0);
    for (const [id, m] of Object.entries<any>(market.attestations ?? {}))
      for (const [v, at] of Object.entries<any>(m)) push('attest', `${MARKET}/attestations/${id}/${v}`, at, v, at.created_at ?? 0);
    for (const [id, m] of Object.entries<any>(market.settlements ?? {}))
      for (const [k, s] of Object.entries<any>(m)) push('settle', `${MARKET}/settlements/${id}/${k}`, s, s.seller, s.created_at ?? 0);
    for (const [id, m] of Object.entries<any>(market.challenges ?? {}))
      for (const [c, ch] of Object.entries<any>(m)) push('challenge', `${MARKET}/challenges/${id}/${c}`, ch, c, ch.created_at ?? 0);
    for (const [k, b] of Object.entries<any>(market.branches ?? {})) push('branch', `${MARKET}/branches/${k}`, b, b.owner, b.created_at ?? 0);
    for (const [addr, n] of Object.entries<any>(market.nodes ?? {})) push('node', `${MARKET}/nodes/${addr}`, n, addr, n.last_seen ?? 0);
    for (const [o, m] of Object.entries<any>(market.supersedes ?? {}))
      for (const [nw, s] of Object.entries<any>(m)) push('supersede', `${MARKET}/supersedes/${o}/${nw}`, s, '', 0);
    for (const [node, m] of Object.entries<any>(market.subscriptions ?? {}))
      for (const [b, s] of Object.entries<any>(m)) push('subscribe', `${MARKET}/subscriptions/${node}/${b}`, s, node, 0);
    recs.sort((x, y) => x.ts - y.ts);
    const known = new Set(this.cache.map((r) => r.hash));
    for (const r of recs) if (!known.has(r.hash)) this.events.onRecord?.(r);
    this.cache = recs;
    this.lastPoll = Date.now();
  }

  async list(opts: { since?: number; kind?: RecordKind; limit?: number } = {}): Promise<LedgerRecord[]> {
    if (Date.now() - this.lastPoll > this.pollMs) await this.refresh().catch(() => undefined);
    let out = this.cache;
    if (opts.kind) out = out.filter((r) => r.kind === opts.kind);
    if (opts.since !== undefined) out = out.filter((r) => r.ts > opts.since!);
    if (opts.limit) out = out.slice(-opts.limit);
    return out;
  }
  async get(hash: string) { return this.cache.find((r) => r.hash === hash) ?? null; }
  async hashes(since = 0) { return (await this.list({ since })).map((r) => r.hash); }

  private async byKind<T>(kind: RecordKind, f?: (b: T) => boolean): Promise<LedgerRecord<T>[]> {
    const recs = (await this.list({ kind })) as LedgerRecord<T>[];
    return f ? recs.filter((r) => f(r.body)) : recs;
  }
  anchors() { return this.byKind<PatchAnchor>('anchor'); }
  attestations(patchId?: string) { return this.byKind<Attestation>('attest', patchId ? (b) => b.patch_id === patchId : undefined); }
  settlements(patchId?: string) { return this.byKind<Settlement>('settle', patchId ? (b) => b.patch_id === patchId : undefined); }
  challenges(patchId?: string) { return this.byKind<Challenge>('challenge', patchId ? (b) => b.patch_id === patchId : undefined); }
  branches() { return this.byKind<BranchInfo>('branch'); }
  nodes() { return this.byKind<PeerInfo>('node'); }
  supersedes() { return this.byKind<SupersedeRecord>('supersede'); }
  subscriptions() { return this.byKind<SubscriptionRecord>('subscribe'); }

  async verify() {
    // Integrity is guaranteed by consensus; we report reachability + rule presence.
    const errors: string[] = [];
    try {
      const rule = await this.ain.db.ref(`${MARKET}/attestations`).getRule();
      if (!rule) errors.push('market rules not set (run `ngram chain setup`)');
    } catch (e) { errors.push(`chain unreachable: ${(e as Error).message}`); }
    return { valid: errors.length === 0, checked: this.cache.length, errors };
  }

  /** Knowledge-graph view (nodes/edges) straight from ain-js. */
  async graph(): Promise<{ nodes: Record<string, any>; edges: Record<string, Record<string, any>> }> {
    return this.ain.knowledge.getGraph();
  }

  /** Access receipts of a buyer (ain-js). */
  async receipts(buyer: string): Promise<Record<string, any> | null> {
    return this.ain.knowledge.getAccessReceipts(buyer);
  }
}
