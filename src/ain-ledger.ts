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
 *               + ain-js access receipt (/apps/knowledge/access/$buyer/…) written by the buyer after download (recordAccess).
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

/** Genesis account of the 1-node local dev chain (blockchain-configs/1-node) — public test key, dev only. */
export const LOCAL_GENESIS = {
  address: '0x00ADEc28B6a845a085e03591bE7550dd68673C1C',
  privateKey: 'b22c95ffc4a5c096f7d7d0487ba963ce6ac945bdc91c79b64ce209de289bec96',
};

/** Fund an address from the local dev chain's genesis account. Refuses non-local providers. */
export async function fundFromGenesis(providerUrl: string, to: string, amount: number): Promise<{ tx_hash: string; balance: number }> {
  const u = new URL(providerUrl);
  if (!['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(u.hostname)) throw new Error('fundFromGenesis only works against a local dev chain');
  const ain = new AinCtor(providerUrl, null, 0);
  ain.wallet.addAndSetDefaultAccount(LOCAL_GENESIS.privateKey);
  const res = await ain.wallet.transfer({ to, value: amount, nonce: -1 });
  if (!res?.tx_hash) throw new Error(`transfer failed: ${JSON.stringify(res).slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 1500));
  return { tx_hash: res.tx_hash, balance: await ain.wallet.getBalance(to) };
}

/** Quick reachability probe for an AIN node. */
export async function ainReachable(providerUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const r = await fetch(`${providerUrl.replace(/\/$/, '')}/node_status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { result?: { health?: boolean; state?: string } };
    return !!j.result?.health && j.result?.state === 'SERVING';
  } catch { return false; }
}

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
  return path.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * AIN state values cannot hold JS arrays (only objects/primitives) and empty objects are pruned.
 * toAin(): arrays → {"0":…,"1":…}; empty arrays/objects → null (key omitted); undefined → omitted.
 * fromAin(): objects whose keys are exactly 0..n-1 → arrays. Our record schemas never use such keys otherwise.
 */
export function toAin(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    const o: Record<string, unknown> = {};
    v.forEach((x, i) => { const y = toAin(x); if (y !== undefined) o[String(i)] = y; });
    return Object.keys(o).length ? o : null;
  }
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const y = toAin(x);
      if (y !== undefined && y !== null) o[k] = y;
    }
    return Object.keys(o).length ? o : null;
  }
  return v;
}

export function fromAin(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length && keys.every((k, i) => k === String(i))) return keys.map((k) => fromAin(o[k]));
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = fromAin(o[k]);
  return out;
}

const ARRAY_FIELDS = ['parents', 'parent_authors', 'format', 'samples', 'addr_sketch', 'roles', 'branches', 'blobs', 'patch_ids'];
/** Restore array fields that were omitted because they were empty. */
function withEmptyArrays<T>(body: T): T {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;
  for (const f of ARRAY_FIELDS) if (f in b === false && (f !== 'samples' && f !== 'format')) { /* only top-level */ }
  if (Array.isArray(b.parents) === false && 'author' in b && 'patch_sha256' in b) { b.parents = b.parents ?? []; b.parent_authors = b.parent_authors ?? []; }
  if ('benchmark' in b && b.benchmark && typeof b.benchmark === 'object') { const bm = b.benchmark as Record<string, unknown>; bm.format = bm.format ?? []; bm.samples = bm.samples ?? []; }
  if ('roles' in b || 'endpoint' in b) { b.roles = b.roles ?? []; b.branches = b.branches ?? []; b.blobs = b.blobs ?? []; }
  if ('context' in b && 'owner' in b) { b.patch_ids = b.patch_ids ?? []; b.context = b.context ?? {}; }
  if ('action' in b && 'branch' in b) { b.patch_ids = b.patch_ids ?? []; }
  if ('royalty' in b) { b.royalty = b.royalty ?? {}; }
  if ('score' in b) { b.score = b.score ?? {}; }
  return body;
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
    const encoded = toAin(value);
    const res = await this.ain.db.ref(ref).setValue({ value: encoded, ...this.tx() });
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
    return fromAin(await this.ain.db.ref(ref).getValue());
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

  /** Total AIN staked on the knowledge app (state/bandwidth budget is proportional to app stake). */
  async appStake(): Promise<number> {
    const v = await this.ain.db.ref('/staking/knowledge/balance_total').getValue();
    return Number(v ?? 0);
  }

  /** Stake AIN on the knowledge app from this identity (apps on the free tier are capped at ~100 KB of state). */
  async stakeApp(amount: number): Promise<string> {
    const ref = `/staking/knowledge/${this.identity.address}/0/stake/${Date.now()}/value`;
    const res = await this.ain.db.ref(ref).setValue({ value: amount, ...this.tx() });
    return AinLedger.assertOk(res, 'stake knowledge app');
  }

  /**
   * One-time app setup (run by the first node = app admin): ain-js setupApp() + market rules + app stake.
   * Idempotent: if the app exists and we are not admin, only the stake top-up (if we can afford it) is attempted.
   */
  async setupApp(opts: { stake?: number } = {}): Promise<{ created: boolean; tx?: string; admin?: string; staked?: number }> {
    const cfg = await this.ain.db.ref('/manage_app/knowledge/config').getValue();
    let created = false; let tx: string | undefined; let admin: string | undefined;
    if (!cfg) {
      const res = await this.ain.knowledge.setupApp({ nonce: -1 });
      tx = AinLedger.assertOk(res, 'setupApp');
      await this.setMarketRules();
      created = true; admin = this.identity.address;
    } else {
      admin = Object.keys(cfg.admin ?? {})[0];
      if (cfg.admin?.[this.identity.address]) await this.setMarketRules().catch(() => undefined);
    }
    let staked: number | undefined;
    const want = opts.stake ?? 100;
    try {
      const current = await this.appStake();
      if (current < want) {
        const bal = await this.balance();
        if (bal > want + 10) { await this.stakeApp(want); staked = want; }
      }
    } catch { /* staking is best effort */ }
    return { created, tx, admin, staked };
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
        // 1) knowledge graph entry with lineage edges (parentEntry = first parent, others related)
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
        AinLedger.assertOk(ex.txResult, 'knowledge.explore');
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).entry_id = ex.entryId;
        (a as PatchAnchor & { entry_id?: string; node_id?: string }).node_id = ex.nodeId;
        // 2) public metadata mirror (rule: author only, write-once) — includes the entry id so buyers can knowledge.access() it
        txHash = await this.set(ref, a);
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
        const info = body as unknown as PeerInfo;
        txHash = await this.set(ref, { ...info, blobs: info.blobs.slice(0, 40) });
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
    const market = (fromAin(await this.ain.db.ref(MARKET).getValue()) as any) ?? {};
    const recs: LedgerRecord[] = [];
    const push = (kind: RecordKind, ref: string, rawBody: any, author: string, ts: number) => {
      const body = withEmptyArrays(rawBody);
      recs.push({ hash: sha256Hex(`${ref}:${canonicalJson(body)}`), kind, body, author, ts, parents: [], sig: '' });
    };
    for (const [id, a] of Object.entries<any>(market.patches ?? {})) if (a && typeof a.patch_sha256 === 'string' && a.author) push('anchor', `${MARKET}/patches/${id}`, a, a.author, a.created_at ?? 0);
    for (const [id, m] of Object.entries<any>(market.attestations ?? {}))
      for (const [v, at] of Object.entries<any>(m)) if (at && at.patch_id === id && at.verifier === v && typeof at.passed === 'boolean') push('attest', `${MARKET}/attestations/${id}/${v}`, at, v, at.created_at ?? 0);
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

  /**
   * Buyer-side access receipt, exactly where ain-js `knowledge.access()` / `hasAccess()` look:
   * /apps/knowledge/access/$buyer/{owner}_{topicKey}_{entryId} (write rule: auth.addr === $buyer).
   */
  async recordAccess(anchor: PatchAnchor & { entry_id?: string }, amount: string, currency: string, txHash: string): Promise<string | null> {
    if (!anchor.entry_id) return null;
    const topicKey = (anchor.topic_path || 'patches').replace(/\//g, '|');
    const entryKey = `${anchor.author}_${topicKey}_${anchor.entry_id}`;
    const receipt = { seller: anchor.author, topic_path: anchor.topic_path, entry_id: anchor.entry_id, amount, currency, tx_hash: txHash, accessed_at: Date.now() };
    return this.set(`${APP}/access/${this.identity.address}/${entryKey}`, receipt);
  }

  /** Has `buyer` an on-chain access receipt for this patch (ain-js hasAccess semantics)? */
  async hasAccess(buyer: string, anchor: PatchAnchor & { entry_id?: string }): Promise<boolean> {
    if (!anchor.entry_id) return false;
    const topicKey = (anchor.topic_path || 'patches').replace(/\//g, '|');
    return this.ain.knowledge.hasAccess(buyer, `${anchor.author}_${topicKey}_${anchor.entry_id}`);
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
